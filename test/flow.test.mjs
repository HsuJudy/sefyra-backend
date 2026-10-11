// agent: claude-code  2026-10-10
// End to end with NO network: the real server talks to a fake Anthropic API on localhost.
// Subscribers are made by stopping the server, writing them into db.json, and restarting
// (the Apple check itself is covered in apple.test.mjs), so every other rule runs for real.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 3921, base = `http://127.0.0.1:${PORT}`;
const dbFile = path.join(mkdtempSync(path.join(tmpdir(), "flow-test-")), "db.json");
let fake, fakePort, proc;
const calls = []; // what the fake AI received

const msg = (text, stop = "end_turn") => ({ id: "msg_1", type: "message", role: "assistant", model: "fake", content: [{ type: "text", text }], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });

before(async () => {
  fake = http.createServer((req, res) => {
    let body = ""; req.on("data", (d) => (body += d));
    req.on("end", () => {
      const j = JSON.parse(body || "{}"); calls.push(j);
      const user = JSON.stringify(j.messages?.[0]?.content || "");
      const send = (code, obj, delay = 0) => setTimeout(() => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); }, delay);
      if (String(j.system).includes("GTD app is about to hand")) return send(200, msg(JSON.stringify({ projectId: null, restatement: "Draft 3 captions", confidence: "high", question: null })));
      if (user.includes("NEEDSINFO")) return send(200, msg("NEEDS_INFO: which video do you mean?"));
      if (user.includes("BOOM")) return send(400, { type: "error", error: { type: "invalid_request_error", message: "internal detail that must not reach the client" } });
      if (user.includes("SLOW")) return send(200, msg("too late"), 5000);
      if (user.includes("PAUSEFOREVER")) return send(200, msg("", "pause_turn"));
      send(200, msg("Here are 3 captions."));
    });
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  fakePort = fake.address().port;
  await start();
});
after(async () => { await stop(); fake.close(); });

