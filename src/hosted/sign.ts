import type { webcrypto } from "node:crypto";

/**
 * Ed25519 signing for the receipt of a hosted job, with WebCrypto, which both Node and Cloudflare Workers have.
 * The signature has the form of the local receipt (src/core/report/sign.ts): the public key as SPKI DER in
 * base64, its SHA-256 as the key id, and the signature over the canonical JSON of the receipt without it. A
 * key made for one job signs only that job.
 */
const b64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));

export async function jobSigner(): Promise<(bytes: Uint8Array) => Promise<{ public_key: string; key_id: string; value: string }>> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as { publicKey: webcrypto.CryptoKey; privateKey: webcrypto.CryptoKey };
  const der = await crypto.subtle.exportKey("spki", pair.publicKey);
  const id = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", der)), (b) => b.toString(16).padStart(2, "0")).join("");
  return async (bytes) => ({ public_key: b64(der), key_id: `sha256:${id}`, value: b64(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, bytes)) });
}
