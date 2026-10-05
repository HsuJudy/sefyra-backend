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
