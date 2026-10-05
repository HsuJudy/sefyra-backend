// agent: claude-code  2026-10-05
// Verifies a StoreKit 2 signed transaction (JWS) without calling Apple: the signature chain
// must end at Apple Root CA - G3, and the leaf/intermediate must carry Apple's receipt-signing
// markers (otherwise any developer's Apple-issued cert would pass). Zero dependencies.
import { X509Certificate, verify as cryptoVerify } from "crypto";
import { readFileSync } from "fs";

// Apple Root CA - G3, public, pinned by full-certificate equality. SHA-256:
// 63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79
export const APPLE_ROOT = new X509Certificate(readFileSync(new URL("./apple-root-ca-g3.pem", import.meta.url)));

// OIDs as DER bytes (06 <len> <oid>), searched for inside the cert.
const OID_LEAF = Buffer.from("060a2a864886f76364060b01", "hex");         // 1.2.840.113635.100.6.11.1
const OID_INTERMEDIATE = Buffer.from("060a2a864886f76364060201", "hex"); // 1.2.840.113635.100.6.2.1

const b64url = (s) => Buffer.from(s, "base64url");

/** Returns { ok: true, tx } or { ok: false, reason }. `roots` lets tests pin a fake root. */
export function verifyAppleTransaction(jws, { roots = [APPLE_ROOT], now = Date.now(), bundleId, productIds, environments } = {}) {
  try {
    const parts = String(jws || "").split(".");
    if (parts.length !== 3) return { ok: false, reason: "malformed" };
    const header = JSON.parse(b64url(parts[0]).toString());
    if (header.alg !== "ES256" || !Array.isArray(header.x5c) || header.x5c.length !== 3) return { ok: false, reason: "malformed" };

    const [leaf, inter, root] = header.x5c.map((c) => new X509Certificate(Buffer.from(c, "base64")));
    if (!roots.some((r) => r.raw.equals(root.raw))) return { ok: false, reason: "untrusted_root" };
    if (!leaf.verify(inter.publicKey) || !inter.verify(root.publicKey)) return { ok: false, reason: "bad_chain" };
    if (!leaf.raw.includes(OID_LEAF) || !inter.raw.includes(OID_INTERMEDIATE)) return { ok: false, reason: "not_apple_receipt_cert" };
    for (const c of [leaf, inter, root]) {
      if (now < Date.parse(c.validFrom) || now > Date.parse(c.validTo)) return { ok: false, reason: "cert_expired" };
    }

    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    const sigOk = cryptoVerify("sha256", signed, { key: leaf.publicKey, dsaEncoding: "ieee-p1363" }, b64url(parts[2]));
    if (!sigOk) return { ok: false, reason: "bad_signature" };

    const tx = JSON.parse(b64url(parts[1]).toString());
    if (!bundleId || tx.bundleId !== bundleId) return { ok: false, reason: "wrong_app" };
    if (!productIds?.length || !productIds.includes(tx.productId)) return { ok: false, reason: "wrong_product" };
    if (!environments?.includes(tx.environment)) return { ok: false, reason: "wrong_environment" };
    if (tx.revocationDate) return { ok: false, reason: "revoked" };
    if (!tx.originalTransactionId || !(tx.expiresDate > now)) return { ok: false, reason: "expired" };
    return { ok: true, tx };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}
