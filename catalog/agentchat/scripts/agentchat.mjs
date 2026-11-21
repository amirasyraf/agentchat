#!/usr/bin/env node
// agentchat: chat rooms for AI agents on different machines, relayed through ntfy.
// Single file, Node 18+ standard library only.
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, basename } from "node:path";
import { randomBytes, createHash } from "node:crypto";

const DEFAULT_SERVER = "https://ntfy.amirasyraf.dev";
const TOPIC_PREFIX = "agentchat-";
const PRESENCE_SUFFIX = "-presence";
// ntfy topics are at most 64 characters: prefix (10) + room (45) + presence suffix (9).
const ROOM_RE = /^[A-Za-z0-9_-]{1,45}$/;
const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const DEFAULT_TIMEOUT = 100;
const MAX_TIMEOUT = 3600;
const DONE_MARKER = "[DONE]";
const FILE_TAG = "agentchat-file";
const HEARTBEAT_MS = 60_000;
const LISTENING_WINDOW_S = 90;

const EXIT = { ok: 0, runtime: 1, usage: 2, listening: 3, secret: 4 };

const USAGE = `agentchat: chat rooms for AI agents, relayed through ntfy

Usage (all commands accept --as NAME):
  node agentchat.mjs new [room]                     print a new room id (random unless given)
  node agentchat.mjs send <room> <text...>          send a short message
  node agentchat.mjs send <room> --stdin            send stdin as the message (also: -)
  node agentchat.mjs send <room> --file PATH        send a text file's contents as the message
  node agentchat.mjs send <room> --attach PATH [text...]
        upload any file as an attachment; readers see its name and size, not its contents
  node agentchat.mjs wait <room> [--timeout SECONDS]
        print unread messages from others; if there are none, block until one
        arrives or the timeout passes (default ${DEFAULT_TIMEOUT}s, max ${MAX_TIMEOUT}s).
        Only one wait per room and name may run at a time.
  node agentchat.mjs wait <room> --peek             print unread messages without blocking or marking them read
  node agentchat.mjs history <room> [--last N]      print cached messages (all, or the last N)
  node agentchat.mjs fetch <room> <message-id> [--out PATH] [--force]
        save a message's attachment to disk and print its path, size and sha256
  node agentchat.mjs who <room>                     show who is listening and when each name was last seen
  node agentchat.mjs doctor                         check Node, identity, token and server

Options:
  --allow-secrets   send even though the secret guard matched (only for verified false positives)

Exit codes: 0 ok, 1 runtime or server error, 2 usage error, 3 another wait is already
running for this room and name, 4 refused because the message looks like it contains a secret.

Environment:
  AGENTCHAT_NAME          this agent's name (overridden by --as; default: hostname)
  AGENTCHAT_TOKEN         ntfy access token (default: the NTFY= line in the secrets file)
  AGENTCHAT_SECRETS_FILE  file holding the NTFY= line (default: ~/stuff.secrets)
  AGENTCHAT_SERVER        ntfy server URL (default: ${DEFAULT_SERVER})
  AGENTCHAT_STATE_DIR     where read cursors and listener locks are kept (default: ~/.agentchat)
`;

const FLAGS = {
  as: "string",
  timeout: "string",
  file: "string",
  attach: "string",
  out: "string",
  last: "string",
  stdin: "boolean",
  peek: "boolean",
  force: "boolean",
  "allow-secrets": "boolean",
  help: "boolean",
};

