import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { Store } from "./store.js";

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

app.get("/", (_req, res) => res.json({ ok: true })); // health check for the host

// Persist immediately on shutdown (Railway sends SIGTERM on redeploy) so no credits are lost.
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { Store.flush(); process.exit(0); });

app.listen(process.env.PORT || 3000, () => console.log("GTD AI backend up"));
