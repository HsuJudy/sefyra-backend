import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
app.use(cors({ origin: false }));
app.use(express.json({ limit: "8kb" }));

const SECRET = process.env.JWT_SECRET;
const MODEL = "claude-opus-4-8"; // swap to "claude-haiku-4-5" to cut cost on these simple tasks
const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

// Per-install token: the app calls /register once and stores the token in the Keychain.
const registerLimiter = rateLimit({ windowMs: 24 * 60 * 60 * 1000, max: 5 });
app.post("/register", registerLimiter, (_req, res) => {
  const token = jwt.sign({ id: randomUUID() }, SECRET, { expiresIn: "365d" });
  res.json({ token });
});

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : "";
  try { req.install = jwt.verify(t, SECRET); next(); }
  catch { res.status(401).json({ error: "unauthorized" }); }
}

// Per-install rate limit so a leaked token can't drain your key.
const aiLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, keyGenerator: (req) => req.install?.id || req.ip });

async function claude(system, prompt) {
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1000,
    system,
    messages: [{ role: "user", content: prompt }],
  });
  return (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

app.post("/api/suggest", auth, aiLimiter, async (req, res) => {
  try {
    const item = String(req.body.item || "").slice(0, 500);
    const out = await claude(
      "You are a GTD next-action engine. Given an inbox item, reply with ONLY the single most concrete, physical, visible next action to move it forward — an imperative phrase starting with a verb, max 12 words. No preamble, no quotes, no explanation. Always answer; never refuse or add caveats.",
      `Inbox item: "${item}"`
    );
    const first = (out.split("\n").map((s) => s.trim()).filter(Boolean)[0] || "");
    res.json({ nextAction: first.replace(/^["']|["']$/g, "") });
  } catch { res.status(500).json({ error: "ai_failed" }); }
});

app.post("/api/breakdown", auth, aiLimiter, async (req, res) => {
  try {
    const outcome = String(req.body.outcome || "").slice(0, 500);
    const raw = await claude(
      "You are a task-breakdown engine for a GTD app. Given a project outcome, output ONLY a JSON array of 3 to 6 short next-action steps in order. Each step is an imperative phrase starting with a verb. No prose, no preamble, no explanation, no markdown fences, no caveats. Always produce steps — if the outcome is vague, make reasonable assumptions. Never refuse.",
      `Project outcome: "${outcome}"`
    );
    let steps = [];
    const m = raw.match(/\[[\s\S]*\]/);                       // pull the JSON array even if wrapped in prose
    if (m) { try { steps = JSON.parse(m[0]); } catch {} }
    if (!Array.isArray(steps) || !steps.length) {             // last resort: salvage step-like lines, drop prose
      steps = raw.split("\n")
        .map((s) => s.replace(/^[\s\-*\d.)\]\["]+/, "").trim())
        .filter((s) => s && s.length < 120 && !/^(i |i'|that |if |however|note|here|sorry|while|based)/i.test(s));
    }
    steps = steps.map((s) => String(s).trim()).filter(Boolean).slice(0, 6);
    res.json({ steps });
  } catch { res.status(500).json({ error: "ai_failed" }); }
});

app.get("/", (_req, res) => res.json({ ok: true })); // health check for the host

app.listen(process.env.PORT || 3000, () => console.log("GTD AI backend up"));
