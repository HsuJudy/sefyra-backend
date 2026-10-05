// agent: claude-code  2026-10-05
import test from "node:test";
import assert from "node:assert/strict";
import { cleanProject, cleanCandidates, dispatchPrompt, needsInfo, finalizeInterpretation, interpretPrompt } from "../context.js";

const proj = { id: "p1", outcome: "Launch Sefyra 1.1", steps: ["Fix Railway", "Test on phone"] };

test("cleanProject trims, caps and rejects junk", () => {
  assert.equal(cleanProject(null), null);
  assert.equal(cleanProject({ outcome: "   " }), null);
  const c = cleanProject({ id: "x", outcome: "a".repeat(500), steps: Array(20).fill("step  one") });
  assert.equal(c.outcome.length, 200);
  assert.equal(c.steps.length, 8);
  assert.equal(c.steps[0], "step one");
});
test("cleanCandidates keeps at most 5 valid projects", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, outcome: `o${i}`, steps: [] }));
  assert.equal(cleanCandidates([...many, null]).length, 5);
  assert.deepEqual(cleanCandidates("nope"), []);
});
test("a worst-case interpret request still fits the 8kb body cap", () => {
  const worst = Array.from({ length: 5 }, (_, i) => ({ id: "x".repeat(36), outcome: "o".repeat(200), steps: Array(8).fill("s".repeat(120)) }));
  assert.ok(JSON.stringify({ item: "i".repeat(500), candidates: worst }).length < 8 * 1024);
});
test("dispatch prompt carries the project when known and not otherwise", () => {
  assert.equal(dispatchPrompt("tiktok captions", null), "Task: tiktok captions");
  const p = dispatchPrompt("tiktok captions", cleanProject(proj));
  assert.match(p, /Task: tiktok captions/);
  assert.match(p, /Project: Launch Sefyra 1\.1/);
  assert.match(p, /1\. Fix Railway 2\. Test on phone/);
});
test("needsInfo recognises a refusal-to-guess and nothing else", () => {
  assert.equal(needsInfo("NEEDS_INFO: Which video do you mean?"), "Which video do you mean?");
  assert.equal(needsInfo("  NEEDS_INFO:   x"), "x");
  assert.equal(needsInfo("Here are 3 captions…"), null);
  assert.equal(needsInfo("I think NEEDS_INFO: is"), null);
  assert.equal(needsInfo(undefined), null);
});
test("model output is not trusted: unknown project ids dropped, bad confidence demoted, high has no question", () => {
  const cands = [cleanProject(proj)];
  assert.equal(finalizeInterpretation({ projectId: "ghost", restatement: "Draft x", confidence: "high", question: null }, cands).projectId, null);
  assert.equal(finalizeInterpretation({ projectId: "p1", restatement: "Draft x", confidence: "sure!", question: null }, cands).confidence, "low");
  assert.equal(finalizeInterpretation({ projectId: "p1", restatement: "Draft x", confidence: "high", question: "why?" }, cands).question, null);
  const low = finalizeInterpretation({ projectId: "p1", restatement: "Draft x", confidence: "low", question: null }, cands);
  assert.ok(low.question.length > 0, "a not-sure answer must always carry a question");
  assert.equal(low.projectId, "p1");
});
test("interpret prompt lists candidates with ids", () => {
  assert.match(interpretPrompt("tiktok thing", [cleanProject(proj)]), /\[id=p1\] Project: Launch Sefyra 1\.1/);
  assert.match(interpretPrompt("tiktok thing", []), /no projects yet/);
});
