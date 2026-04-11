import type { AtLabel, AtLabelEmitter, ModerationBridgeStore } from "./types.js";
import { createECDH, createPrivateKey, createSign, KeyObject } from "node:crypto";
import * as dagCbor from "@ipld/dag-cbor";

type NodeJsonWebKey = import("node:crypto").JsonWebKey;

// ---------------------------------------------------------------------------
// AT Label Emitter
//
// Responsible for creating and storing AT Protocol label records.
//
// Security and accuracy note:
//   Labels are encoded as DAG-CBOR and signed with secp256k1 using ECDSA
//   SHA-256, serialized as IEEE P1363 64-byte signatures (r || s), matching
//   AT Protocol expectations for byte signatures.
// ---------------------------------------------------------------------------

function toCanonicalLabelObject(label: Omit<AtLabel, "sig">): Record<string, unknown> {
  const sortedKeys: (keyof typeof label)[] = ["src", "uri", "cid", "val", "neg", "cts", "exp"];
  const out: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    const value = label[key];
    if (value !== undefined) out[key as string] = value;
  }
  return out;
}

function normalizePrivateKeyHex(raw: string): Buffer {
  const cleaned = raw.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(cleaned)) {
    throw new Error("MODERATION_LABELER_SIGNING_KEY_HEX must be exactly 32 bytes (64 hex chars)");
  }
  return Buffer.from(cleaned, "hex");
}

function toBase64Url(input: Buffer): string {
  return input.toString("base64url");
}

function createSecp256k1Jwk(privateKey: Buffer): NodeJsonWebKey {
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(privateKey);
  const publicKey = ecdh.getPublicKey(undefined, "uncompressed");
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new Error("Unable to derive valid uncompressed secp256k1 public key");
  }

  const x = publicKey.subarray(1, 33);
  const y = publicKey.subarray(33, 65);

  return {
    kty: "EC",
    crv: "secp256k1",
    d: toBase64Url(privateKey),
    x: toBase64Url(x),
    y: toBase64Url(y),
  };
}

function createSecp256k1KeyObject(privateKeyHex: string): KeyObject {
  const privateKey = normalizePrivateKeyHex(privateKeyHex);
  const jwk = createSecp256k1Jwk(privateKey);
  return createPrivateKey({ key: jwk, format: "jwk" });
}

function signLabel(label: Omit<AtLabel, "sig">, keyObject: KeyObject): Uint8Array {
  const payload = dagCbor.encode(toCanonicalLabelObject(label));
  const signer = createSign("sha256");
  signer.update(Buffer.from(payload));
  signer.end();
  const signature = signer.sign({ key: keyObject, dsaEncoding: "ieee-p1363" });
  return new Uint8Array(signature);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAtLabelEmitter(
  store: ModerationBridgeStore,
  opts: {
    labelerDid: string;
    signingKeyHex?: string;
    now?: () => string;
  },
): AtLabelEmitter {
  const now = opts.now ?? (() => new Date().toISOString());
  const signingKeyObject = opts.signingKeyHex ? createSecp256k1KeyObject(opts.signingKeyHex) : null;

  async function buildLabel(
    params: { uri: string; cid?: string; val: string; neg?: boolean; exp?: string },
  ): Promise<AtLabel> {
    const base: Omit<AtLabel, "sig"> = {
      src: opts.labelerDid,
      uri: params.uri,
      ...(params.cid ? { cid: params.cid } : {}),
      val: params.val,
      ...(params.neg ? { neg: true } : {}),
      cts: now(),
      ...(params.exp ? { exp: params.exp } : {}),
    };

    let sig: Uint8Array | undefined;
    if (signingKeyObject) {
      sig = signLabel(base, signingKeyObject);
    }

    return sig ? { ...base, sig } : base;
  }

  return {
    async emit(params) {
      const label = await buildLabel(params);
      await store.addAtLabel(label);
      return label;
    },

    async negate(uri, val) {
      const label = await buildLabel({ uri, val, neg: true });
      await store.addAtLabel(label);
      return label;
    },
  };
}
