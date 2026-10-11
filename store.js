// Tiny zero-dependency persistent store for installs + referrals.
// Loads a JSON file into memory, writes back (debounced, atomic). Good for an MVP;
// swap for Postgres/Redis when volume grows. On Railway, mount a volume and set
// DB_PATH=/data/db.json so credits survive redeploys.
import { promises as fs } from "fs";
import { existsSync, mkdirSync, writeFileSync, renameSync } from "fs";
import path from "path";
import crypto from "crypto";

const DB_PATH = process.env.DB_PATH || "./data/db.json";
mkdirSync(path.dirname(DB_PATH), { recursive: true });

// { installs: { [id]: Install }, codes: { [code]: id }, subs: { [originalTransactionId]: installId } }
let db = { installs: {}, codes: {}, subs: {} };
if (existsSync(DB_PATH)) {
  let parsed;
  try { parsed = JSON.parse(await fs.readFile(DB_PATH, "utf8")); } catch { parsed = undefined; }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) db = parsed;
  else {
    // Unreadable or not a database. Keep the bytes (they may be recoverable) before starting empty,
    // otherwise the next write would silently destroy every subscription, quota and referral record.
    const keep = `${DB_PATH}.corrupt-${Date.now()}`;
    try { renameSync(DB_PATH, keep); console.error(`db unreadable; moved to ${keep} and starting empty`); }
    catch (e) { console.error("db unreadable and could not be set aside", e); }
  }
}
db.installs ??= {}; db.codes ??= {}; db.subs ??= {};

let writeTimer = null;
function persist() {
  if (writeTimer) return;
  writeTimer = setTimeout(async () => {
    writeTimer = null;
    const tmp = DB_PATH + ".tmp";
    try { await fs.writeFile(tmp, JSON.stringify(db)); await fs.rename(tmp, DB_PATH); }
    catch (e) { console.error("db write failed", e); }
  }, 800);
}

// A short, human-typeable referral code derived from the install id (collision-checked).
function makeCode(id) {
  let base = crypto.createHash("sha256").update(id).digest("hex");
  for (let i = 0; i < base.length - 6; i += 6) {
    const code = parseInt(base.slice(i, i + 8), 16).toString(36).toUpperCase().slice(0, 6).padStart(6, "0");
    if (!db.codes[code]) return code;
  }
  return crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
}

function monthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export const Store = {
  BASE_QUOTA: parseInt(process.env.FREE_AI_QUOTA || "15", 10),
  PER_REFERRAL: parseInt(process.env.REFERRAL_BONUS || "15", 10),
  /** Dispatch runs the strongest model, so subscribers get a monthly allowance (not unlimited). */
  DISPATCH_QUOTA: parseInt(process.env.DISPATCH_MONTHLY_QUOTA || "30", 10),

  /** Flush pending writes immediately — call on shutdown so a redeploy never drops credits. */
  flush() {
    try {
      if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
      writeFileSync(DB_PATH, JSON.stringify(db));
    } catch (e) { console.error("db flush failed", e); }
  },

  /** Create (or fetch) an install record; returns it. */
  ensure(id) {
    let inst = db.installs[id];
    if (!inst) {
      const code = makeCode(id);
      inst = { id, code, referredBy: null, referrals: 0, used: 0, month: monthKey() };
      db.installs[id] = inst;
      db.codes[code] = id;
      persist();
    }
    return inst;
  },

  /** Monthly allowance = base + per-referral bump + a bump for having been referred. */
  quotaFor(inst) {
    return this.BASE_QUOTA + this.PER_REFERRAL * inst.referrals + (inst.referredBy ? this.PER_REFERRAL : 0);
  },

  /** Roll the counter over at each new UTC month. */
  rollMonth(inst) {
    const m = monthKey();
    if (inst.month !== m) { inst.month = m; inst.used = 0; persist(); }
  },

  /** True if a call is allowed; increments usage when it is. */
  tryConsume(id) {
    const inst = this.ensure(id);
    this.rollMonth(inst);
    if (inst.used >= this.quotaFor(inst)) return { ok: false, ...this.status(id) };
    inst.used += 1; persist();
    return { ok: true, ...this.status(id) };
  },

  /** One Dispatch run for a subscriber. Separate from the free monthly credits. */
  tryConsumeDispatch(id) {
    const inst = this.ensure(id);
    const m = monthKey();
    if (inst.dispatchMonth !== m) { inst.dispatchMonth = m; inst.dispatchUsed = 0; }
    if ((inst.dispatchUsed || 0) >= this.DISPATCH_QUOTA) return { ok: false, ...this.dispatchStatus(id) };
    inst.dispatchUsed = (inst.dispatchUsed || 0) + 1; persist();
    return { ok: true, ...this.dispatchStatus(id) };
  },

  /** The run failed, timed out, or only asked a question — don't charge the subscriber. */
  refundDispatch(id) {
    const inst = db.installs[id];
    if (inst && inst.dispatchUsed > 0) { inst.dispatchUsed -= 1; persist(); }
  },

  dispatchStatus(id) {
    const inst = this.ensure(id);
    const m = monthKey();
    const used = inst.dispatchMonth === m ? inst.dispatchUsed || 0 : 0;
    return { dispatchQuota: this.DISPATCH_QUOTA, dispatchUsed: used, dispatchRemaining: Math.max(0, this.DISPATCH_QUOTA - used), dispatchResetsOn: `${m}-01` };
  },

  /** Hand a credit back when the AI call itself fails — the user shouldn't pay for our error. */
  refund(id) {
    const inst = db.installs[id];
    if (inst && inst.used > 0) { inst.used -= 1; persist(); }
  },

  /** Friend claims a referrer's code. Both end up with a bigger monthly allowance. */
  claim(id, rawCode) {
    const inst = this.ensure(id);
    if (inst.referredBy) return { ok: false, reason: "already_claimed" };
    const code = String(rawCode || "").trim().toUpperCase();
    const refId = db.codes[code];
    if (!refId) return { ok: false, reason: "invalid_code" };
    if (refId === id) return { ok: false, reason: "self_referral" };
    const referrer = db.installs[refId];
    if (!referrer) return { ok: false, reason: "invalid_code" };
    inst.referredBy = code;
    referrer.referrals += 1;
    persist();
    return { ok: true, ...this.status(id) };
  },

  /**
   * Record a verified App Store subscription for this install. One purchase follows the Apple ID:
   * if another install already held it (reinstall / new phone), it moves here and the old one loses it.
   */
  setSubscription(id, { originalTransactionId, productId, expiresAt, environment }) {
    const inst = this.ensure(id);
    const prevId = db.subs[originalTransactionId];
    if (prevId && prevId !== id && db.installs[prevId]) delete db.installs[prevId].subscription;
    db.subs[originalTransactionId] = id;
    inst.subscription = { originalTransactionId, productId, expiresAt, environment };
    persist();
  },

  isSubscribed(id) {
    const sub = db.installs[id]?.subscription;
    return !!sub && sub.expiresAt > Date.now();
  },

  status(id) {
    const inst = this.ensure(id);
    this.rollMonth(inst);
    const quota = this.quotaFor(inst);
    return {
      code: inst.code,
      referrals: inst.referrals,
      referred: !!inst.referredBy,
      quota,
      used: inst.used,
      remaining: Math.max(0, quota - inst.used),
      resetsOn: `${inst.month}-01`,
      ...this.dispatchStatus(id),
      subscribed: this.isSubscribed(id),
      subscriptionExpiresAt: inst.subscription?.expiresAt ?? null,
    };
  },
};