class CliError extends Error {
  constructor(message, code = EXIT.runtime) {
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
    if (!(key in FLAGS)) throw new CliError(`unknown option --${key}\n\n${USAGE}`, EXIT.usage);
    if (FLAGS[key] === "boolean") {
      opts[key] = true;
    } else if (eq !== -1) {
      opts[key] = arg.slice(eq + 1);
    } else {
      if (i + 1 >= argv.length) throw new CliError(`--${key} needs a value`, EXIT.usage);
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
    throw new CliError(`invalid name "${name}": use 1-64 letters, digits, ".", "_" or "-"`, EXIT.usage);
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
  if (!room) throw new CliError(`missing room\n\n${USAGE}`, EXIT.usage);
  if (!ROOM_RE.test(room)) {
    throw new CliError(`invalid room "${room}": use 1-45 letters, digits, "_" or "-"`, EXIT.usage);
  }
  return room;
}

function topicPath(room) {
  return `/${TOPIC_PREFIX}${room}`;
}

function presencePath(room) {
  return `${topicPath(room)}${PRESENCE_SUFFIX}`;
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

async function pollTopic(ctx, path, since) {
  const res = await call(ctx, `${path}/json`, { query: { poll: 1, since } });
  return parseEvents(await res.text());
}

function poll(ctx, room, since) {
  return pollTopic(ctx, topicPath(room), since);
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

// Attachments uploaded with --attach, or any non-text attachment, are shown as
// metadata only. Long text messages that ntfy turned into attachments are inlined.
function isFileMessage(msg) {
  if (!msg.attachment) return false;
  if ((msg.tags ?? []).includes(FILE_TAG)) return true;
  return !(msg.attachment.type ?? "text/plain").startsWith("text/");
}

function attachmentHeaders(ctx, url) {
  return new URL(url).origin === new URL(ctx.server).origin ? { Authorization: `Bearer ${ctx.token}` } : {};
}

function formatTime(seconds) {
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

async function messageText(ctx, room, msg) {
  if (!msg.attachment) return msg.message ?? "";
  const { url, name, size, expires } = msg.attachment;
  if (isFileMessage(msg)) {
    const note = msg.message && msg.message !== `You received a file: ${name}` ? `${msg.message}\n` : "";
    const expiry = expires ? `, expires ${formatTime(expires)}` : "";
    return (
      `${note}[file: ${name}, ${size ?? "?"} bytes, id ${msg.id}${expiry}. ` +
      `Save it without printing it: fetch ${room} ${msg.id} --out PATH]`
    );
  }
  if (expires && expires * 1000 < Date.now()) return `[attachment ${name} has expired on the server]`;
  const res = await fetch(url, { headers: attachmentHeaders(ctx, url) }).catch(() => null);
  if (!res?.ok) return `[could not download attachment ${url}${res ? ` (HTTP ${res.status})` : ""}]`;
  return res.text();
}

async function render(ctx, room, messages) {
  const out = [];
  for (const msg of messages) {
    const from = msg.title || "unknown";
    const self = from === ctx.name ? " (you)" : "";
    out.push(`=== from: ${from}${self} | ${formatTime(msg.time)} | id: ${msg.id} ===`);
    out.push((await messageText(ctx, room, msg)).replace(/\s+$/, ""));
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

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// One listener per room and name: two waits would consume the same messages
// and race on the read cursor. A lock left by a dead process is taken over.
function acquireListenerLock(ctx, room) {
  mkdirSync(ctx.stateDir, { recursive: true });
  const file = join(ctx.stateDir, `${room}.${ctx.name}.lock`);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), { flag: "wx" });
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let holder = null;
      try {
        holder = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        // unreadable or half-written lock: treat as stale
      }
      if (holder?.pid && holder.pid !== process.pid && processAlive(holder.pid)) {
        throw new CliError(
          `another wait for room ${room} as ${ctx.name} is already running (pid ${holder.pid}, ` +
            `started ${holder.started}). Only one listener per name: let it finish or stop it.`,
          EXIT.listening,
        );
      }
      try {
        unlinkSync(file);
      } catch {
        // someone else removed it first
      }
      if (attempt === 2) throw new CliError(`could not acquire listener lock ${file}`, EXIT.listening);
    }
  }
  const release = () => {
    try {
      if (JSON.parse(readFileSync(file, "utf8")).pid === process.pid) unlinkSync(file);
    } catch {
      // already gone
    }
  };
  const onSignal = (signal, code) => () => {
    release();
    process.exit(code);
  };
  const handlers = [
    ["SIGINT", onSignal("SIGINT", 130)],
    ["SIGTERM", onSignal("SIGTERM", 143)],
    ["SIGHUP", onSignal("SIGHUP", 129)],
  ];
  for (const [signal, handler] of handlers) process.on(signal, handler);
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    release();
  };
}

async function heartbeat(ctx, room) {
  await call(ctx, presencePath(room), {
    method: "POST",
    body: "listening",
    query: { title: ctx.name, tags: "agentchat-presence" },
  }).catch(() => {});
}

// Secret guard: refuse to relay anything that looks like a credential. Reports
// which rule matched, never the matched value.
const PLACEHOLDER_RE = /^(<[^>]*>|\*+|x+|\.\.\.|redacted|changeme|example|your[_-].*|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)$/i;
const SECRET_RULES = [
  ["private key block", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
  ["AWS access key id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["sk- API key", /\bsk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{20,}/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ["ntfy access token", /\btk_[A-Za-z0-9]{24,}\b/],
  ["Tavily API key", /\btvly-[A-Za-z0-9_-]{16,}/],
  ["Slack token", /\bxox[abps]-[A-Za-z0-9-]{10,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["PostHog API key", /\bph[cx]_[A-Za-z0-9]{30,}\b/],
  ["JSON web token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["Bearer credential", /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})/, 1],
  [
    "credential assignment",
    /\b[A-Za-z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?([^\s"',;]{16,})/i,
    1,
  ],
];

function findSecrets(ctx, text) {
  const hits = [];
  if (ctx.token && ctx.token.length >= 8 && text.includes(ctx.token)) hits.push("this machine's ntfy token");
  for (const [label, re, group] of SECRET_RULES) {
    const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    for (const match of text.matchAll(global)) {
      const value = group ? match[group] : match[0];
      if (group && PLACEHOLDER_RE.test(value)) continue;
      hits.push(label);
      break;
    }
  }
  return [...new Set(hits)];
}

function guardOutgoing(ctx, text, label, opts) {
  if (opts["allow-secrets"]) return;
  const hits = findSecrets(ctx, text);
  if (!hits.length) return;
  throw new CliError(
    `refusing to send ${label}: it looks like it contains a secret (${hits.join(", ")}). ` +
      `Redact the value (for example KEY=<redacted>) and send again. If this is a verified false ` +
      `positive, re-run with --allow-secrets.`,
    EXIT.secret,
  );
}

function decodeUtf8(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function formatAgo(seconds) {
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  return `${(seconds / 3600).toFixed(1)} h ago`;
}

async function listeningPeers(ctx, room) {
  const beats = await pollTopic(ctx, presencePath(room), `${LISTENING_WINDOW_S}s`);
  return [...new Set(beats.map((beat) => beat.title).filter((name) => name && name !== ctx.name))];
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
  const useStdin = opts.stdin || (words.length === 1 && words[0] === "-");
  if ([opts.file, opts.attach, useStdin].filter(Boolean).length > 1) {
    throw new CliError("give only one of --file, --attach and --stdin", EXIT.usage);
  }
  let result;
  if (opts.attach) {
    let data;
    try {
      data = readFileSync(opts.attach);
    } catch (err) {
      throw new CliError(`cannot read ${opts.attach}: ${err.message}`);
    }
    const name = basename(opts.attach);
    const note = words.join(" ").trim();
    const asText = decodeUtf8(data);
    if (asText !== null) guardOutgoing(ctx, asText, `attachment ${name}`, opts);
    if (note) guardOutgoing(ctx, note, "the message", opts);
    const res = await call(ctx, topicPath(room), {
      method: "PUT",
      body: data,
      query: { title: ctx.name, tags: `agentchat,${FILE_TAG}`, filename: name, message: note || `file ${name}` },
    });
    result = await res.json();
    print(`sent file ${name} (${data.length} bytes) to room ${room} as ${ctx.name} (id: ${result.id})`);
  } else {
    let text;
    if (opts.file) {
      if (words.length) throw new CliError("give either --file or message text, not both", EXIT.usage);
      try {
        text = readFileSync(opts.file, "utf8");
      } catch (err) {
        throw new CliError(`cannot read ${opts.file}: ${err.message}`);
      }
    } else if (useStdin) {
      if (opts.stdin && words.length) throw new CliError("give either --stdin or message text, not both", EXIT.usage);
      text = await readStdin();
    } else {
      text = words.join(" ");
    }
    if (!text.trim()) throw new CliError("refusing to send an empty message", EXIT.usage);
    guardOutgoing(ctx, text, "the message", opts);
    const res = await call(ctx, topicPath(room), {
      method: "POST",
      body: text,
      query: { title: ctx.name, tags: "agentchat" },
    });
    result = await res.json();
    const how = result.attachment ? ", stored as an attachment because it is over 4 KB" : "";
    print(`sent ${Buffer.byteLength(text)} bytes to room ${room} as ${ctx.name} (id: ${result.id}${how})`);
  }
  const peers = await listeningPeers(ctx, room).catch(() => null);
  if (peers && !peers.length) {
    print(
      `[agentchat] warning: nobody else is listening in room ${room} right now (no heartbeat in the last ` +
        `${LISTENING_WINDOW_S}s). They will see the message when they next run wait. Check with: who ${room}`,
    );
  }
}

async function collectForeign(ctx, room, since) {
  const pending = await poll(ctx, room, since);
  return {
    since: pending.length ? pending.at(-1).id : since,
    messages: pending.filter((msg) => msg.title !== ctx.name),
  };
}

function reportDone(messages) {
  const done = messages.filter((msg) => (msg.message ?? "").trimStart().startsWith(DONE_MARKER));
  for (const name of new Set(done.map((msg) => msg.title || "the other agent"))) {
    print(
      `[agentchat] ${name} sent ${DONE_MARKER} (nothing more from them). Reply ${DONE_MARKER} if you are also ` +
        `finished; keep listening if your user asked you to stay.`,
    );
  }
}

async function cmdWait(ctx, room, opts) {
  if (opts.peek) {
    const { messages } = await collectForeign(ctx, room, readCursor(ctx, room) ?? "all");
    if (!messages.length) {
      print(`[agentchat] no unread messages in room ${room}.`);
      return;
    }
    print(await render(ctx, room, messages));
    print(`[agentchat] ${messages.length} unread message(s) in room ${room} (peek: still unread).`);
    reportDone(messages);
    return;
  }
  const timeout = opts.timeout === undefined ? DEFAULT_TIMEOUT : Number(opts.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT) {
    throw new CliError(`--timeout must be between 1 and ${MAX_TIMEOUT} seconds`, EXIT.usage);
  }
  const release = acquireListenerLock(ctx, room);
  const beat = setInterval(() => heartbeat(ctx, room), HEARTBEAT_MS);
  try {
    await heartbeat(ctx, room);
    const deadline = Date.now() + timeout * 1000;
    let { since, messages } = await collectForeign(ctx, room, readCursor(ctx, room) ?? "all");

    while (!messages.length) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const result = await streamForForeign(ctx, room, since, remaining);
      if (result.lastId) since = result.lastId;
      messages = result.messages;
      if (messages.length) {
        // Pick up anything else already queued so a burst arrives together.
        const rest = await collectForeign(ctx, room, since);
        since = rest.since;
        messages = messages.concat(rest.messages);
      } else if (!result.timedOut) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(0, deadline - Date.now()))));
      }
    }

    if (since !== "all") writeCursor(ctx, room, since);
    if (!messages.length) {
      print(`[agentchat] no new messages in room ${room} after ${timeout}s. Run wait again to keep listening.`);
      return;
    }
    print(await render(ctx, room, messages));
    print(`[agentchat] ${messages.length} new message(s) in room ${room}.`);
    reportDone(messages);
  } finally {
    clearInterval(beat);
    release();
  }
}

async function cmdHistory(ctx, room, opts) {
  let last;
  if (opts.last !== undefined) {
    last = Number(opts.last);
    if (!Number.isInteger(last) || last <= 0) throw new CliError("--last must be a positive whole number", EXIT.usage);
  }
  let messages = await poll(ctx, room, "all");
  if (!messages.length) {
    print(`[agentchat] room ${room} has no cached messages.`);
    return;
  }
  const total = messages.length;
  if (last) messages = messages.slice(-last);
  print(await render(ctx, room, messages));
  if (messages.length < total) print(`[agentchat] showing the last ${messages.length} of ${total} cached messages.`);
}

async function cmdFetch(ctx, room, id, opts) {
  if (!id) throw new CliError(`fetch needs a message id\n\n${USAGE}`, EXIT.usage);
  const msg = (await poll(ctx, room, "all")).find((event) => event.id === id);
  if (!msg) throw new CliError(`no cached message ${id} in room ${room} (messages expire from the server cache)`);
  if (!msg.attachment) throw new CliError(`message ${id} has no attachment`, EXIT.usage);
  const { url, name, expires } = msg.attachment;
  if (expires && expires * 1000 < Date.now()) throw new CliError(`the attachment ${name} has expired on the server`);
  const out = opts.out || basename(name);
  if (existsSync(out) && !opts.force) throw new CliError(`${out} already exists; use --force to overwrite`, EXIT.usage);
  const res = await fetch(url, { headers: attachmentHeaders(ctx, url) }).catch((err) => {
    throw new CliError(`cannot download ${name}: ${err.cause?.message ?? err.message}`);
  });
  if (!res.ok) throw new CliError(`cannot download ${name}: HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  writeFileSync(out, data);
  const sha256 = createHash("sha256").update(data).digest("hex");
  print(`saved ${name} from ${msg.title || "unknown"} to ${out} (${data.length} bytes, sha256 ${sha256})`);
}

async function cmdWho(ctx, room) {
  const [beats, messages] = await Promise.all([pollTopic(ctx, presencePath(room), "all"), poll(ctx, room, "all")]);
  const seen = new Map();
  const note = (name, time, kind) => {
    if (!name) return;
    const entry = seen.get(name) ?? { beat: 0, message: 0 };
    entry[kind] = Math.max(entry[kind], time);
    seen.set(name, entry);
  };
  for (const beat of beats) note(beat.title, beat.time, "beat");
  for (const msg of messages) note(msg.title, msg.time, "message");
  if (!seen.size) {
    print(`[agentchat] nobody has been seen in room ${room} (the server keeps about 12 hours).`);
    return;
  }
  const now = Date.now() / 1000;
  const lines = [...seen.entries()]
    .sort((a, b) => Math.max(b[1].beat, b[1].message) - Math.max(a[1].beat, a[1].message))
    .map(([name, { beat, message }]) => {
      const self = name === ctx.name ? " (you)" : "";
      const status =
        beat && now - beat <= LISTENING_WINDOW_S
          ? "listening"
          : `not listening, last seen ${formatAgo(now - Math.max(beat, message))}`;
      const lastMessage = message ? `, last message ${formatAgo(now - message)}` : "";
      return `${name}${self}: ${status}${lastMessage}`;
    });
  print(lines.join("\n"));
}

async function cmdDoctor(ctx) {
  let ok = true;
  const lines = [];
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 18) ok = false;
  lines.push(`node:   ${process.version} (${process.execPath})${major < 18 ? "  FAIL: needs Node 18 or newer" : ""}`);
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
  if (!ok) process.exitCode = EXIT.runtime;
}

async function main(argv) {
  const { positional, opts } = parseArgs(argv);
  const [command, ...rest] = positional;
  if (opts.help || !command || command === "help") {
    print(USAGE);
    return;
  }
  const ctx = buildContext(opts);
  const oneRoom = (name) => {
    if (rest.length > 1) throw new CliError(`${name} takes one room\n\n${USAGE}`, EXIT.usage);
    requireToken(ctx);
    return requireRoom(rest[0]);
  };
  switch (command) {
    case "new":
      if (rest.length > 1) throw new CliError(`new takes at most one room name\n\n${USAGE}`, EXIT.usage);
      return cmdNew(ctx, rest[0]);
    case "send":
      requireToken(ctx);
      return cmdSend(ctx, requireRoom(rest[0]), rest.slice(1), opts);
    case "wait":
      return cmdWait(ctx, oneRoom("wait"), opts);
    case "history":
      return cmdHistory(ctx, oneRoom("history"), opts);
    case "who":
      return cmdWho(ctx, oneRoom("who"));
    case "fetch":
      if (rest.length > 2) throw new CliError(`fetch takes a room and a message id\n\n${USAGE}`, EXIT.usage);
      requireToken(ctx);
      return cmdFetch(ctx, requireRoom(rest[0]), rest[1], opts);
    case "doctor":
      return cmdDoctor(ctx);
    default:
      throw new CliError(`unknown command "${command}"\n\n${USAGE}`, EXIT.usage);
  }
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`agentchat: ${err instanceof CliError ? err.message : err.stack}\n`);
  process.exitCode = err instanceof CliError ? err.code : EXIT.runtime;
});
