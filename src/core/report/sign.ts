import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { canonicalJson } from "../canonical.js";
import { receiptKeyPath } from "../paths.js";

/**
 * Receipt signing with Ed25519 from node:crypto. The private key lives in the Candor home, outside every
 * workspace, with mode 0600. The public key goes in the receipt. A signature shows that the receipt was not
 * changed after it was signed and that the holder of one key signed it. It does not show who the holder is:
 * a receipt that carries its own public key can be re-signed by anyone with another key. `candor verify`
 * says so and, on the machine that issued the receipt, compares the key with the key kept here.
 */

export interface ReceiptSignature {
  alg: "ed25519";
  /** The public key, SPKI DER, base64. */
  public_key: string;
  /** SHA-256 of the public key bytes. */
  key_id: string;
  /** The signature over the canonical JSON of the receipt without this field, base64. */
  value: string;
}

export const keyId = (publicKeyDerBase64: string): string => `sha256:${createHash("sha256").update(Buffer.from(publicKeyDerBase64, "base64")).digest("hex")}`;

/** Creates the signing key on first use. */
export function ensureReceiptKey(home: string): { privatePem: string; publicDerBase64: string } {
  const file = receiptKeyPath(home);
  if (!existsSync(file)) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const { privateKey } = generateKeyPairSync("ed25519");
    writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  const privatePem = readFileSync(file, "utf8");
  const publicDerBase64 = createPublicKey(createPrivateKey(privatePem)).export({ type: "spki", format: "der" }).toString("base64");
  return { privatePem, publicDerBase64 };
}

/** The part of the receipt that is signed: everything except the signature field. */
export const signedBytes = (receipt: Record<string, unknown>): Buffer => {
  const { signature: _omitted, ...rest } = receipt;
  return Buffer.from(canonicalJson(rest), "utf8");
};

export function signReceipt(home: string, receipt: Record<string, unknown>): ReceiptSignature {
  const { privatePem, publicDerBase64 } = ensureReceiptKey(home);
  const value = sign(null, signedBytes(receipt), createPrivateKey(privatePem)).toString("base64");
  return { alg: "ed25519", public_key: publicDerBase64, key_id: keyId(publicDerBase64), value };
}

export type SignatureCheck = { ok: true; key_id: string } | { ok: false; reason: string };

export function checkSignature(receipt: Record<string, unknown>): SignatureCheck {
  const s = receipt.signature as Partial<ReceiptSignature> | null | undefined;
  if (!s || typeof s !== "object") return { ok: false, reason: "The receipt carries no signature." };
  if (s.alg !== "ed25519" || typeof s.public_key !== "string" || typeof s.value !== "string") return { ok: false, reason: "The signature field is not in the expected form." };
  try {
    const key = createPublicKey({ key: Buffer.from(s.public_key, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") return { ok: false, reason: "The public key is not an Ed25519 key." };
    if (!verify(null, signedBytes(receipt), key, Buffer.from(s.value, "base64"))) return { ok: false, reason: "The signature does not match the content of the receipt. The receipt was changed after it was signed, or it was signed by a different key." };
    return { ok: true, key_id: keyId(s.public_key) };
  } catch (error) {
    return { ok: false, reason: `The signature cannot be checked: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The key id of the key kept in this home, or null when none exists. Used only to compare, never to create. */
export function localKeyId(home: string): string | null {
  if (!existsSync(receiptKeyPath(home))) return null;
  try {
    return keyId(ensureReceiptKey(home).publicDerBase64);
  } catch {
    return null;
  }
}
