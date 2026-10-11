// agent: claude-code  2026-10-05
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "store-test-")), "db.json");
const { Store } = await import("../store.js");

const sub = (days, otid = "1000000123") => ({ originalTransactionId: otid, productId: "p", environment: "Production", expiresAt: Date.now() + days * 86_400_000 });

test("not subscribed by default; subscribed until expiry", () => {
  assert.equal(Store.isSubscribed("a"), false);
  Store.setSubscription("a", sub(30));
  assert.equal(Store.isSubscribed("a"), true);
  assert.equal(Store.status("a").subscribed, true);
  Store.setSubscription("b", sub(-1, "2000000000"));
  assert.equal(Store.isSubscribed("b"), false);
});
test("a purchase follows the Apple ID: reinstalling moves it to the new install", () => {
  Store.setSubscription("new-install", sub(30));
  assert.equal(Store.isSubscribed("new-install"), true);
  assert.equal(Store.isSubscribed("a"), false);
});

test("dispatch allowance: counts, stops at the limit, refunds, resets each month", () => {
  const q = Store.DISPATCH_QUOTA;
  const id = "disp-1";
  for (let i = 0; i < q; i++) assert.equal(Store.tryConsumeDispatch(id).ok, true);
  const over = Store.tryConsumeDispatch(id);
  assert.equal(over.ok, false);
  assert.equal(over.dispatchRemaining, 0);
  Store.refundDispatch(id);
  assert.equal(Store.dispatchStatus(id).dispatchRemaining, 1);
  assert.equal(Store.tryConsumeDispatch(id).ok, true);
  Store.ensure(id).dispatchMonth = "2020-01"; // pretend it is last month's count
  assert.equal(Store.dispatchStatus(id).dispatchRemaining, q);
  assert.equal(Store.tryConsumeDispatch(id).dispatchUsed, 1);
});
test("refund never goes below zero", () => {
  Store.refundDispatch("fresh-install"); Store.refundDispatch("fresh-install");
  assert.equal(Store.dispatchStatus("fresh-install").dispatchUsed, 0);
});
