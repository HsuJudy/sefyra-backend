// agent: claude-code  2026-10-10
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

async function loadStoreWith(contents) {
  const dir = mkdtempSync(path.join(tmpdir(), "corrupt-test-"));
  const file = path.join(dir, "db.json");
  if (contents !== undefined) writeFileSync(file, contents);
  process.env.DB_PATH = file;
  const mod = await import(`../store.js?case=${Math.random()}`); // fresh evaluation reads the new DB_PATH
  return { dir, file, Store: mod.Store };
}

test("a damaged database is set aside, not overwritten", async () => {
  const { dir, Store } = await loadStoreWith("{ this is not json");
  const kept = readdirSync(dir).filter((f) => f.includes(".corrupt-"));
  assert.equal(kept.length, 1);
  assert.equal(readFileSync(path.join(dir, kept[0]), "utf8"), "{ this is not json");
  assert.equal(Store.ensure("x").used, 0); // and the server still starts with an empty store
});
test("a file that is valid JSON but not a database (null, array) is also set aside, not a startup crash", async () => {
  for (const bad of ["null", "[]", "42"]) {
    const { dir, Store } = await loadStoreWith(bad);
    assert.equal(readdirSync(dir).filter((f) => f.includes(".corrupt-")).length, 1, bad);
    assert.ok(Store.ensure("y"));
  }
});
test("a good database loads untouched and nothing is set aside", async () => {
  const good = JSON.stringify({ installs: { a: { id: "a", code: "AAAAAA", referrals: 3, used: 0, month: "2026-10" } }, codes: { AAAAAA: "a" }, subs: {} });
  const { dir, Store } = await loadStoreWith(good);
  assert.equal(readdirSync(dir).filter((f) => f.includes(".corrupt-")).length, 0);
  assert.equal(Store.ensure("a").referrals, 3);
});
test("a missing file is simply a fresh start", async () => {
  const { dir, Store } = await loadStoreWith(undefined);
  assert.equal(readdirSync(dir).length, 0);
  assert.ok(Store.ensure("z"));
});

test("claiming a code whose owner record is gone is a clean 'invalid code', not a crash", async () => {
  const seeded = JSON.stringify({ installs: {}, codes: { ORPHAN: "ghost-install" }, subs: {} });
  const { Store } = await loadStoreWith(seeded);
  const r = Store.claim("claimer-1", "ORPHAN");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid_code");
});
