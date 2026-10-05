// agent: claude-code  2026-10-05
// Pure helpers for the "know what the item is about" step: clean what the app sends, build the
// agent's prompt, and validate the model's guess. No network, so it is unit-testable.

const clip = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** { id, outcome, steps[] } from untrusted input, or null. Small on purpose (request body cap is 8kb). */
export function cleanProject(p) {
  if (!p || typeof p !== "object") return null;
  const outcome = clip(p.outcome, 200);
  if (!outcome) return null;
  const steps = Array.isArray(p.steps) ? p.steps.slice(0, 8).map((s) => clip(s, 120)).filter(Boolean) : [];
  return { id: clip(p.id, 64), outcome, steps };
}

export function cleanCandidates(list) {
  return (Array.isArray(list) ? list : []).slice(0, 5).map(cleanProject).filter(Boolean);
}

const projectBlock = (p) => `Project: ${p.outcome}${p.steps.length ? `\nSteps: ${p.steps.map((s, i) => `${i + 1}. ${s}`).join(" ")}` : ""}`;

/** What the agent actually receives: the task plus, when known, the project it belongs to. */
export function dispatchPrompt(task, project) {
  return project ? `Task: ${task}\n\nThe user filed this task under:\n${projectBlock(project)}` : `Task: ${task}`;
}

/** The agent may refuse to guess: a reply starting "NEEDS_INFO:" is a question, not a deliverable. */
export function needsInfo(text) {
  const m = /^\s*NEEDS_INFO:\s*([\s\S]+)/.exec(String(text || ""));
  return m ? m[1].trim() : null;
}

export const INTERPRET_SYSTEM =
  "A GTD app is about to hand a short inbox item to an AI agent that drafts or researches it. " +
  "Before that, you decide what the item means. You get the item and the user's candidate projects (id, outcome, steps). " +
  "1) projectId: the one project the item most plausibly belongs to, or null if none clearly fits. Never force a match. " +
  "2) restatement: one plain sentence, max 25 words, starting with a verb (Draft, Research, List…), saying exactly what the agent will produce. " +
  "3) confidence: 'high' only if the item plus its project clearly determine the deliverable; otherwise 'medium' or 'low'. " +
  "4) question: if confidence is not 'high', ONE short question whose answer would settle it; otherwise null. " +
  "Never invent details that are in neither the item nor the project.";

export const INTERPRET_SCHEMA = {
  type: "object",
  properties: {
    projectId: { anyOf: [{ type: "string" }, { type: "null" }] },
    restatement: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    question: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["projectId", "restatement", "confidence", "question"],
  additionalProperties: false,
};

export function interpretPrompt(item, candidates) {
  const list = candidates.length
    ? candidates.map((p) => `[id=${p.id}] ${projectBlock(p)}`).join("\n")
    : "(no projects yet)";
  return `Inbox item: "${item}"\n\nCandidate projects:\n${list}`;
}

/** Never trust the model's shape: a projectId must be one we offered; 'high' carries no question. */
export function finalizeInterpretation(raw, candidates) {
  const ids = new Set(candidates.map((p) => p.id));
  const confidence = ["high", "medium", "low"].includes(raw?.confidence) ? raw.confidence : "low";
  const projectId = ids.has(raw?.projectId) ? raw.projectId : null;
  const question = confidence === "high" ? null : clip(raw?.question, 200) || "Can you say a bit more about what you want?";
  return { projectId, restatement: clip(raw?.restatement, 220), confidence, question };
}
