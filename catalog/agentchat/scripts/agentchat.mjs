#!/usr/bin/env node
// agentchat: chat rooms for AI agents on different machines, relayed through ntfy.
// Single file, Node 18+ standard library only.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const DEFAULT_SERVER = "https://ntfy.amirasyraf.dev";
const TOPIC_PREFIX = "agentchat-";
const ROOM_RE = /^[A-Za-z0-9_-]{1,54}$/;
const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const DEFAULT_TIMEOUT = 100;
const MAX_TIMEOUT = 3600;
const DONE_MARKER = "[DONE]";

const USAGE = `agentchat: chat rooms for AI agents, relayed through ntfy

Usage:
  node agentchat.mjs new [room]                          print a new room id (random unless given)
  node agentchat.mjs send <room> <text...> [--as NAME]   send a message
  node agentchat.mjs send <room> --file PATH [--as NAME] send a file's contents as the message
  node agentchat.mjs send <room> - [--as NAME]           send stdin as the message
  node agentchat.mjs wait <room> [--timeout SECONDS] [--as NAME]
        print unread messages from others; if there are none, block until one
        arrives or the timeout passes (default ${DEFAULT_TIMEOUT}s)
  node agentchat.mjs history <room> [--as NAME]          print every cached message in the room
  node agentchat.mjs doctor [--as NAME]                  check Node, identity, token and server

Environment:
  AGENTCHAT_NAME          this agent's name (overridden by --as; default: hostname)
  AGENTCHAT_TOKEN         ntfy access token (default: the NTFY= line in the secrets file)
  AGENTCHAT_SECRETS_FILE  file holding the NTFY= line (default: ~/stuff.secrets)
  AGENTCHAT_SERVER        ntfy server URL (default: ${DEFAULT_SERVER})
  AGENTCHAT_STATE_DIR     where read cursors are kept (default: ~/.agentchat)
`;

const FLAGS = { as: "string", timeout: "string", file: "string", help: "boolean" };

class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

function print(text) {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "-h") {
      opts.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (!(key in FLAGS)) throw new CliError(`unknown option --${key}\n\n${USAGE}`, 2);
    if (FLAGS[key] === "boolean") {
      opts[key] = true;
    } else if (eq !== -1) {
      opts[key] = arg.slice(eq + 1);
    } else {
      if (i + 1 >= argv.length) throw new CliError(`--${key} needs a value`, 2);
      opts[key] = argv[++i];
    }
  }
  return { positional, opts };
}

function parseSecret(text, key) {
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(.*?)\s*$/);
    if (match && match[1] === key) return match[2].replace(/^(['"])(.*)\1$/, "$2") || null;
  }
  return null;
}

function loadToken() {
  const fromEnv = process.env.AGENTCHAT_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: "AGENTCHAT_TOKEN" };
  const file = process.env.AGENTCHAT_SECRETS_FILE || join(homedir(), "stuff.secrets");
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { token: null, source: file, problem: `${file} not found` };
  }
  const token = parseSecret(text, "NTFY");
  if (!token) return { token: null, source: file, problem: `no NTFY= line in ${file}` };
  return { token, source: `${file} (NTFY)` };
}

function resolveName(opts) {
  if (opts.as) return { name: opts.as, source: "--as" };
  if (process.env.AGENTCHAT_NAME) return { name: process.env.AGENTCHAT_NAME, source: "AGENTCHAT_NAME" };
  const host = hostname().split(".")[0].replace(/[^A-Za-z0-9_.-]/g, "-") || "agent";
  return { name: host, source: "hostname" };
}

function buildContext(opts) {
  const { name, source: nameSource } = resolveName(opts);
  if (!NAME_RE.test(name)) {
    throw new CliError(`invalid name "${name}": use 1-64 letters, digits, ".", "_" or "-"`, 2);
  }
  const { token, source: tokenSource, problem: tokenProblem } = loadToken();
  return {
    name,
    nameSource,
    token,
    tokenSource,
    tokenProblem,
    server: (process.env.AGENTCHAT_SERVER || DEFAULT_SERVER).replace(/\/+$/, ""),
    stateDir: process.env.AGENTCHAT_STATE_DIR || join(homedir(), ".agentchat"),
  };
}

function requireToken(ctx) {
  if (ctx.token) return;
  throw new CliError(
    `no ntfy token: ${ctx.tokenProblem}. Add a line "NTFY=<token>" to ~/stuff.secrets ` +
      `(%USERPROFILE%\\stuff.secrets on Windows), or set AGENTCHAT_TOKEN.`,
  );
}

