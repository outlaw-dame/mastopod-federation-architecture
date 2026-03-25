/**
 * Local fixture signing service — for development and integration testing ONLY.
 *
 * Stores secp256k1 key pairs in Redis and signs AT commits locally using
 * Node.js `crypto`, without calling the ActivityPods signing API.
 *
 * SECURITY REQUIREMENTS:
 *   - MUST NOT be used in production.  Private keys are stored unencrypted in Redis.
 *   - Activated only when AT_LOCAL_FIXTURE=true is explicitly set.
 *   - Emits a loud startup warning to stderr every time it is constructed.
 *
 * Redis key layout (written by provision-test-fixture.ts):
 *   fixture:signing:key:{canonicalAccountId}:commit   → JSON(LocalKeyMaterial)
 *   fixture:signing:key:{canonicalAccountId}:rotation → JSON(LocalKeyMaterial)
 *
 * Signature format:
 *   ECDSA secp256k1 over SHA-256 of the input bytes, using IEEE P1363 (raw r||s)
 *   encoding — the raw 64-byte format expected by the ATProto protocol.
 *
 * Public key format:
 *   multibase base58btc-encoded secp256k1 compressed public key with multicodec
 *   prefix 0xe701 (secp256k1-pub varint), resulting in a string starting with 'z'.
 */

import { createSign, createPublicKey } from 'node:crypto';
import type {
  SigningService,
  SignAtprotoCommitRequest,
  SignAtprotoCommitResponse,
  SignPlcOperationRequest,
  SignPlcOperationResponse,
  GetAtprotoPublicKeyRequest,
  GetAtprotoPublicKeyResponse,
  GenerateApSigningKeyRequest,
  GenerateKeyResponse,
  GenerateAtSigningKeyRequest,
} from '../core-domain/contracts/SigningContracts.js';

// ---------------------------------------------------------------------------
// Key material shape stored in Redis
// ---------------------------------------------------------------------------

interface LocalKeyMaterial {
  privateKeyPem: string;
  publicKeyPem: string;
  publicKeyMultibase: string;
}

// ---------------------------------------------------------------------------
// Key prefix
// ---------------------------------------------------------------------------

