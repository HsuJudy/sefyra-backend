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

async function claude(prompt) {
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1000,
    messages: [{ role: "user", content: prompt }],
  });
  return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

app.post("/api/suggest", auth, aiLimiter, async (req, res) => {
  try {
    const item = String(req.body.item || "").slice(0, 500);
    const out = await claude(`A GTD inbox item: "${item}". Reply with ONLY the single concrete, physical, visible NEXT ACTION to move it forward. Start with a verb. No preamble, no quotes, max 12 words.`);
    res.json({ nextAction: out.replace(/^["']|["']$/g, "") });
  } catch { res.status(500).json({ error: "ai_failed" }); }
});

app.post("/api/breakdown", auth, aiLimiter, async (req, res) => {
  try {
    const outcome = String(req.body.outcome || "").slice(0, 500);
    const raw = await claude(`GTD project outcome: "${outcome}". Break it into 3-6 concrete, physical next-action steps in order, each starting with a verb. Reply ONLY with a JSON array of strings. No preamble, no markdown.`);
    let steps;
    try { steps = JSON.parse(raw.replace(/```json|```/g, "").trim()); }
    catch { steps = raw.split("\n").map((s) => s.replace(/^[\s\-*\d.)]+/, "").trim()).filter(Boolean); }
    res.json({ steps: (steps || []).slice(0, 6) });
  } catch { res.status(500).json({ error: "ai_failed" }); }
});

app.get("/", (_req, res) => res.json({ ok: true })); // health check for the host

app.listen(process.env.PORT || 3000, () => console.log("GTD AI backend up"));
