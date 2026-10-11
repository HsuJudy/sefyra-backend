// agent: claude-code  2026-10-10
// In-memory book of dispatch jobs. Pure (no timers of its own) so it is unit-testable.
// Fixes from review: finished jobs are evicted, a hung "working" job is failed instead of
// locking its install forever, and a late result can never overwrite a job that was already failed.
import { randomUUID } from "crypto";

export class JobBook {
  constructor({ ttlMs = 60 * 60 * 1000, maxWorkingMs = 5 * 60 * 1000 } = {}) {
    this.ttlMs = ttlMs;
    this.maxWorkingMs = maxWorkingMs;
    this.jobs = new Map(); // id -> { installId, status, startedAt, endedAt?, result?, question?, error? }
  }

  create(installId, now = Date.now()) {
    const id = randomUUID();
    this.jobs.set(id, { installId, status: "working", startedAt: now });
    return id;
  }

  /** Only a job that is still "working" can be finished. Returns true if it was. */
  finish(id, patch, now = Date.now()) {
    const j = this.jobs.get(id);
    if (!j || j.status !== "working") return false;
    this.jobs.set(id, { ...j, ...patch, endedAt: now });
    return true;
  }

  /** What the owner may see. Anyone else (or an unknown id) gets null. */
  view(id, installId) {
    const j = this.jobs.get(id);
    if (!j || j.installId !== installId) return null;
    const { installId: _i, startedAt: _s, endedAt: _e, ...out } = j;
    return out;
  }

  runningCount(installId) {
    let n = 0;
    for (const j of this.jobs.values()) if (j.installId === installId && j.status === "working") n++;
    return n;
  }

  /** Fail jobs stuck "working" too long; drop finished jobs past their keep time. */
  sweep(now = Date.now()) {
    const timedOut = [];
    let removed = 0;
    for (const [id, j] of this.jobs) {
      if (j.status === "working" && now - j.startedAt > this.maxWorkingMs) {
        this.jobs.set(id, { ...j, status: "error", error: "timed_out", endedAt: now });
        timedOut.push(j.installId);
      } else if (j.status !== "working" && now - j.endedAt > this.ttlMs) {
        this.jobs.delete(id);
        removed++;
      }
    }
    return { timedOut, removed };
  }
}
