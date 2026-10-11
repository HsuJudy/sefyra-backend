// agent: claude-code  2026-10-10
import test from "node:test";
import assert from "node:assert/strict";
import { JobBook } from "../jobs.js";

test("only the owner can read a job, and the owner never sees internals", () => {
  const b = new JobBook();
  const id = b.create("A");
  assert.deepEqual(b.view(id, "A"), { status: "working" });
  assert.equal(b.view(id, "B"), null);
  assert.equal(b.view("nope", "A"), null);
  b.finish(id, { status: "done", result: "hi" });
  assert.deepEqual(b.view(id, "A"), { status: "done", result: "hi" });
});
test("running count is per install", () => {
  const b = new JobBook();
  b.create("A"); b.create("A"); const x = b.create("B");
  assert.equal(b.runningCount("A"), 2);
  assert.equal(b.runningCount("B"), 1);
  b.finish(x, { status: "done", result: "" });
  assert.equal(b.runningCount("B"), 0);
});
test("finished jobs are evicted after the keep time, not before", () => {
  const b = new JobBook({ ttlMs: 1000 });
  const id = b.create("A", 0); b.finish(id, { status: "done", result: "x" }, 0);
  assert.equal(b.sweep(500).removed, 0);
  assert.ok(b.view(id, "A"));
  assert.equal(b.sweep(1500).removed, 1);
  assert.equal(b.view(id, "A"), null);
});
test("a hung job is failed (and reported for refund) so it cannot lock the install", () => {
  const b = new JobBook({ maxWorkingMs: 1000 });
  const id = b.create("A", 0);
  assert.deepEqual(b.sweep(500).timedOut, []);
  assert.deepEqual(b.sweep(1500).timedOut, ["A"]);
  assert.deepEqual(b.view(id, "A"), { status: "error", error: "timed_out" });
  assert.equal(b.runningCount("A"), 0);
});
test("a late result cannot overwrite a job that was already failed or finished", () => {
  const b = new JobBook({ maxWorkingMs: 1000 });
  const id = b.create("A", 0);
  b.sweep(1500);
  assert.equal(b.finish(id, { status: "done", result: "late" }), false);
  assert.equal(b.view(id, "A").status, "error");
  const j = b.create("A"); assert.equal(b.finish(j, { status: "done", result: "1" }), true);
  assert.equal(b.finish(j, { status: "done", result: "2" }), false);
  assert.equal(b.view(j, "A").result, "1");
});