async function start() {
  proc = spawn("node", ["server.js"], { env: { ...process.env, PORT, JWT_SECRET: "test-secret", ANTHROPIC_API_KEY: "sk-ant-fake",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${fakePort}`, DB_PATH: dbFile, SUBSCRIPTION_PRODUCT_IDS: "p",
    DISPATCH_MONTHLY_QUOTA: "3", DISPATCH_TIMEOUT_MS: "1500", DISPATCH_MAX_CONTINUATIONS: "3" }, stdio: "pipe" });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + "/")).ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("server did not start");
}
async function stop() { if (!proc) return; const p = proc; proc = null; await new Promise((r) => { p.on("exit", r); p.kill("SIGTERM"); }); }

const call = (token, p, init = {}) => fetch(base + p, { ...init, headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }), ...init.headers } });
const json = async (r) => r.json();
const idOf = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).id;
const register = async () => (await json(await call(null, "/register", { method: "POST" }))).token;
const dispatch = (t, task, project) => call(t, "/api/dispatch", { method: "POST", body: JSON.stringify({ task, project }) });
const me = async (t) => json(await call(t, "/me"));
async function settle(t, jobId) { for (let i = 0; i < 80; i++) { const j = await json(await call(t, `/api/dispatch/${jobId}`)); if (j.status !== "working") return j; await new Promise((r) => setTimeout(r, 100)); } throw new Error("job never settled"); }

let A, B, C, D;
test("setup: four installs; A, C and D become subscribers, B does not", async () => {
  [A, B, C, D] = [await register(), await register(), await register(), await register()];
  await stop();
  const db = JSON.parse(readFileSync(dbFile, "utf8"));
  for (const t of [A, C, D]) {
    const id = idOf(t);
    db.installs[id].subscription = { originalTransactionId: `tx-${id}`, productId: "p", expiresAt: Date.now() + 1e9, environment: "Production" };
    db.subs[`tx-${id}`] = id;
  }
  writeFileSync(dbFile, JSON.stringify(db));
  await start();
  assert.equal((await me(A)).subscribed, true);
  assert.equal((await me(B)).subscribed, false);
});

test("a subscriber's task runs and returns a result; only the owner can read it", async () => {
  const r = await dispatch(A, "draft captions for the launch", { id: "p1", outcome: "Launch Sefyra 1.1", steps: ["Fix Railway"] });
  assert.equal(r.status, 200);
  const { jobId, remaining } = await json(r);
  assert.equal(remaining, 2);
  const job = await settle(A, jobId);
  assert.deepEqual(job, { status: "done", result: "Here are 3 captions." });
  assert.equal((await call(B, `/api/dispatch/${jobId}`)).status, 404, "another install must not read it");
  assert.equal((await call(C, `/api/dispatch/${jobId}`)).status, 404, "even another subscriber");
  const sent = JSON.stringify(calls.at(-1).messages[0].content);
  assert.match(sent, /Launch Sefyra 1\.1/, "the project reached the agent");
  assert.equal((await me(A)).dispatchRemaining, 2);
});

test("when the agent only asks a question, the subscriber is not charged", async () => {
  const { jobId } = await json(await dispatch(A, "NEEDSINFO the video thing"));
  const job = await settle(A, jobId);
  assert.equal(job.status, "needs_info");
  assert.equal(job.question, "which video do you mean?");
  assert.equal((await me(A)).dispatchRemaining, 2);
});

test("a failed run is refunded and the client never sees the provider's error text", async () => {
  const { jobId } = await json(await dispatch(A, "BOOM"));
  const job = await settle(A, jobId);
  assert.deepEqual(job, { status: "error", error: "agent_failed" });
  assert.equal((await me(A)).dispatchRemaining, 2);
});

test("a run that exceeds the time limit is stopped, reported as timed_out, and refunded", async () => {
  const t0 = Date.now();
  const { jobId } = await json(await dispatch(A, "SLOW research"));
  const job = await settle(A, jobId);
  assert.deepEqual(job, { status: "error", error: "timed_out" });
  assert.ok(Date.now() - t0 < 4500, "stopped by our limit (1.5s), not by the fake's 5s delay");
  assert.equal((await me(A)).dispatchRemaining, 2);
});

test("a run that never reaches a final answer within the round budget fails and is refunded", async () => {
  const before = calls.length;
  const { jobId } = await json(await dispatch(A, "PAUSEFOREVER"));
  const job = await settle(A, jobId);
  assert.equal(job.status, "error");
  assert.ok(calls.length - before <= 3, `used ${calls.length - before} rounds, budget is 3`);
  assert.equal((await me(A)).dispatchRemaining, 2);
});

test("the monthly allowance stops further runs with a clear error", async () => {
  for (let i = 0; i < 3; i++) await settle(D, (await json(await dispatch(D, `task ${i}`))).jobId);
  assert.equal((await me(D)).dispatchRemaining, 0);
  const r = await dispatch(D, "one more");
  assert.equal(r.status, 429);
  const body = await json(r);
  assert.equal(body.error, "dispatch_limit");
  assert.equal(body.remaining, 0);
  assert.equal((await me(A)).dispatchRemaining, 2, "another subscriber's allowance is separate");
});

test("at most 2 runs at once per install", async () => {
  const a = await dispatch(C, "SLOW one"), b = await dispatch(C, "SLOW two");
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  const third = await dispatch(C, "SLOW three");
  assert.equal(third.status, 429);
  assert.equal((await json(third)).error, "too_many_running");
  assert.equal((await me(C)).dispatchRemaining, 1, "the rejected third run was not charged");
  await settle(C, (await json(a)).jobId); await settle(C, (await json(b)).jobId);
});

test("interpret: subscribers get a restatement; others are refused", async () => {
  const ok = await call(A, "/api/interpret", { method: "POST", body: JSON.stringify({ item: "tiktok thing", candidates: [{ id: "p1", outcome: "Launch", steps: [] }] }) });
  assert.equal(ok.status, 200);
  const body = await json(ok);
  assert.equal(body.restatement, "Draft 3 captions");
  assert.equal(body.projectId, null);
  assert.equal((await call(B, "/api/interpret", { method: "POST", body: JSON.stringify({ item: "x" }) })).status, 403);
});

test("an unsubscribed install is refused before anything is charged", async () => {
  const r = await dispatch(B, "draft captions");
  assert.equal(r.status, 403);
  assert.equal((await me(B)).dispatchUsed, 0);
});
