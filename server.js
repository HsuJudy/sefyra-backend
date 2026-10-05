import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { Store } from "./store.js";
import { verifyAppleTransaction } from "./apple.js";

const app = express();
app.use(cors({ origin: false }));
app.use(express.json({ limit: "8kb" }));

const SECRET = process.env.JWT_SECRET;
const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

// Model per route: /suggest is a one-line rephrase, /breakdown is the feature people came for.
// At ~110 in / ~80 out per call the price gap is ~0.7c per user-month at the free quota — the
// reasoning is worth more than the pennies on breakdown, and worth nothing on suggest.
const MODEL_SUGGEST = "claude-haiku-4-5";
const MODEL_BREAKDOWN = "claude-sonnet-5";
const MAX_TOKENS = 400; // real outputs are ~80 tokens; this only bounds a runaway

// Agent Dispatch uses a strong model with web search — quality matters and it's personal use.
const MODEL_DISPATCH = "claude-opus-5";
const DISPATCH_MAX_TOKENS = 8000; // room for research + a full ready-to-use draft per turn

// Paid tier (Agent Dispatch). Fails closed: with no product ids configured, nothing verifies.
const APP_BUNDLE_ID = process.env.APP_BUNDLE_ID || "com.judy98122.gtdapp";
const SUBSCRIPTION_PRODUCT_IDS = (process.env.SUBSCRIPTION_PRODUCT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
// App Review and TestFlight purchase in "Sandbox"; set APPLE_ENVIRONMENTS=Production to refuse those.
const APPLE_ENVIRONMENTS = (process.env.APPLE_ENVIRONMENTS || "Production,Sandbox").split(",").map((s) => s.trim());

// Per-install token: the app calls /register once and stores the token in the Keychain.
const registerLimiter = rateLimit({ windowMs: 24 * 60 * 60 * 1000, max: 5 });
app.post("/register", registerLimiter, (_req, res) => {
  const id = randomUUID();
  const token = jwt.sign({ id }, SECRET, { expiresIn: "365d" });
  const inst = Store.ensure(id);
  res.json({ token, code: inst.code }); // code = this install's referral code
});

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : "";
  try { req.install = jwt.verify(t, SECRET); next(); }
  catch { res.status(401).json({ error: "unauthorized" }); }
}

// Per-install rate limit so a leaked token can't drain your key.
const aiLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, keyGenerator: (req) => req.install?.id || req.ip });

// --- Referrals + freemium quota ---

// This install's code, referral count, and remaining monthly AI allowance.
app.get("/me", auth, (req, res) => res.json(Store.status(req.install.id)));

// Friend enters a referrer's code — both get a bigger monthly allowance.
app.post("/referral/claim", auth, (req, res) => {
  const r = Store.claim(req.install.id, req.body.code);
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

// App sends the latest signed transaction (StoreKit 2 `jwsRepresentation`) after a purchase,
// a restore, and on launch (renewals). We verify it against Apple's root and record the expiry.
const subscriptionLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, keyGenerator: (req) => req.install?.id || req.ip });
app.post("/subscription/verify", auth, subscriptionLimiter, (req, res) => {
  const r = verifyAppleTransaction(req.body.jws, {
    bundleId: APP_BUNDLE_ID, productIds: SUBSCRIPTION_PRODUCT_IDS, environments: APPLE_ENVIRONMENTS,
  });
  if (!r.ok) return res.status(400).json({ error: r.reason });
  Store.setSubscription(req.install.id, {
    originalTransactionId: String(r.tx.originalTransactionId), productId: r.tx.productId,
    expiresAt: r.tx.expiresDate, environment: r.tx.environment,
  });
  res.json(Store.status(req.install.id));
});

/**
 * Ask Claude for a value matching `schema`. Structured outputs make the shape a
 * hard guarantee, so the reply is always parseable — no prose to scrape, and the
 * model can't hedge its way into the response body.
 */
async function claudeJSON({ model, system, prompt, schema }) {
  const msg = await anthropic.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: "user", content: prompt }],
    output_config: { format: { type: "json_schema", schema } },
  });
  const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  return JSON.parse(text);
}

const SUGGEST_SCHEMA = {
  type: "object",
  properties: { nextAction: { type: "string" } },
  required: ["nextAction"],
  additionalProperties: false,
};

const BREAKDOWN_SCHEMA = {
  type: "object",
  properties: { steps: { type: "array", items: { type: "string" } } },
  required: ["steps"],
  additionalProperties: false,
};

// Charge one AI credit; return a 402 with the balance when the monthly free tier is spent.
function charge(req, res) {
  const q = Store.tryConsume(req.install.id);
  if (!q.ok) { res.status(402).json({ error: "quota", ...q }); return null; }
  return q;
}

app.post("/api/suggest", auth, aiLimiter, async (req, res) => {
  const q = charge(req, res); if (!q) return;
  try {
    const item = String(req.body.item || "").slice(0, 500);
    const { nextAction } = await claudeJSON({
      model: MODEL_SUGGEST,
      system:
        "You are a next-action engine. Given an inbox item, return the single most concrete, physical, visible next action that moves it forward — an imperative phrase starting with a verb, max 12 words. Always answer; never refuse or add caveats.",
      prompt: `Inbox item: "${item}"`,
      schema: SUGGEST_SCHEMA,
    });
    res.json({ nextAction: String(nextAction || "").trim(), remaining: q.remaining });
  } catch { Store.refund(req.install.id); res.status(500).json({ error: "ai_failed" }); }
});