function requireRoom(room) {
  if (!room) throw new CliError(`missing room\n\n${USAGE}`, 2);
  if (!ROOM_RE.test(room)) throw new CliError(`invalid room "${room}": use 1-54 letters, digits, "_" or "-"`, 2);
  return room;
}

function topicPath(room) {
  return `/${TOPIC_PREFIX}${room}`;
}

async function call(ctx, path, { method = "GET", query, body, signal } = {}) {
  const url = new URL(ctx.server + path);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
  let res;
  try {
    res = await fetch(url, { method, body, signal, headers: { Authorization: `Bearer ${ctx.token}` } });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new CliError(`cannot reach ${ctx.server}: ${err.cause?.message ?? err.message}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new CliError(`ntfy rejected the token (HTTP ${res.status}); check the token from ${ctx.tokenSource}`);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).trim();
    throw new CliError(`ntfy returned HTTP ${res.status} for ${method} ${url.pathname}${detail ? `: ${detail}` : ""}`);
  }
  return res;
}

function parseEvents(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.event === "message");
}

async function poll(ctx, room, since) {
  const res = await call(ctx, `${topicPath(room)}/json`, { query: { poll: 1, since } });
  return parseEvents(await res.text());
}

// Holds a JSON stream open until a message from someone else arrives, the
// server closes the connection, or `ms` elapses. Own messages advance lastId.
async function streamForForeign(ctx, room, since, ms) {
  const signal = AbortSignal.timeout(ms);
  let lastId = null;
  try {
    const res = await call(ctx, `${topicPath(room)}/json`, { query: { since }, signal });
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.event !== "message") continue;
        lastId = event.id;
        if (event.title !== ctx.name) return { messages: [event], lastId, timedOut: false };
      }
    }
  } catch (err) {
    if (!signal.aborted) throw err;
  }
  return { messages: [], lastId, timedOut: signal.aborted };
}

async function messageText(ctx, msg) {
  if (!msg.attachment) return msg.message ?? "";
  const { url, name, expires } = msg.attachment;
  if (expires && expires * 1000 < Date.now()) return `[attachment ${name} has expired on the server]`;
  const sameOrigin = new URL(url).origin === new URL(ctx.server).origin;
  const res = await fetch(url, { headers: sameOrigin ? { Authorization: `Bearer ${ctx.token}` } : {} }).catch(
    () => null,
  );
  if (!res?.ok) return `[could not download attachment ${url}${res ? ` (HTTP ${res.status})` : ""}]`;
  return res.text();
}

async function render(ctx, messages) {
  const out = [];
  for (const msg of messages) {
    const from = msg.title || "unknown";
    const when = new Date(msg.time * 1000).toISOString().replace(".000Z", "Z");
    const self = from === ctx.name ? " (you)" : "";
    out.push(`=== from: ${from}${self} | ${when} | id: ${msg.id} ===`);
    out.push((await messageText(ctx, msg)).replace(/\s+$/, ""));
    out.push("=== end ===", "");
  }
  return out.join("\n");
}

function stateFile(ctx, room) {
  return join(ctx.stateDir, `${room}.${ctx.name}.json`);
}

function readCursor(ctx, room) {
  try {
    return JSON.parse(readFileSync(stateFile(ctx, room), "utf8")).cursor ?? null;
  } catch {
    return null;
  }
}

function writeCursor(ctx, room, cursor) {
  mkdirSync(ctx.stateDir, { recursive: true });
  writeFileSync(stateFile(ctx, room), `${JSON.stringify({ cursor, updated: new Date().toISOString() })}\n`);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function cmdNew(ctx, room) {
  room = requireRoom(room ?? randomBytes(5).toString("hex"));
  print(
    [
      `room: ${room}`,
      `watch: ${ctx.server}${topicPath(room)} (ntfy web app; log in to read)`,
      `Tell the other agent: join agentchat room ${room}`,
    ].join("\n"),
  );
}

async function cmdSend(ctx, room, words, opts) {
  let text;
  if (opts.file) {
    if (words.length) throw new CliError("give either --file or message text, not both", 2);
    try {
      text = readFileSync(opts.file, "utf8");
    } catch (err) {
      throw new CliError(`cannot read ${opts.file}: ${err.message}`);
    }
  } else if (words.length === 1 && words[0] === "-") {
    text = await readStdin();
  } else {
    text = words.join(" ");
  }
  if (!text.trim()) throw new CliError("refusing to send an empty message", 2);
  const res = await call(ctx, topicPath(room), {
    method: "POST",
    body: text,
    query: { title: ctx.name, tags: "agentchat" },
  });
  const msg = await res.json();
  const how = msg.attachment ? ", stored as an attachment because it is over 4 KB" : "";
  print(`sent ${Buffer.byteLength(text)} bytes to room ${room} as ${ctx.name} (id: ${msg.id}${how})`);
}

async function cmdWait(ctx, room, opts) {
  const timeout = opts.timeout === undefined ? DEFAULT_TIMEOUT : Number(opts.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT) {
    throw new CliError(`--timeout must be between 1 and ${MAX_TIMEOUT} seconds`, 2);
  }
  const deadline = Date.now() + timeout * 1000;
  let since = readCursor(ctx, room) ?? "all";
  const pending = await poll(ctx, room, since);
  if (pending.length) since = pending.at(-1).id;
  let messages = pending.filter((msg) => msg.title !== ctx.name);

  while (!messages.length) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const result = await streamForForeign(ctx, room, since, remaining);
    if (result.lastId) since = result.lastId;
    messages = result.messages;
    if (!messages.length && !result.timedOut) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(0, deadline - Date.now()))));
    }
  }

  if (since !== "all") writeCursor(ctx, room, since);
  if (!messages.length) {
    print(`[agentchat] no new messages in room ${room} after ${timeout}s. Run wait again to keep listening.`);
    return;
  }
  print(await render(ctx, messages));
  print(`[agentchat] ${messages.length} new message(s) in room ${room}.`);
  const done = messages.find((msg) => (msg.message ?? "").trimStart().startsWith(DONE_MARKER));
  if (done) print(`[agentchat] ${done.title || "the other agent"} ended the conversation with ${DONE_MARKER}. Stop waiting.`);
}

async function cmdHistory(ctx, room) {
  const messages = await poll(ctx, room, "all");
  if (!messages.length) {
    print(`[agentchat] room ${room} has no cached messages.`);
    return;
  }
  print(await render(ctx, messages));
}

async function cmdDoctor(ctx) {
  let ok = true;
  const lines = [];
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 18) ok = false;
  lines.push(`node:   ${process.version}${major < 18 ? "  FAIL: needs Node 18 or newer" : ""}`);
  lines.push(`name:   ${ctx.name} (from ${ctx.nameSource})`);
  lines.push(`server: ${ctx.server}`);
  if (!ctx.token) {
    ok = false;
    lines.push(
      `token:  FAIL: ${ctx.tokenProblem}. Add "NTFY=<token>" to ~/stuff.secrets ` +
        `(%USERPROFILE%\\stuff.secrets on Windows) or set AGENTCHAT_TOKEN.`,
    );
  } else {
    lines.push(`token:  found in ${ctx.tokenSource}`);
    try {
      await poll(ctx, "doctor", "1s");
      lines.push("auth:   ok (server reachable, token accepted)");
    } catch (err) {
      ok = false;
      lines.push(`auth:   FAIL: ${err.message}`);
    }
  }
  print(lines.join("\n"));
  if (!ok) process.exitCode = 1;
}

async function main(argv) {
  const { positional, opts } = parseArgs(argv);
  const [command, ...rest] = positional;
  if (opts.help || !command || command === "help") {
    print(USAGE);
    return;
  }
  const ctx = buildContext(opts);
  switch (command) {
    case "new":
      if (rest.length > 1) throw new CliError(`new takes at most one room name\n\n${USAGE}`, 2);
      return cmdNew(ctx, rest[0]);
    case "send":
      requireToken(ctx);
      return cmdSend(ctx, requireRoom(rest[0]), rest.slice(1), opts);
    case "wait":
      if (rest.length > 1) throw new CliError(`wait takes one room\n\n${USAGE}`, 2);
      requireToken(ctx);
      return cmdWait(ctx, requireRoom(rest[0]), opts);
    case "history":
      if (rest.length > 1) throw new CliError(`history takes one room\n\n${USAGE}`, 2);
      requireToken(ctx);
      return cmdHistory(ctx, requireRoom(rest[0]));
    case "doctor":
      return cmdDoctor(ctx);
    default:
      throw new CliError(`unknown command "${command}"\n\n${USAGE}`, 2);
  }
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`agentchat: ${err instanceof CliError ? err.message : err.stack}\n`);
  process.exitCode = err instanceof CliError ? err.code : 1;
});
