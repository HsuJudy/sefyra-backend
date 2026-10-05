// agent: claude-code  2026-10-05
// Starts the real server (no Anthropic calls are made: every request here is refused first).
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 3917, base = `http://127.0.0.1:${PORT}`;
let proc, token;
const call = (p, init = {}) => fetch(base + p, { ...init, headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }), ...init.headers } });

before(async () => {
  proc = spawn("node", ["server.js"], { env: { ...process.env, PORT, JWT_SECRET: "test-secret", ANTHROPIC_API_KEY: "sk-ant-test",
    SUBSCRIPTION_PRODUCT_IDS: "sefyra.pro.monthly", DB_PATH: path.join(mkdtempSync(path.join(tmpdir(), "gate-test-")), "db.json") }, stdio: "pipe" });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(base + "/")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  token = (await (await call("/register", { method: "POST" })).json()).token;
});
after(() => proc.kill());

test("unpaid install cannot start dispatch", async () => {
  const r = await call("/api/dispatch", { method: "POST", body: JSON.stringify({ task: "draft captions" }) });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, "subscription_required");
});
test("requires a token", async () => {
  token = undefined; const r = await call("/api/dispatch", { method: "POST", body: "{}" });
  assert.equal(r.status, 401);
});
test("garbage purchase proof is rejected and /me says not subscribed", async () => {
  token = (await (await call("/register", { method: "POST" })).json()).token;
  const bad = await call("/subscription/verify", { method: "POST", body: JSON.stringify({ jws: "not.a.jws" }) });
  assert.equal(bad.status, 400);
  assert.equal((await (await call("/me")).json()).subscribed, false);
});
test("unknown job id is a 404", async () => {
  assert.equal((await call("/api/dispatch/nope")).status, 404);
});