app.post("/api/breakdown", auth, aiLimiter, async (req, res) => {
  const q = charge(req, res); if (!q) return;
  try {
    const outcome = String(req.body.outcome || "").slice(0, 500);
    const out = await claudeJSON({
      model: MODEL_BREAKDOWN,
      system:
        "You break a project outcome into its next actions. Return 3 to 6 short steps in the order they should happen. Each step is an imperative phrase starting with a verb — something the person could physically start. Always produce steps; if the outcome is vague, make reasonable assumptions rather than asking for detail.",
      prompt: `Project outcome: "${outcome}"`,
      schema: BREAKDOWN_SCHEMA,
    });
    // The schema guarantees an array of strings; cap the count (JSON Schema can't).
    const steps = (out.steps || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 6);
    res.json({ steps, remaining: q.remaining });
  } catch { Store.refund(req.install.id); res.status(500).json({ error: "ai_failed" }); }
});

// --- Agent Dispatch (async: tap a task, an agent researches/drafts the doable part) ---
//
// Agent runs take 20–60s+ (a web-search tool-use loop), longer than an HTTP timeout, so we
// don't hold the request open. POST creates a job and returns a jobId immediately; the agent
// runs in the background; GET polls the job. NOTE: this Map is in-memory — it resets on every
// redeploy (Railway sends SIGTERM). Fine for personal v1; a client polling across a redeploy
// just sees a 404 and can retry.
const jobs = new Map(); // jobId -> { installId, status: "working"|"done"|"error", result?, error? }

const DISPATCH_SYSTEM =
  "You are a task-execution agent inside a GTD app. Given a task, do the doable part — " +
  "research, find, or draft — and return a finished, ready-to-use result the user can act on " +
  "in one step. Use web search when it makes the result more accurate or current. You MUST NOT " +
  "claim to have performed any real-world action (sending, posting, buying, booking, submitting, " +
  "paying) — you cannot take those actions. Instead, produce the finished draft or research " +
  "result the human will act on manually. Be concise and immediately usable: lead with the " +
  "deliverable (the draft text, the answer, the shortlist), not a description of what you did.";

// Anthropic's built-in server-side web search tool (read-only; runs on Anthropic's infra).
const DISPATCH_TOOLS = [{ type: "web_search_20260209", name: "web_search", max_uses: 8 }];

// Run the agent to completion: a server-tool loop. web_search runs server-side, so the only
// looping we do client-side is to resume a `pause_turn` (the API's server loop hitting its
// per-turn iteration cap). We collect the final assistant text when the turn ends.
async function runDispatchAgent(task) {
  const messages = [{ role: "user", content: `Task: ${task}` }];
  let text = "";
  for (let i = 0; i < 12; i++) { // bound continuations so a stuck run can't loop forever
    const resp = await anthropic.messages.create({
      model: MODEL_DISPATCH,
      max_tokens: DISPATCH_MAX_TOKENS,
      system: DISPATCH_SYSTEM,
      tools: DISPATCH_TOOLS,
      messages,
    });
    if (resp.stop_reason === "pause_turn") {
      // Server hit its iteration cap mid-turn — echo the assistant turn back to resume.
      messages.push({ role: "assistant", content: resp.content });
      continue;
    }
    text = (resp.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    break;
  }
  return text;
}

// Modest per-install rate limit — dispatch is expensive, so cap it below the other AI routes.
const dispatchLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, keyGenerator: (req) => req.install?.id || req.ip });

const MAX_DISPATCH_JOBS_PER_INSTALL = 2; // running at once — each run is the expensive model

app.post("/api/dispatch", auth, dispatchLimiter, (req, res) => {
  const installId = req.install.id;
  if (!Store.isSubscribed(installId)) return res.status(403).json({ error: "subscription_required" });
  const task = String(req.body.task || "").slice(0, 1000).trim();
  if (!task) return res.status(400).json({ error: "task_required" });
  const running = [...jobs.values()].filter((j) => j.installId === installId && j.status === "working").length;
  if (running >= MAX_DISPATCH_JOBS_PER_INSTALL) return res.status(429).json({ error: "too_many_running" });
  const jobId = randomUUID();
  jobs.set(jobId, { installId, status: "working" });
  // Fire and forget — do NOT await; the agent run outlives this request.
  runDispatchAgent(task)
    .then((result) => jobs.set(jobId, { installId, status: "done", result }))
    .catch((e) => jobs.set(jobId, { installId, status: "error", error: String(e?.message || e) }));
  res.json({ jobId });
});

// A job is only visible to the install that started it.
app.get("/api/dispatch/:jobId", auth, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.installId !== req.install.id) return res.status(404).json({ error: "not_found" });
  const { installId, ...out } = job;
  res.json(out);
});

app.get("/", (_req, res) => res.json({ ok: true })); // health check for the host

// Persist immediately on shutdown (Railway sends SIGTERM on redeploy) so no credits are lost.
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { Store.flush(); process.exit(0); });

app.listen(process.env.PORT || 3000, () => console.log("GTD AI backend up"));
