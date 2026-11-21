// End-to-end tests. Tests marked "live" talk to the real ntfy server and need
// a token (AGENTCHAT_TOKEN or the NTFY= line in ~/stuff.secrets); they use a
// throwaway room that expires from the server cache.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";

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

function run(args, { env = {}, input = "", timeout = 60_000, cwd } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [cli, ...args], { env: { ...baseEnv, ...env }, cwd });
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
  assert.match(got.stdout, /test-a sent \[DONE\] \(nothing more from them\)/);

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

// The tests below use a second room so their message counts don't depend on the ones above.
const room2 = `test-${randomBytes(4).toString("hex")}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("room ids are capped so the presence topic fits ntfy's limit", async () => {
  assert.equal((await run(["new", "r".repeat(45)])).code, 0);
  assert.equal((await run(["new", "r".repeat(46)])).code, 2);
});

test("the secret guard refuses credentials without echoing them", async () => {
  const env = { AGENTCHAT_TOKEN: "tk_guardtesttokenguardtesttoken00" };
  const cases = [
    ["aws key AKIAABCDEFGHIJKLMNOP here", /AWS access key id/],
    ["key sk-ant-abcdefghijklmnopqrstuvwxyz0123", /sk- API key/],
    ["OPENAI_API_KEY=abcdefghijklmnopqrstuvwx", /credential assignment/],
    ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345", /Bearer credential/],
    ["header\n\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n", /private key block on line 3/],
    ["my token is tk_guardtesttokenguardtesttoken00", /this machine's ntfy token/],
    ["TOKEN_URL=https://user:hunter2pass@example.com/api", /credential assignment/],
  ];
  for (const [text, rule] of cases) {
    const res = await run(["send", room2, "--stdin", "--as", "test-a"], { env, input: text });
    assert.equal(res.code, 4, `${text}: ${res.stdout}${res.stderr}`);
    assert.match(res.stderr, rule);
    assert.ok(!res.stderr.includes("ABCDEFGHIJKLMNOP") && !res.stderr.includes("abcdefghijklmnop"), "value leaked");
  }
  const file = join(tmp, "creds.txt");
  writeFileSync(file, "aws_secret_access_key = wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY\n");
  const attach = await run(["send", room2, "--attach", file, "--as", "test-a"], { env });
  assert.equal(attach.code, 4);
  assert.match(attach.stderr, /attachment creds\.txt/);
});

test("placeholders, locations and ordinary text pass the secret guard", live, async () => {
  const text = [
    "OPENAI_API_KEY=<redacted>",
    "TAVILY_API_KEY=${TAVILY_API_KEY}",
    "run the task-runner sk-short",
    "AGENTCHAT_SECRETS_FILE=/home/amirasyraf/stuff.secrets",
    "export GITHUB_TOKEN_PATH=~/.config/gh/hosts.yml",
    "AWS_SECRET_FILE: /etc/ppsplh/wp-app-password.txt",
    "TOKEN_URL=https://login.microsoftonline.com/common/oauth2/token",
    "API_KEY={file:~/.secret-store}",
    "",
  ].join("\n");
  const res = await run(["send", room2, "--stdin", "--as", "test-a"], { input: text });
  assert.equal(res.code, 0, res.stderr);
  const forced = await run(["send", room2, "AKIAABCDEFGHIJKLMNOP is a documented example", "--allow-secrets", "--as", "test-a"]);
  assert.equal(forced.code, 0, forced.stderr);
});

test("send warns when nobody else is listening", live, async () => {
  const res = await run(["send", room2, "anyone there?", "--as", "test-a"]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /no listener seen/);
});

test("only one wait per room and name; the lock is released afterwards", live, async () => {
  await run(["wait", room2, "--as", "test-lock", "--timeout", "1"]);
  const first = run(["wait", room2, "--as", "test-lock", "--timeout", "30"]);
  await sleep(2500);
  const second = await run(["wait", room2, "--as", "test-lock", "--timeout", "2"]);
  assert.equal(second.code, 3, second.stdout + second.stderr);
  assert.match(second.stderr, /already running \(pid \d+/);
  assert.match(second.stderr, /delete the lock: .*\.lock/);

  const who = await run(["who", room2, "--as", "test-a"]);
  assert.match(who.stdout, /^test-lock: listening/m);
  const send = await run(["send", room2, "wake up", "--as", "test-a"]);
  assert.doesNotMatch(send.stdout, /no listener seen/);

  const done = await first;
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stdout, /^wake up$/m);
  const again = await run(["wait", room2, "--as", "test-lock", "--timeout", "1"]);
  assert.equal(again.code, 0, again.stderr);
});

test("a stale lock from a dead process is taken over", live, async () => {
  mkdirSync(join(tmp, "state"), { recursive: true });
  writeFileSync(join(tmp, "state", `${room2}.test-stale.lock`), JSON.stringify({ pid: 2 ** 22 + 12345, started: "x" }));
  const res = await run(["wait", room2, "--as", "test-stale", "--timeout", "1"]);
  assert.equal(res.code, 0, res.stderr);
  assert.ok(!existsSync(join(tmp, "state", `${room2}.test-stale.lock`)), "lock not released");
});

test("peek shows unread messages without marking them read", live, async () => {
  await run(["wait", room2, "--as", "test-peek", "--timeout", "1"]);
  assert.equal((await run(["send", room2, "peek at me", "--as", "test-a"])).code, 0);
  const peek = await run(["wait", room2, "--peek", "--as", "test-peek"]);
  assert.equal(peek.code, 0, peek.stderr);
  assert.match(peek.stdout, /^peek at me$/m);
  assert.match(peek.stdout, /still unread/);
  const read = await run(["wait", room2, "--as", "test-peek", "--timeout", "5"]);
  assert.match(read.stdout, /^peek at me$/m);
  const empty = await run(["wait", room2, "--peek", "--as", "test-peek"]);
  assert.match(empty.stdout, /no unread messages/);
});

test("files are attached, listed without their contents, and fetched to disk", live, async () => {
  await run(["wait", room2, "--as", "test-files", "--timeout", "1"]);
  const data = randomBytes(20_000);
  const file = join(tmp, "blob.bin");
  writeFileSync(file, data);
  const sent = await run(["send", room2, "--attach", file, "here is the blob", "--as", "test-a"]);
  assert.equal(sent.code, 0, sent.stderr);
  const id = sent.stdout.match(/id: (\w+)/)[1];

  const got = await run(["wait", room2, "--as", "test-files", "--timeout", "10"]);
  assert.equal(got.code, 0, got.stderr);
  assert.match(got.stdout, /^here is the blob$/m);
  assert.match(got.stdout, new RegExp(`\\[file: blob\\.bin, 20000 bytes, id ${id}`));
  assert.ok(got.stdout.length < 2000, "file contents were printed");

  const out = join(tmp, "fetched.bin");
  const fetched = await run(["fetch", room2, id, "--out", out, "--as", "test-files"]);
  assert.equal(fetched.code, 0, fetched.stderr);
  assert.ok(readFileSync(out).equals(data), "fetched bytes differ");
  assert.match(fetched.stdout, new RegExp(createHash("sha256").update(data).digest("hex")));
  assert.equal((await run(["fetch", room2, id, "--out", out, "--as", "test-files"])).code, 2);
  assert.equal((await run(["fetch", room2, id, "--out", out, "--force", "--as", "test-files"])).code, 0);
});

test("fetch falls back to a safe name when the attachment name is a path trap", live, async () => {
  const server = process.env.AGENTCHAT_SERVER || "https://ntfy.amirasyraf.dev";
  const url = new URL(`${server}/agentchat-${room2}`);
  url.searchParams.set("filename", "..");
  url.searchParams.set("title", "test-a");
  url.searchParams.set("tags", "agentchat,agentchat-file");
  const put = await fetch(url, { method: "PUT", headers: { Authorization: `Bearer ${token}` }, body: "trap" });
  if (!put.ok) assert.fail(`PUT failed: ${await put.text()}`);
  const id = (await put.json()).id;

  const fetchDir = join(tmp, "fetch-trap");
  mkdirSync(fetchDir, { recursive: true });
  const res = await run(["fetch", room2, id, "--as", "test-files"], { cwd: fetchDir });
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.match(res.stdout, new RegExp(`attachment-${id}`));
  assert.equal(readFileSync(join(fetchDir, `attachment-${id}`), "utf8"), "trap");
});

test("history --last shows only the newest messages", live, async () => {
  const res = await run(["history", room2, "--last", "2", "--as", "test-a"]);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout.match(/=== end ===/g).length, 2);
  assert.match(res.stdout, /showing the last 2 of \d+ cached messages/);
  assert.equal((await run(["history", room2, "--last", "0"], { env: { AGENTCHAT_TOKEN: "x" } })).code, 2);
});
