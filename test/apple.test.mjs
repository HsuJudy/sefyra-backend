// agent: claude-code  2026-10-05
// Builds a throwaway Apple-shaped cert chain with openssl and signs fake StoreKit 2 transactions.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { X509Certificate, createPrivateKey, sign } from "node:crypto";
import { verifyAppleTransaction } from "../apple.js";

const dir = mkdtempSync(path.join(tmpdir(), "apple-test-"));
const sh = (...a) => execFileSync("openssl", a, { cwd: dir, stdio: "pipe" });
const LEAF_OID = "1.2.840.113635.100.6.11.1", INTER_OID = "1.2.840.113635.100.6.2.1";

function makeChain(name, { leafOid = LEAF_OID, interOid = INTER_OID } = {}) {
  const f = (s) => `${name}-${s}`;
  sh("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", f("root.key"));
  sh("req", "-new", "-x509", "-key", f("root.key"), "-subj", `/CN=${name} root`, "-days", "365", "-out", f("root.pem"));
  const issue = (kind, parent, ext) => {
    sh("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", f(`${kind}.key`));
    sh("req", "-new", "-key", f(`${kind}.key`), "-subj", `/CN=${name} ${kind}`, "-out", f(`${kind}.csr`));
    writeFileSync(path.join(dir, f(`${kind}.ext`)), ext);
    sh("x509", "-req", "-in", f(`${kind}.csr`), "-CA", f(`${parent}.pem`), "-CAkey", f(`${parent}.key`),
       "-CAcreateserial", "-days", "365", "-extfile", f(`${kind}.ext`), "-out", f(`${kind}.pem`));
  };
  issue("inter", "root", `basicConstraints=CA:TRUE\n${interOid}=ASN1:NULL\n`);
  issue("leaf", "inter", `${leafOid}=ASN1:NULL\n`);
  const read = (k) => readFileSync(path.join(dir, f(k)));
  const der = (k) => new X509Certificate(read(`${k}.pem`)).raw.toString("base64");
  return {
    root: new X509Certificate(read("root.pem")),
    x5c: [der("leaf"), der("inter"), der("root")],
    key: createPrivateKey(read("leaf.key")),
  };
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jws(chain, payload, header = {}) {
  const head = b64({ alg: "ES256", x5c: chain.x5c, ...header });
  const body = b64(payload);
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key: chain.key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${head}.${body}.${sig}`;
}

const good = makeChain("good");
const other = makeChain("other");
const noOid = makeChain("nooid", { leafOid: "1.2.3.4.5" });
const day = 86_400_000;
const tx = (over = {}) => ({
  bundleId: "com.judy98122.gtdapp", productId: "sefyra.pro.monthly", environment: "Production",
  originalTransactionId: "1000000123", expiresDate: Date.now() + 30 * day, ...over,
});
const opts = (over = {}) => ({
  roots: [good.root], bundleId: "com.judy98122.gtdapp", productIds: ["sefyra.pro.monthly"],
  environments: ["Production", "Sandbox"], ...over,
});
const reason = (s, o) => verifyAppleTransaction(s, o).reason;

test("accepts a correctly signed, current subscription", () => {
  const r = verifyAppleTransaction(jws(good, tx()), opts());
  assert.equal(r.ok, true);
  assert.equal(r.tx.originalTransactionId, "1000000123");
});
test("rejects a payload edited after signing", () => {
  const [h, , s] = jws(good, tx()).split(".");
  assert.equal(reason(`${h}.${b64(tx({ expiresDate: Date.now() + 999 * day }))}.${s}`, opts()), "bad_signature");
});
test("rejects a chain that does not end at the pinned root", () => {
  assert.equal(reason(jws(other, tx()), opts()), "untrusted_root");
});
test("rejects Apple-issued-style certs without the receipt-signing marker", () => {
  assert.equal(reason(jws(noOid, tx()), opts({ roots: [noOid.root] })), "not_apple_receipt_cert");
});
test("rejects a leaf that was not signed by the intermediate", () => {
  const forged = { ...good, x5c: [other.x5c[0], good.x5c[1], good.x5c[2]], key: other.key };
  assert.equal(reason(jws(forged, tx()), opts()), "bad_chain");
});
test("rejects expired certs", () => {
  assert.equal(reason(jws(good, tx({ expiresDate: Date.now() + 900 * day })), opts({ now: Date.now() + 800 * day })), "cert_expired");
});
test("rejects wrong app, wrong product, expired and revoked subscriptions", () => {
  assert.equal(reason(jws(good, tx({ bundleId: "com.other.app" })), opts()), "wrong_app");
  assert.equal(reason(jws(good, tx({ productId: "other.product" })), opts()), "wrong_product");
  assert.equal(reason(jws(good, tx({ expiresDate: Date.now() - day })), opts()), "expired");
  assert.equal(reason(jws(good, tx({ revocationDate: Date.now() - day })), opts()), "revoked");
});
test("sandbox purchases are refused when only Production is allowed", () => {
  assert.equal(reason(jws(good, tx({ environment: "Sandbox" })), opts({ environments: ["Production"] })), "wrong_environment");
});
test("fails closed when no product ids are configured", () => {
  assert.equal(reason(jws(good, tx()), opts({ productIds: [] })), "wrong_product");
});
test("rejects garbage and unsigned tokens", () => {
  assert.equal(reason("", opts()), "malformed");
  assert.equal(reason("a.b.c", opts()), "malformed");
  assert.equal(reason(jws(good, tx(), { alg: "none" }), opts()), "malformed");
});
