// End-to-end tests. Tests marked "live" talk to the real ntfy server and need
// a token (AGENTCHAT_TOKEN or the NTFY= line in ~/stuff.secrets); they use a
// throwaway room that expires from the server cache.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "catalog", "agentchat", "scripts", "agentchat.mjs");
const tmp = mkdtempSync(join(tmpdir(), "agentchat-test-"));
const room = `test-${randomBytes(4).toString("hex")}`;

function readToken() {
  if (process.env.AGENTCHAT_TOKEN) return process.env.AGENTCHAT_TOKEN;
  try {
    return readFileSync(join(homedir(), "stuff.secrets"), "utf8").match(/^\s*NTFY\s*=\s*(\S+)/m)?.[1];
  } catch {
    return undefined;
  }
}

const token = readToken();
const live = { skip: token ? false : "no ntfy token available" };
const baseEnv = { ...process.env, AGENTCHAT_STATE_DIR: join(tmp, "state") };
delete baseEnv.AGENTCHAT_NAME;
if (token) baseEnv.AGENTCHAT_TOKEN = token;

function run(args, { env = {}, input = "", timeout = 60_000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [cli, ...args], { env: { ...baseEnv, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    const timer = setTimeout(() => child.kill(), timeout);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    });
    child.stdin.end(input);
  });
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

after(() => rmSync(tmp, { recursive: true, force: true }));

test("catalog index lists exactly the files in each skill directory", () => {
  const index = JSON.parse(readFileSync(join(root, "catalog", "index.json"), "utf8"));
  for (const skill of index.skills) {
    assert.ok(skill.version, `${skill.name} needs a version`);
    const dir = join(root, "catalog", skill.name);
    const files = walk(dir).map((file) => relative(dir, file).split(sep).join("/"));
    assert.deepEqual([...skill.files].sort(), files.sort());
  }
});

test("new prints a random or given room id and rejects bad ones", async () => {
  const random = await run(["new"]);
  assert.equal(random.code, 0, random.stderr);
  assert.match(random.stdout, /^room: [0-9a-f]{10}$/m);
  const named = await run(["new", "my-room"]);
  assert.match(named.stdout, /^room: my-room$/m);
  assert.match(named.stdout, /agentchat-my-room/);
  const bad = await run(["new", "bad room"]);
  assert.equal(bad.code, 2);
});

test("usage errors exit 2", async () => {
  assert.equal((await run(["frobnicate"])).code, 2);
  assert.equal((await run(["wait", room, "--bogus"])).code, 2);
  assert.equal((await run(["wait", room, "--timeout", "0"], { env: { AGENTCHAT_TOKEN: "x" } })).code, 2);
});

test("doctor fails clearly without a token", async () => {
  const res = await run(["doctor"], {
    env: { AGENTCHAT_TOKEN: "", AGENTCHAT_SECRETS_FILE: join(tmp, "missing.secrets") },
  });
  assert.equal(res.code, 1);
  assert.match(res.stdout, /token:  FAIL: .*missing\.secrets not found/);
  const send = await run(["send", room, "hi"], {
    env: { AGENTCHAT_TOKEN: "", AGENTCHAT_SECRETS_FILE: join(tmp, "missing.secrets") },
  });
  assert.equal(send.code, 1);
  assert.match(send.stderr, /no ntfy token/);
});

test("doctor reads a quoted, exported NTFY line from the secrets file", live, async () => {
  const file = join(tmp, "quoted.secrets");
  writeFileSync(file, `OTHER=1\nexport NTFY="${token}"\n`);
  const res = await run(["doctor", "--as", "test-a"], { env: { AGENTCHAT_TOKEN: "", AGENTCHAT_SECRETS_FILE: file } });
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /auth:   ok/);
  assert.match(res.stdout, /name:   test-a \(from --as\)/);
});

test("doctor reports a rejected token", live, async () => {
  const res = await run(["doctor"], { env: { AGENTCHAT_TOKEN: "tk_notarealtokennotarealtoken00" } });
  assert.equal(res.code, 1);
  assert.match(res.stdout, /auth:   FAIL: ntfy rejected the token/);
});

test("a message round-trips and read positions are kept per name", live, async () => {
  const sent = await run(["send", room, "hello", "from", "a", "--as", "test-a"]);
  assert.equal(sent.code, 0, sent.stderr);
  assert.match(sent.stdout, /sent \d+ bytes to room .* as test-a/);

  const got = await run(["wait", room, "--as", "test-b", "--timeout", "10"]);
  assert.equal(got.code, 0, got.stderr);
  assert.match(got.stdout, /=== from: test-a \|/);
  assert.match(got.stdout, /^hello from a$/m);

  const own = await run(["wait", room, "--as", "test-a", "--timeout", "2"]);
  assert.match(own.stdout, /no new messages/);

  const again = await run(["wait", room, "--as", "test-b", "--timeout", "2"]);
  assert.match(again.stdout, /no new messages/);
});

test("wait wakes up when a message arrives", live, async () => {
  const waiting = run(["wait", room, "--as", "test-a", "--timeout", "30"]);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const sent = await run(["send", room, "-", "--as", "test-b"], { input: "line one\nline two ✓\n" });
  assert.equal(sent.code, 0, sent.stderr);
  const got = await waiting;
  assert.equal(got.code, 0, got.stderr);
  assert.match(got.stdout, /=== from: test-b \|/);
  assert.match(got.stdout, /line one\nline two ✓\n=== end ===/);
  assert.ok(got.ms < 15_000, `wait took ${got.ms} ms`);
});

test("a message over 4 KB survives as an attachment", live, async () => {
  const text = `${"héllo wörld ✓ ".repeat(400)}\nEND`;
  const file = join(tmp, "big.md");
  writeFileSync(file, text);
  const sent = await run(["send", room, "--file", file, "--as", "test-a"]);
  assert.equal(sent.code, 0, sent.stderr);
  assert.match(sent.stdout, /attachment/);
  const got = await run(["wait", room, "--as", "test-b", "--timeout", "10"]);
  assert.equal(got.code, 0, got.stderr);
  assert.ok(got.stdout.includes(`${text}\n=== end ===`), "attachment content mismatch");
});

test("[DONE] is announced and history shows everyone", live, async () => {
  const sent = await run(["send", room, "[DONE] all finished", "--as", "test-a"]);
  assert.equal(sent.code, 0, sent.stderr);
  const got = await run(["wait", room, "--as", "test-b", "--timeout", "10"]);
  assert.match(got.stdout, /test-a ended the conversation with \[DONE\]/);

  const history = await run(["history", room, "--as", "test-a"]);
  assert.equal(history.code, 0, history.stderr);
  assert.match(history.stdout, /=== from: test-a \(you\) \|/);
  assert.match(history.stdout, /=== from: test-b \|/);
  assert.equal(history.stdout.match(/=== end ===/g).length, 4);
});

test("empty messages are refused", live, async () => {
  const res = await run(["send", room, "-", "--as", "test-a"], { input: "  \n" });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /empty message/);
});