export const LOCAL_SIGNING_KEY_PREFIX = 'fixture:signing:key:';

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class LocalAtSigningService implements SigningService {
  constructor(private readonly redis: {
    get(key: string): Promise<string | null>;
  }) {
    process.stderr.write(
      '[SECURITY WARNING] LocalAtSigningService is active. ' +
      'Private keys are stored in Redis. ' +
      'NEVER use in production.\n',
    );
  }

  // --------------------------------------------------------------------------
  // SigningService interface
  // --------------------------------------------------------------------------

  async signAtprotoCommit(
    req: SignAtprotoCommitRequest,
  ): Promise<SignAtprotoCommitResponse> {
    const material = await this._loadKey(req.canonicalAccountId, 'commit');
    const signatureBase64Url = _sign(material.privateKeyPem, req.unsignedCommitBytesBase64);

    return {
      did:                req.did,
      keyId:              `${req.did}#atproto`,
      signatureBase64Url,
      algorithm:          'k256',
      signedAt:           new Date().toISOString(),
    };
  }

  async signPlcOperation(
    req: SignPlcOperationRequest,
  ): Promise<SignPlcOperationResponse> {
    const material = await this._loadKey(req.canonicalAccountId, 'rotation');
    const signatureBase64Url = _sign(material.privateKeyPem, req.operationBytesBase64);

    return {
      did:                req.did,
      keyId:              `${req.did}#atproto-rotation-key`,
      signatureBase64Url,
      algorithm:          'k256',
      signedAt:           new Date().toISOString(),
    };
  }

  async getAtprotoPublicKey(
    req: GetAtprotoPublicKeyRequest,
  ): Promise<GetAtprotoPublicKeyResponse> {
    const material = await this._loadKey(req.canonicalAccountId, req.purpose);

    return {
      keyId:              `fixture:${req.canonicalAccountId}#${req.purpose}`,
      publicKeyMultibase: material.publicKeyMultibase,
      algorithm:          'k256',
    };
  }

  // Methods not supported in fixture mode — throw explicitly
  async generateApSigningKey(_req: GenerateApSigningKeyRequest): Promise<GenerateKeyResponse> {
    throw new Error('LocalAtSigningService: generateApSigningKey not supported');
  }

  async generateAtSigningKey(_req: GenerateAtSigningKeyRequest): Promise<GenerateKeyResponse> {
    throw new Error('LocalAtSigningService: generateAtSigningKey not supported');
  }

  async getApPublicKey(_req: unknown): Promise<never> {
    throw new Error('LocalAtSigningService: getApPublicKey not supported');
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private async _loadKey(
    canonicalAccountId: string,
    purpose: 'commit' | 'rotation',
  ): Promise<LocalKeyMaterial> {
    const key = `${LOCAL_SIGNING_KEY_PREFIX}${canonicalAccountId}:${purpose}`;
    const raw = await this.redis.get(key);
    if (!raw) {
      throw new Error(
        `LocalAtSigningService: no fixture key found for ` +
        `canonicalAccountId="${canonicalAccountId}" purpose="${purpose}". ` +
        `Run: npm run provision:test:fixture`,
      );
    }
    const material = JSON.parse(raw) as LocalKeyMaterial;
    if (!material.privateKeyPem || !material.publicKeyMultibase) {
      throw new Error(`LocalAtSigningService: malformed key material at Redis key: ${key}`);
    }
    return material;
  }
}

// ---------------------------------------------------------------------------
// Crypto helpers (no external dependencies)
// ---------------------------------------------------------------------------

/**
 * ECDSA-secp256k1-SHA256 signature over the base64-decoded input bytes.
 * Returns the raw IEEE P1363 (r||s) signature as a base64url string.
 * This is the format expected by the ATProto commit signing spec.
 */
function _sign(privateKeyPem: string, inputBase64: string): string {
  const inputBytes = Buffer.from(inputBase64, 'base64');
  const signer = createSign('SHA256');
  signer.update(inputBytes);
  // ieee-p1363 → raw 64-byte r||s (not DER); required by ATProto
  const sigBuffer = signer.sign({
    key: privateKeyPem,
    dsaEncoding: 'ieee-p1363',
  } as Parameters<typeof signer.sign>[0]);
  return sigBuffer.toString('base64url');
}

/**
 * Convert a secp256k1 public key PEM (SPKI) to a multibase base58btc string.
 *
 * Encoding:
 *   1. Export key in JWK format to extract x/y coordinates
 *   2. Compress to 33-byte SEC1 point (0x02|0x03 prefix + x)
 *   3. Prepend multicodec varint 0xe701 (secp256k1-pub)
 *   4. Base58btc-encode with 'z' multibase prefix
 */
export function secp256k1PemToMultibase(publicKeyPem: string): string {
  const keyObj = createPublicKey(publicKeyPem);
  const jwk = keyObj.export({ format: 'jwk' }) as { x?: string; y?: string };
  if (!jwk.x || !jwk.y) throw new Error('Cannot extract EC coordinates from public key');

  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');

  // Pad x and y to 32 bytes (may be shorter if leading zero was dropped)
  const xPad = Buffer.alloc(32);
  const yPad = Buffer.alloc(32);
  x.copy(xPad, 32 - x.length);
  y.copy(yPad, 32 - y.length);

  const prefix = yPad[31] % 2 === 0 ? 0x02 : 0x03;
  const compressed = Buffer.concat([Buffer.from([prefix]), xPad]);

  // Multicodec prefix for secp256k1-pub: varint 0xe701
  const multicodec = Buffer.from([0xe7, 0x01]);
  const prefixed = Buffer.concat([multicodec, compressed]);

  return 'z' + _base58btcEncode(prefixed);
}

/**
 * Base58btc encoding (Bitcoin alphabet, no checksum).
 * Standard big-endian algorithm.
 */
function _base58btcEncode(input: Buffer): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const digits: number[] = [0];

  for (const byte of input) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  // Preserve leading zero bytes as '1' characters
  let leadingZeros = 0;
  for (const byte of input) {
    if (byte !== 0) break;
    leadingZeros++;
  }

  const chars: string[] = [];
  for (let i = 0; i < leadingZeros; i++) chars.push('1');
  for (let i = digits.length - 1; i >= 0; i--) chars.push(ALPHABET[digits[i]]);
  return chars.join('');
}
