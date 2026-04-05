/**
 * Production-grade AT commit verifier for external subscribeRepos intake.
 *
 * Security properties:
 *   - Verifies the signed commit block against the repo DID's signing key.
 *   - Validates the advertised ops against the CAR slice by inverting them over
 *     the current MST root and requiring the recovered root to match prevData.
 *   - Rejects commits that cannot be proven instead of silently trusting them.
 *   - Caps CAR, block, record, and op counts to bound memory and CPU.
 *
 * MST logic in this file is a reduced adaptation of the reference Bluesky repo
 * implementation:
 * https://github.com/bluesky-social/atproto/tree/main/packages/repo/src
 */

import { ECDH, createPublicKey, createVerify, type JsonWebKey, type KeyObject } from "node:crypto";
import { TID, ipldToJson } from "@atproto/common-web";
import { CarReader } from "@ipld/car";
import * as dagCbor from "@ipld/dag-cbor";
import { ensureValidDid, ensureValidNsid, ensureValidRecordKey, ensureValidTid } from "@atproto/syntax";
import { sha256 } from "multiformats/hashes/sha2";
import { CID } from "multiformats/cid";
import { base58btc } from "multiformats/bases/base58";
import {
  RegistryError,
  RegistryErrorCode,
  type AtprotoRepoRegistry,
} from "../../atproto/repo/AtprotoRepoRegistry.js";
import type { RepositoryState } from "../../atproto/repo/AtprotoRepoState.js";
import { sanitizeJsonObject } from "../../utils/safe-json.js";
import type { AtVerifyFailedEvent } from "./AtIngressEvents.js";
import type { AtCommitVerifier, AtIdentityResolver } from "./AtIngressVerifier.js";

const DAG_CBOR_CODEC = dagCbor.code;
const DID_KEY_SUFFIXES = ["#atproto", "#signing-key", "#key-1"] as const;
const MAX_COMMITS_TO_KEEP = 100;
const MST_KEY_REGEX = /^[a-zA-Z0-9_~\-:.]+\/[a-zA-Z0-9_~\-:.]+$/;
const SECP256K1_ORDER = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
const P256_ORDER = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");
const SECP256K1_PUB_MULTICODEC = Uint8Array.from([0xe7, 0x01]);
const P256_PUB_MULTICODEC = Uint8Array.from([0x80, 0x24]);

type CommitFailureReason =
  | "signature_invalid"
  | "repo_state_invalid"
  | "did_resolution_failed";

interface ParsedCommitEventBody {
  repo: string;
  rev: string;
  since: string | null;
  commitCid: CID;
  prevDataCid: CID | null;
  tooBig: boolean;
  blocks: Uint8Array;
  ops: ParsedCommitOp[];
}

interface ParsedCommitOp {
  action: "create" | "update" | "delete";
  collection: string;
  rkey: string;
  path: string;
  cid: CID | null;
  prevCid: CID | null;
  deletedCid: CID | null;
  requiresSyncReason: string | null;
}

interface CommitBlock {
  did: string;
  version: 3;
  data: CID;
  rev: string;
  prev: CID | null;
  sig: Uint8Array;
  unsignedBytes: Uint8Array;
}

interface SigningKeyMaterial {
  keyId: string;
  keyObject: KeyObject;
  curve: "secp256k1" | "p256" | null;
}

interface VerificationFailure {
  isValid: false;
  failureReason: CommitFailureReason;
  reason: string;
}

type VerificationSuccess = Awaited<ReturnType<AtCommitVerifier["verifyCommit"]>> & { isValid: true };

export interface ProductionAtCommitVerifierOptions {
  identityResolver: AtIdentityResolver;
  repoRegistry: AtprotoRepoRegistry;
  maxCarBytes?: number;
  maxCarBlocks?: number;
  maxOps?: number;
  maxRecordBytes?: number;
}

export class ProductionAtCommitVerifier implements AtCommitVerifier {
  private readonly identityResolver: AtIdentityResolver;
  private readonly repoRegistry: AtprotoRepoRegistry;
  private readonly maxCarBytes: number;
  private readonly maxCarBlocks: number;
  private readonly maxOps: number;
  private readonly maxRecordBytes: number;

  public constructor(options: ProductionAtCommitVerifierOptions) {
    this.identityResolver = options.identityResolver;
    this.repoRegistry = options.repoRegistry;
    this.maxCarBytes = clampInteger(options.maxCarBytes ?? 5 * 1024 * 1024, 64 * 1024, 32 * 1024 * 1024);
    this.maxCarBlocks = clampInteger(options.maxCarBlocks ?? 4_096, 16, 100_000);
    this.maxOps = clampInteger(options.maxOps ?? 2_048, 1, 20_000);
    this.maxRecordBytes = clampInteger(options.maxRecordBytes ?? 1_000_000, 4_096, 8_000_000);
  }

  public async verifyCommit(body: any): Promise<Awaited<ReturnType<AtCommitVerifier["verifyCommit"]>>> {
    try {
      const parsed = parseCommitEventBody(body, {
        maxCarBytes: this.maxCarBytes,
        maxOps: this.maxOps,
      });

      const carBlocks = await readCommitCarBlocks(parsed.commitCid, parsed.blocks, this.maxCarBlocks);
      const commit = parseCommitBlock(parsed.repo, parsed.rev, parsed.commitCid, carBlocks.getRequired(parsed.commitCid));
      const signingKey = await this.resolveSigningKey(parsed.repo);
      const signatureValid = verifyCommitSignature(commit, signingKey);
      if (!signatureValid) {
        return invalid("signature_invalid", "Commit signature did not verify against the DID signing key");
      }

      if (parsed.tooBig) {
        const continuity = await this.checkContinuity(parsed);
        if (continuity) {
          return {
            isValid: true,
            requiresSync: true,
            reason: continuity,
            ops: [],
          };
        }

        return {
          isValid: true,
          requiresSync: true,
          reason: "Commit was marked tooBig by the upstream source and requires an authoritative sync rebuild",
          ops: [],
        };
      }

      const partialDiffReason = parsed.ops.find((op) => op.requiresSyncReason)?.requiresSyncReason;
      if (partialDiffReason) {
        return {
          isValid: true,
          requiresSync: true,
          reason: partialDiffReason,
          ops: [],
        };
      }

      const verifiedOps = await this.verifyAdvertisedOps(parsed, commit, carBlocks);
      const continuity = await this.checkContinuity(parsed);
      if (continuity) {
        return {
          isValid: true,
          requiresSync: true,
          reason: continuity,
          ops: [],
        };
      }

      await this.persistVerifiedHead(parsed, commit);

      return {
        isValid: true,
        ops: verifiedOps,
      };
    } catch (error) {
      if (isVerificationFailure(error)) {
        return error;
      }
      return invalid(
        "repo_state_invalid",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async resolveSigningKey(repoDid: string): Promise<SigningKeyMaterial> {
    const resolved = await this.identityResolver.resolveIdentity(repoDid);
    if (!resolved.success || !resolved.didDocument) {
      throw invalid("did_resolution_failed", resolved.reason ?? `Unable to resolve DID document for ${repoDid}`);
    }

    const didDocument = resolved.didDocument;
    if (didDocument["id"] !== repoDid) {
      throw invalid("did_resolution_failed", `Resolved DID document did not match ${repoDid}`);
    }

    const method = selectVerificationMethod(didDocument, repoDid);
    if (!method) {
      throw invalid("signature_invalid", `DID document for ${repoDid} did not expose a usable AT signing key`);
    }

    return buildSigningKeyMaterial(method, repoDid);
  }

  private async verifyAdvertisedOps(
    parsed: ParsedCommitEventBody,
    commit: CommitBlock,
    carBlocks: CarBlockStore,
  ): Promise<NonNullable<VerificationSuccess["ops"]>> {
    const currentTree = PartialMst.load(carBlocks, commit.data);
    let previousTree = currentTree;
    const verifiedOps: NonNullable<VerificationSuccess["ops"]> = [];

    for (const op of parsed.ops) {
      const currentCid = await currentTree.get(op.path);

      if (op.action === "create") {
        if (!op.cid) {
          throw invalid("repo_state_invalid", `Create op ${op.path} was missing a current CID`);
        }
        if (!currentCid || !currentCid.equals(op.cid)) {
          throw invalid("repo_state_invalid", `Create op ${op.path} did not match the current MST state`);
        }

        const record = parseRecordBlock(carBlocks.getRequired(op.cid), this.maxRecordBytes);
        previousTree = await previousTree.delete(op.path);
        verifiedOps.push({
          action: "create",
          collection: op.collection,
          rkey: op.rkey,
          cid: op.cid.toString(),
          record,
        });
        continue;
      }

      if (op.action === "update") {
        if (!op.cid || !op.prevCid) {
          throw invalid("repo_state_invalid", `Update op ${op.path} was missing current or previous CID`);
        }
        if (!currentCid || !currentCid.equals(op.cid)) {
          throw invalid("repo_state_invalid", `Update op ${op.path} did not match the current MST state`);
        }

        const record = parseRecordBlock(carBlocks.getRequired(op.cid), this.maxRecordBytes);
        previousTree = await previousTree.update(op.path, op.prevCid);
        verifiedOps.push({
          action: "update",
          collection: op.collection,
          rkey: op.rkey,
          cid: op.cid.toString(),
          record,
        });
        continue;
      }

      if (currentCid !== null) {
        throw invalid("repo_state_invalid", `Delete op ${op.path} still existed in the current MST state`);
      }
      if (!op.deletedCid) {
        throw invalid("repo_state_invalid", `Delete op ${op.path} was missing the deleted record CID`);
      }

      previousTree = await previousTree.add(op.path, op.deletedCid);
      verifiedOps.push({
        action: "delete",
        collection: op.collection,
        rkey: op.rkey,
        cid: null,
        record: null,
      });
    }

    if (parsed.ops.length === 0) {
      if (parsed.prevDataCid) {
        if (!parsed.prevDataCid.equals(commit.data)) {
          throw invalid("repo_state_invalid", "Commit advertised no ops but prevData did not equal the current data root");
        }
      } else if (!(await currentTree.isEmpty())) {
        throw invalid("repo_state_invalid", "Commit advertised no ops and omitted prevData for a non-empty repository state");
      }
      return verifiedOps;
    }

    if (parsed.prevDataCid) {
      const reconstructed = await previousTree.getPointer();
      if (!reconstructed.equals(parsed.prevDataCid)) {
        throw invalid("repo_state_invalid", "Advertised ops did not reconstruct the claimed prevData root");
      }
    } else if (!(await previousTree.isEmpty())) {
      throw invalid("repo_state_invalid", "Commit omitted prevData but the reconstructed previous repository state was not empty");
    }

    return verifiedOps;
  }

  private async checkContinuity(parsed: ParsedCommitEventBody): Promise<string | null> {
    const existing = await getRepoState(this.repoRegistry, parsed.repo);
    if (!existing) {
      return null;
    }

    if (parsed.since && existing.rev && compareRevisionStrings(existing.rev, parsed.rev) < 0 && existing.rev !== parsed.since) {
      return `Stored repo revision ${existing.rev} did not match commit since ${parsed.since}; authoritative sync rebuild required`;
    }

    if (
      parsed.prevDataCid &&
      existing.rootCid &&
      compareRevisionStrings(existing.rev, parsed.rev) < 0 &&
      existing.rootCid !== parsed.prevDataCid.toString()
    ) {
      return `Stored repo root ${existing.rootCid} did not match commit prevData ${parsed.prevDataCid.toString()}; authoritative sync rebuild required`;
    }

    return null;
  }

  private async persistVerifiedHead(parsed: ParsedCommitEventBody, commit: CommitBlock): Promise<void> {
    const existing = await getRepoState(this.repoRegistry, parsed.repo);
    if (existing && compareRevisionStrings(existing.rev, parsed.rev) >= 0) {
      return;
    }

    const nextState = buildVerifiedRepoState(existing, parsed, commit);

    try {
      if (existing) {
        await this.repoRegistry.update(nextState);
      } else {
        await this.repoRegistry.register(nextState);
      }
      return;
    } catch (error) {
      if (!isRecoverableRegistryRace(error)) {
        throw error;
      }
    }

    const latestExisting = await getRepoState(this.repoRegistry, parsed.repo);
    if (latestExisting && compareRevisionStrings(latestExisting.rev, parsed.rev) >= 0) {
      return;
    }

    const recoveredState = buildVerifiedRepoState(latestExisting, parsed, commit);
    if (latestExisting) {
      await this.repoRegistry.update(recoveredState);
    } else {
      await this.repoRegistry.register(recoveredState);
    }
  }
}

function buildVerifiedRepoState(
  existing: RepositoryState | null,
  parsed: ParsedCommitEventBody,
  commit: CommitBlock,
): RepositoryState {
  const now = new Date().toISOString();
  const signature = Buffer.from(commit.sig).toString("base64url");

  return existing
    ? {
        ...existing,
        rootCid: commit.data.toString(),
        rev: parsed.rev,
        status: "active",
        lastCommitAt: now,
        snapshotAt: now,
        updatedAt: now,
        commits: [
          {
            cid: parsed.commitCid.toString(),
            rootCid: commit.data.toString(),
            rev: parsed.rev,
            timestamp: now,
            signature,
            prevCid: existing.commits[0]?.cid,
          },
          ...existing.commits.filter((entry) => entry.rev !== parsed.rev).slice(0, MAX_COMMITS_TO_KEEP - 1),
        ],
      }
    : {
        did: parsed.repo,
        rootCid: commit.data.toString(),
        rev: parsed.rev,
        commits: [
          {
            cid: parsed.commitCid.toString(),
            rootCid: commit.data.toString(),
            rev: parsed.rev,
            timestamp: now,
            signature,
          },
        ],
        collections: [],
        totalRecords: 0,
        sizeBytes: parsed.blocks.length,
        status: "active",
        lastCommitAt: now,
        snapshotAt: now,
        createdAt: now,
        updatedAt: now,
      };
}

function parseCommitEventBody(
  input: unknown,
  limits: { maxCarBytes: number; maxOps: number },
): ParsedCommitEventBody {
  const body = requirePlainObject(input, "Commit payload must be a JSON-like object");
  const repo = requireString(body["repo"], "Commit payload was missing repo");
  ensureValidDid(repo);

  const rev = requireString(body["rev"], "Commit payload was missing rev");
  ensureValidTid(rev);

  const since = parseOptionalTid(body["since"], "since");
  const commitCid = parseRequiredCid(body["commit"], "commit");
  const prevDataCid = parseOptionalCid(body["prevData"], "prevData");
  const tooBig = typeof body["tooBig"] === "boolean" ? body["tooBig"] : false;
  const blocks = requireBytes(body["blocks"], "Commit payload was missing CAR blocks");

  if (blocks.byteLength > limits.maxCarBytes) {
    throw invalid("repo_state_invalid", `Commit CAR slice exceeded ${limits.maxCarBytes} bytes`);
  }

  const rawOps = body["ops"];
  if (!Array.isArray(rawOps)) {
    throw invalid("repo_state_invalid", "Commit payload was missing an ops array");
  }
  if (rawOps.length > limits.maxOps) {
    throw invalid("repo_state_invalid", `Commit payload exceeded ${limits.maxOps} advertised ops`);
  }

  const seenPaths = new Set<string>();
  const ops = rawOps.map((entry, index) => {
    const parsed = parseCommitOp(entry, index);
    if (seenPaths.has(parsed.path)) {
      throw invalid("repo_state_invalid", `Commit payload contained duplicate op path ${parsed.path}`);
    }
    seenPaths.add(parsed.path);
    return parsed;
  });

  return {
    repo,
    rev,
    since,
    commitCid,
    prevDataCid,
    tooBig,
    blocks,
    ops,
  };
}

function parseCommitOp(input: unknown, index: number): ParsedCommitOp {
  const record = requirePlainObject(input, `Commit op ${index} must be an object`);
  const action = record["action"];
  if (action !== "create" && action !== "update" && action !== "delete") {
    throw invalid("repo_state_invalid", `Commit op ${index} had unsupported action ${String(action)}`);
  }

  const path = requireString(record["path"], `Commit op ${index} was missing path`);
  const slashIndex = path.indexOf("/");
  if (slashIndex <= 0 || slashIndex !== path.lastIndexOf("/")) {
    throw invalid("repo_state_invalid", `Commit op ${index} had invalid path ${path}`);
  }

  const collection = path.slice(0, slashIndex);
  const rkey = path.slice(slashIndex + 1);
  ensureValidNsid(collection);
  ensureValidRecordKey(rkey);
  ensureValidMstKey(path);

  const cid = parseOptionalCid(record["cid"], `${path}.cid`);
  const prevCid = parseOptionalCid(record["prev"], `${path}.prev`);

  if (action === "create" && !cid) {
    throw invalid("repo_state_invalid", `Create op ${path} was missing cid`);
  }
  if (action === "update" && !cid) {
    throw invalid("repo_state_invalid", `Update op ${path} was missing cid`);
  }

  let deletedCid: CID | null = null;
  let requiresSyncReason: string | null = null;
  if (action === "update" && !prevCid) {
    requiresSyncReason =
      `Update op ${path} omitted prev CID; authoritative sync rebuild required`;
  }
  if (action === "delete") {
    if (cid && prevCid && !cid.equals(prevCid)) {
      throw invalid("repo_state_invalid", `Delete op ${path} contained conflicting cid and prev values`);
    }
    deletedCid = prevCid ?? cid;
    if (!deletedCid) {
      requiresSyncReason =
        `Delete op ${path} omitted previous record CID; authoritative sync rebuild required`;
    }
  }

  return {
    action,
    collection,
    rkey,
    path,
    cid,
    prevCid,
    deletedCid,
    requiresSyncReason,
  };
}

async function readCommitCarBlocks(
  commitCid: CID,
  bytes: Uint8Array,
  maxCarBlocks: number,
): Promise<CarBlockStore> {
  const reader = await CarReader.fromBytes(bytes);
  const roots = await reader.getRoots();
  if (roots.length === 0) {
    throw invalid("repo_state_invalid", "Commit CAR slice did not contain a root");
  }
  const firstRoot = parseRequiredCid(roots[0], "commit CAR root");
  if (!firstRoot.equals(commitCid)) {
    throw invalid("repo_state_invalid", `Commit CAR root did not match advertised commit ${String(commitCid)}`);
  }

  const store = new CarBlockStore();
  let blockCount = 0;
  for await (const block of reader.blocks()) {
    blockCount += 1;
    if (blockCount > maxCarBlocks) {
      throw invalid("repo_state_invalid", `Commit CAR slice exceeded ${maxCarBlocks} blocks`);
    }
    store.set(block.cid, block.bytes);
  }

  if (!store.has(commitCid)) {
    throw invalid("repo_state_invalid", "Commit CAR slice was missing the signed commit block");
  }

  return store;
}

function parseCommitBlock(
  expectedDid: string,
  expectedRev: string,
  expectedCommitCid: CID,
  bytes: Uint8Array,
): CommitBlock {
  const decoded = dagCbor.decode(bytes);
  const object = requirePlainObject(decoded, "Signed commit block was not a DAG-CBOR object");
  const did = requireString(object["did"], "Signed commit block was missing did");
  const version = object["version"];
  const data = parseRequiredCid(object["data"], "commit.data");
  const rev = requireString(object["rev"], "Signed commit block was missing rev");
  const prev = parseOptionalCid(object["prev"], "commit.prev");
  const sig = requireBytes(object["sig"], "Signed commit block was missing sig");

  ensureValidDid(did);
  ensureValidTid(rev);

  if (version !== 3) {
    throw invalid("repo_state_invalid", `Signed commit block ${expectedCommitCid.toString()} did not use repo version 3`);
  }
  if (did !== expectedDid) {
    throw invalid("repo_state_invalid", `Signed commit DID ${did} did not match advertised repo ${expectedDid}`);
  }
  if (rev !== expectedRev) {
    throw invalid("repo_state_invalid", `Signed commit rev ${rev} did not match advertised rev ${expectedRev}`);
  }

  const unsignedBytes = dagCbor.encode({
    did,
    version: 3,
    data,
    rev,
    prev,
  });

  return {
    did,
    version: 3,
    data,
    rev,
    prev,
    sig,
    unsignedBytes,
  };
}

function verifyCommitSignature(commit: CommitBlock, signingKey: SigningKeyMaterial): boolean {
  if (!isLowSignature(commit.sig, signingKey.curve)) {
    return false;
  }

  const verifier = createVerify("sha256");
  verifier.update(commit.unsignedBytes);
  verifier.end();

  try {
    return verifier.verify(
      {
        key: signingKey.keyObject,
        dsaEncoding: "ieee-p1363",
      },
      commit.sig,
    );
  } catch {
    return false;
  }
}

function selectVerificationMethod(
  didDocument: Record<string, unknown>,
  did: string,
): Record<string, unknown> | null {
  const verificationMethods = Array.isArray(didDocument["verificationMethod"])
    ? didDocument["verificationMethod"].filter(isObjectRecord)
    : [];

  if (verificationMethods.length === 0) {
    return null;
  }

  const byId = new Map<string, Record<string, unknown>>();
  for (const method of verificationMethods) {
    const id = typeof method["id"] === "string" ? method["id"] : null;
    if (!id) {
      continue;
    }
    const normalizedId = normalizeMethodId(did, id);
    if (!normalizedId) {
      continue;
    }
    byId.set(normalizedId, method);
  }

  const preferredIds: string[] = [];
  pushReferencedMethodIds(preferredIds, didDocument["assertionMethod"], did);
  pushReferencedMethodIds(preferredIds, didDocument["authentication"], did);
  for (const suffix of DID_KEY_SUFFIXES) {
    preferredIds.push(`${did}${suffix}`);
  }

  for (const candidateId of preferredIds) {
    const method = byId.get(candidateId);
    if (method && isUsableVerificationMethod(method, did)) {
      return method;
    }
  }

  for (const method of verificationMethods) {
    if (isUsableVerificationMethod(method, did)) {
      return method;
    }
  }

  return null;
}

function buildSigningKeyMaterial(
  method: Record<string, unknown>,
  did: string,
): SigningKeyMaterial {
  const methodId = normalizeMethodId(did, requireString(method["id"], "Verification method was missing id")) ?? did;

  if (typeof method["publicKeyMultibase"] === "string") {
    return buildMultibaseKeyMaterial(methodId, method["publicKeyMultibase"]);
  }

  if (isObjectRecord(method["publicKeyJwk"])) {
    return buildJwkKeyMaterial(methodId, method["publicKeyJwk"] as JsonWebKey);
  }

  if (typeof method["publicKeyPem"] === "string") {
    return buildPemKeyMaterial(methodId, method["publicKeyPem"]);
  }

  throw invalid("signature_invalid", `Verification method ${methodId} did not contain supported AT signing key material`);
}

function buildMultibaseKeyMaterial(keyId: string, publicKeyMultibase: string): SigningKeyMaterial {
  if (!publicKeyMultibase.startsWith("z")) {
    throw invalid("signature_invalid", `Verification method ${keyId} did not use base58btc multibase`);
  }

  const prefixedKeyBytes = base58btc.decode(publicKeyMultibase);
  const decoded = decodeKnownKeyMulticodec(prefixedKeyBytes);
  const keyType = decoded.keyType;
  const encodedPoint = decoded.encodedPoint;

  if (keyType === "secp256k1-pub") {
    return {
      keyId,
      curve: "secp256k1",
      keyObject: createEcKeyObject("secp256k1", "secp256k1", encodedPoint),
    };
  }

  if (keyType === "p256-pub") {
    return {
      keyId,
      curve: "p256",
      keyObject: createEcKeyObject("prime256v1", "P-256", encodedPoint),
    };
  }

  throw invalid("signature_invalid", `Verification method ${keyId} used unsupported multicodec ${keyType}`);
}

function decodeKnownKeyMulticodec(
  prefixedKeyBytes: Uint8Array
): {
  keyType: "secp256k1-pub" | "p256-pub";
  encodedPoint: Uint8Array;
} {
  if (hasPrefix(prefixedKeyBytes, SECP256K1_PUB_MULTICODEC)) {
    return {
      keyType: "secp256k1-pub",
      encodedPoint: prefixedKeyBytes.slice(SECP256K1_PUB_MULTICODEC.length),
    };
  }

  if (hasPrefix(prefixedKeyBytes, P256_PUB_MULTICODEC)) {
    return {
      keyType: "p256-pub",
      encodedPoint: prefixedKeyBytes.slice(P256_PUB_MULTICODEC.length),
    };
  }

  throw invalid("signature_invalid", "Verification method used unsupported key multicodec prefix");
}

function hasPrefix(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) {
    return false;
  }

  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix[i]) {
      return false;
    }
  }

  return true;
}

function buildJwkKeyMaterial(keyId: string, jwk: JsonWebKey): SigningKeyMaterial {
  const curve = normalizeCurveName(typeof jwk.crv === "string" ? jwk.crv : null);
  if (!curve) {
    throw invalid("signature_invalid", `Verification method ${keyId} used unsupported JWK curve ${String(jwk.crv)}`);
  }
  const keyObject = createPublicKey({
    key: jwk,
    format: "jwk",
  });
  return { keyId, curve, keyObject };
}

function buildPemKeyMaterial(keyId: string, pem: string): SigningKeyMaterial {
  const keyObject = createPublicKey(pem);
  let curve: SigningKeyMaterial["curve"] = null;

  try {
    const exported = keyObject.export({ format: "jwk" }) as JsonWebKey;
    curve = normalizeCurveName(typeof exported.crv === "string" ? exported.crv : null);
  } catch {
    curve = null;
  }

  if (!curve) {
    throw invalid("signature_invalid", `Verification method ${keyId} used unsupported PEM signing key material`);
  }

  return { keyId, curve, keyObject };
}

function createEcKeyObject(
  ecdhCurveName: "secp256k1" | "prime256v1",
  jwkCurveName: "secp256k1" | "P-256",
  encodedPoint: Uint8Array,
): KeyObject {
  const convertedPoint = ECDH.convertKey(
    Buffer.from(encodedPoint),
    ecdhCurveName,
    undefined,
    undefined,
    "uncompressed",
  );
  const uncompressed = Buffer.isBuffer(convertedPoint)
    ? convertedPoint
    : typeof convertedPoint === "string"
      ? Buffer.from(convertedPoint, "binary")
      : Buffer.from(convertedPoint);

  if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) {
    throw invalid("signature_invalid", `Unsupported EC point encoding for ${jwkCurveName}`);
  }

  const x = Buffer.from(uncompressed.subarray(1, 33)).toString("base64url");
  const y = Buffer.from(uncompressed.subarray(33)).toString("base64url");
  return createPublicKey({
    key: {
      kty: "EC",
      crv: jwkCurveName,
      x,
      y,
    },
    format: "jwk",
  });
}

function parseRecordBlock(bytes: Uint8Array, maxRecordBytes: number): Record<string, unknown> {
  if (bytes.byteLength > maxRecordBytes) {
    throw invalid("repo_state_invalid", `Record block exceeded ${maxRecordBytes} bytes`);
  }

  const decoded = dagCbor.decode(bytes);
  const jsonSafe = sanitizeJsonObject(ipldToJson(decoded), {
    maxBytes: maxRecordBytes,
    maxDepth: 24,
    maxNodes: 20_000,
    maxArrayLength: 4_000,
    maxObjectKeys: 4_000,
  });

  return jsonSafe;
}

async function getRepoState(
  repoRegistry: AtprotoRepoRegistry,
  did: string,
): Promise<RepositoryState | null> {
  if (typeof repoRegistry.getRepoState === "function") {
    return repoRegistry.getRepoState(did);
  }
  return repoRegistry.getByDid(did);
}

function compareRevisionStrings(left: string, right: string): number {
  try {
    return TID.fromStr(left).compareTo(TID.fromStr(right));
  } catch {
    if (left === right) {
      return 0;
    }
    return left < right ? -1 : 1;
  }
}

function parseOptionalTid(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const tid = requireString(value, `${fieldName} must be a string`);
  ensureValidTid(tid);
  return tid;
}

function parseRequiredCid(value: unknown, fieldName: string): CID {
  const cid = parseOptionalCid(value, fieldName);
  if (!cid) {
    throw invalid("repo_state_invalid", `${fieldName} must be a CID`);
  }
  return cid;
}

function parseOptionalCid(value: unknown, fieldName: string): CID | null {
  if (value === null || value === undefined) {
    return null;
  }
  const cid = CID.asCID(value);
  if (cid) {
    return cid;
  }
  if (typeof value === "string") {
    try {
      return CID.parse(value);
    } catch {
      throw invalid("repo_state_invalid", `${fieldName} contained an invalid CID string`);
    }
  }
  throw invalid("repo_state_invalid", `${fieldName} must be a CID`);
}

function requirePlainObject(value: unknown, message: string): Record<string, unknown> {
  if (!isObjectRecord(value)) {
    throw invalid("repo_state_invalid", message);
  }
  return value;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalid("repo_state_invalid", message);
  }
  return value;
}

function requireBytes(value: unknown, message: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw invalid("repo_state_invalid", message);
  }
  return value;
}

function pushReferencedMethodIds(
  output: string[],
  rawRefs: unknown,
  did: string,
): void {
  if (!Array.isArray(rawRefs)) {
    return;
  }
  for (const entry of rawRefs) {
    if (typeof entry === "string") {
      const normalized = normalizeMethodId(did, entry);
      if (normalized) {
        output.push(normalized);
      }
    } else if (isObjectRecord(entry) && typeof entry["id"] === "string") {
      const normalized = normalizeMethodId(did, entry["id"]);
      if (normalized) {
        output.push(normalized);
      }
    }
  }
}

function normalizeMethodId(did: string, value: string): string | null {
  if (value.startsWith("#")) {
    return `${did}${value}`;
  }
  if (value.startsWith(`${did}#`)) {
    return value;
  }
  return null;
}

function isUsableVerificationMethod(
  method: Record<string, unknown>,
  did: string,
): boolean {
  const controller = method["controller"];
  if (typeof controller === "string" && controller !== did) {
    return false;
  }
  return (
    typeof method["publicKeyMultibase"] === "string" ||
    isObjectRecord(method["publicKeyJwk"]) ||
    typeof method["publicKeyPem"] === "string"
  );
}

function normalizeCurveName(curve: string | null): SigningKeyMaterial["curve"] {
  if (curve === "secp256k1") {
    return "secp256k1";
  }
  if (curve === "P-256" || curve === "prime256v1") {
    return "p256";
  }
  return null;
}

function isLowSignature(
  signature: Uint8Array,
  curve: SigningKeyMaterial["curve"],
): boolean {
  if (!curve) {
    return false;
  }
  if (signature.length !== 64) {
    return false;
  }

  const order = curve === "secp256k1" ? SECP256K1_ORDER : P256_ORDER;
  const r = bytesToBigInt(signature.subarray(0, 32));
  const s = bytesToBigInt(signature.subarray(32));
  if (r <= 0n || r >= order || s <= 0n || s >= order) {
    return false;
  }
  return s <= order / 2n;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  return BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
}

function invalid(failureReason: CommitFailureReason, reason: string): VerificationFailure {
  return {
    isValid: false,
    failureReason,
    reason,
  };
}

function isVerificationFailure(value: unknown): value is VerificationFailure {
  return !!value && typeof value === "object" && (value as VerificationFailure).isValid === false;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array);
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function isRecoverableRegistryRace(error: unknown): boolean {
  return error instanceof RegistryError && (
    error.code === RegistryErrorCode.ALREADY_EXISTS
    || error.code === RegistryErrorCode.NOT_FOUND
  );
}

function ensureValidMstKey(key: string): void {
  if (!MST_KEY_REGEX.test(key) || key.length > 1024) {
    throw invalid("repo_state_invalid", `Invalid MST key ${key}`);
  }
}

async function leadingZerosOnHash(key: string): Promise<number> {
  const digest = await sha256.digest(Buffer.from(key, "ascii"));
  const hash = digest.digest;
  let leadingZeros = 0;
  for (let i = 0; i < hash.length; i += 1) {
    const byte = hash[i];
    if (byte === undefined) {
      break;
    }
    if (byte < 64) leadingZeros += 1;
    if (byte < 16) leadingZeros += 1;
    if (byte < 4) leadingZeros += 1;
    if (byte === 0) {
      leadingZeros += 1;
    } else {
      break;
    }
  }
  return leadingZeros;
}

function toAscii(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("ascii");
}

function fromAscii(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "ascii"));
}

function countPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

async function cidForDagCborValue(value: unknown): Promise<CID> {
  const bytes = dagCbor.encode(value);
  return CID.createV1(DAG_CBOR_CODEC, await sha256.digest(bytes));
}

type MstNodeData = {
  l: CID | null;
  e: Array<{
    p: number;
    k: Uint8Array;
    v: CID;
    t: CID | null;
  }>;
};

class MissingBlockError extends Error {
  public constructor(cid: CID, kind: string) {
    super(`Missing ${kind} block ${cid.toString()}`);
    this.name = "MissingBlockError";
  }
}

class CarBlockStore {
  private readonly blocks = new Map<string, Uint8Array>();

  public set(cid: CID, bytes: Uint8Array): void {
    this.blocks.set(cid.toString(), bytes);
  }

  public has(cid: CID): boolean {
    return this.blocks.has(cid.toString());
  }

  public getRequired(cid: CID): Uint8Array {
    const bytes = this.blocks.get(cid.toString());
    if (!bytes) {
      throw new MissingBlockError(cid, "CAR");
    }
    return bytes;
  }

  public async readNode(cid: CID): Promise<MstNodeData> {
    const decoded = dagCbor.decode(this.getRequired(cid));
    const data = requirePlainObject(decoded, `MST node ${cid.toString()} was not a DAG-CBOR object`);
    const left = parseOptionalCid(data["l"], `${cid.toString()}.l`);
    const rawEntries = data["e"];
    if (!Array.isArray(rawEntries)) {
      throw invalid("repo_state_invalid", `MST node ${cid.toString()} was missing entry array`);
    }

    return {
      l: left,
      e: rawEntries.map((entry, index) => {
        const record = requirePlainObject(entry, `MST entry ${cid.toString()}[${index}] was invalid`);
        const prefix = record["p"];
        if (typeof prefix !== "number" || !Number.isInteger(prefix) || prefix < 0) {
          throw invalid("repo_state_invalid", `MST entry ${cid.toString()}[${index}] had invalid prefix`);
        }
        return {
          p: prefix,
          k: requireBytes(record["k"], `MST entry ${cid.toString()}[${index}] was missing key suffix bytes`),
          v: parseRequiredCid(record["v"], `${cid.toString()}[${index}].v`),
          t: parseOptionalCid(record["t"], `${cid.toString()}[${index}].t`),
        };
      }),
    };
  }
}

class MstLeaf {
  public constructor(
    public readonly key: string,
    public readonly value: CID,
  ) {}

  public isTree(): this is PartialMst {
    return false;
  }

  public isLeaf(): this is MstLeaf {
    return true;
  }
}

type MstEntry = PartialMst | MstLeaf;

class PartialMst {
  private entries: MstEntry[] | null;
  private layer: number | null;
  private pointer: CID;
  private outdatedPointer = false;

  private constructor(
    private readonly store: CarBlockStore,
    pointer: CID,
    entries: MstEntry[] | null,
    layer: number | null,
  ) {
    this.pointer = pointer;
    this.entries = entries;
    this.layer = layer;
  }

  public static async create(
    store: CarBlockStore,
    entries: MstEntry[] = [],
    layer: number | null = null,
  ): Promise<PartialMst> {
    const pointer = await cidForNodeEntries(entries);
    return new PartialMst(store, pointer, entries, layer);
  }

  public static load(store: CarBlockStore, cid: CID, layer: number | null = null): PartialMst {
    return new PartialMst(store, cid, null, layer);
  }

  public async isEmpty(): Promise<boolean> {
    return (await this.getEntries()).length === 0;
  }

  public async get(key: string): Promise<CID | null> {
    const index = await this.findGtOrEqualLeafIndex(key);
    const found = await this.atIndex(index);
    if (found && found.isLeaf() && found.key === key) {
      return found.value;
    }

    const previous = await this.atIndex(index - 1);
    if (previous && previous.isTree()) {
      return previous.get(key);
    }

    return null;
  }

  public async add(key: string, value: CID, knownZeros?: number): Promise<PartialMst> {
    ensureValidMstKey(key);
    const keyZeros = knownZeros ?? (await leadingZerosOnHash(key));
    const layer = await this.getLayer();
    const newLeaf = new MstLeaf(key, value);

    if (keyZeros === layer) {
      const index = await this.findGtOrEqualLeafIndex(key);
      const found = await this.atIndex(index);
      if (found?.isLeaf() && found.key === key) {
        throw invalid("repo_state_invalid", `There is already a value at key ${key}`);
      }

      const previous = await this.atIndex(index - 1);
      if (!previous || previous.isLeaf()) {
        return this.spliceIn(newLeaf, index);
      }

      const split = await previous.splitAround(key);
      return this.replaceWithSplit(index - 1, split[0], newLeaf, split[1]);
    }

    if (keyZeros < layer) {
      const index = await this.findGtOrEqualLeafIndex(key);
      const previous = await this.atIndex(index - 1);
      if (previous && previous.isTree()) {
        const nextTree = await previous.add(key, value, keyZeros);
        return this.updateEntry(index - 1, nextTree);
      }

      const child = await this.createChild();
      const nextChild = await child.add(key, value, keyZeros);
      return this.spliceIn(nextChild, index);
    }

    const split = await this.splitAround(key);
    let left = split[0];
    let right = split[1];
    const extraLayers = keyZeros - layer;
    for (let index = 1; index < extraLayers; index += 1) {
      if (left) {
        left = await left.createParent();
      }
      if (right) {
        right = await right.createParent();
      }
    }

    const entries: MstEntry[] = [];
    if (left) entries.push(left);
    entries.push(newLeaf);
    if (right) entries.push(right);

    const root = await PartialMst.create(this.store, entries, keyZeros);
    root.outdatedPointer = true;
    return root;
  }

  public async update(key: string, value: CID): Promise<PartialMst> {
    ensureValidMstKey(key);
    const index = await this.findGtOrEqualLeafIndex(key);
    const found = await this.atIndex(index);
    if (found && found.isLeaf() && found.key === key) {
      return this.updateEntry(index, new MstLeaf(key, value));
    }

    const previous = await this.atIndex(index - 1);
    if (previous && previous.isTree()) {
      const nextTree = await previous.update(key, value);
      return this.updateEntry(index - 1, nextTree);
    }

    throw invalid("repo_state_invalid", `Could not find a record with key ${key}`);
  }

  public async delete(key: string): Promise<PartialMst> {
    const altered = await this.deleteRecurse(key);
    return altered.trimTop();
  }

  public async getPointer(): Promise<CID> {
    if (!this.outdatedPointer) {
      return this.pointer;
    }
    const { cid } = await this.serialize();
    this.pointer = cid;
    this.outdatedPointer = false;
    return this.pointer;
  }

  public isTree(): this is PartialMst {
    return true;
  }

  public isLeaf(): this is MstLeaf {
    return false;
  }

  private async getEntries(): Promise<MstEntry[]> {
    if (this.entries) {
      return [...this.entries];
    }

    const data = await this.store.readNode(this.pointer);
    const firstLeaf = data.e[0];
    const layer = firstLeaf ? await leadingZerosOnHash(toAscii(firstLeaf.k)) : undefined;
    this.entries = await deserializeNodeData(this.store, data, layer);
    return [...this.entries];
  }

  private async serialize(): Promise<{ cid: CID; bytes: Uint8Array }> {
    let entries = await this.getEntries();
    const outdated = entries.filter((entry): entry is PartialMst => entry.isTree() && entry.outdatedPointer);
    if (outdated.length > 0) {
      await Promise.all(outdated.map((entry) => entry.getPointer()));
      entries = await this.getEntries();
    }

    const data = serializeNodeData(entries);
    const bytes = dagCbor.encode(data);
    return {
      cid: CID.createV1(DAG_CBOR_CODEC, await sha256.digest(bytes)),
      bytes,
    };
  }

  private async getLayer(): Promise<number> {
    this.layer = await this.attemptGetLayer();
    if (this.layer === null) {
      this.layer = 0;
    }
    return this.layer;
  }

  private async attemptGetLayer(): Promise<number | null> {
    if (this.layer !== null) {
      return this.layer;
    }

    const entries = await this.getEntries();
    let layer = await layerForEntries(entries);
    if (layer === null) {
      for (const entry of entries) {
        if (!entry.isTree()) {
          continue;
        }
        const childLayer = await entry.attemptGetLayer();
        if (childLayer !== null) {
          layer = childLayer + 1;
          break;
        }
      }
    }

    if (layer !== null) {
      this.layer = layer;
    }
    return layer;
  }

  private async deleteRecurse(key: string): Promise<PartialMst> {
    const index = await this.findGtOrEqualLeafIndex(key);
    const found = await this.atIndex(index);
    if (found?.isLeaf() && found.key === key) {
      const previous = await this.atIndex(index - 1);
      const next = await this.atIndex(index + 1);
      if (previous?.isTree() && next?.isTree()) {
        const merged = await previous.appendMerge(next);
        return this.newTree([
          ...(await this.slice(0, index - 1)),
          merged,
          ...(await this.slice(index + 2)),
        ]);
      }
      return this.removeEntry(index);
    }

    const previous = await this.atIndex(index - 1);
    if (previous?.isTree()) {
      const subtree = await previous.deleteRecurse(key);
      if (await subtree.isEmpty()) {
        return this.removeEntry(index - 1);
      }
      return this.updateEntry(index - 1, subtree);
    }

    throw invalid("repo_state_invalid", `Could not find a record with key ${key}`);
  }

  private async updateEntry(index: number, entry: MstEntry): Promise<PartialMst> {
    return this.newTree([
      ...(await this.slice(0, index)),
      entry,
      ...(await this.slice(index + 1)),
    ]);
  }

  private async removeEntry(index: number): Promise<PartialMst> {
    return this.newTree([
      ...(await this.slice(0, index)),
      ...(await this.slice(index + 1)),
    ]);
  }

  private async append(entry: MstEntry): Promise<PartialMst> {
    const entries = await this.getEntries();
    return this.newTree([...entries, entry]);
  }

  private async prepend(entry: MstEntry): Promise<PartialMst> {
    const entries = await this.getEntries();
    return this.newTree([entry, ...entries]);
  }

  private async atIndex(index: number): Promise<MstEntry | null> {
    const entries = await this.getEntries();
    return entries[index] ?? null;
  }

  private async slice(start?: number, end?: number): Promise<MstEntry[]> {
    const entries = await this.getEntries();
    return entries.slice(start, end);
  }

  private async spliceIn(entry: MstEntry, index: number): Promise<PartialMst> {
    return this.newTree([
      ...(await this.slice(0, index)),
      entry,
      ...(await this.slice(index)),
    ]);
  }

  private async replaceWithSplit(
    index: number,
    left: PartialMst | null,
    leaf: MstLeaf,
    right: PartialMst | null,
  ): Promise<PartialMst> {
    const updated = await this.slice(0, index);
    if (left) updated.push(left);
    updated.push(leaf);
    if (right) updated.push(right);
    updated.push(...(await this.slice(index + 1)));
    return this.newTree(updated);
  }

  private async trimTop(): Promise<PartialMst> {
    const entries = await this.getEntries();
    const firstEntry = entries[0];
    if (entries.length === 1 && firstEntry?.isTree()) {
      return firstEntry.trimTop();
    }
    return this;
  }

  private async splitAround(key: string): Promise<[PartialMst | null, PartialMst | null]> {
    const index = await this.findGtOrEqualLeafIndex(key);
    const leftEntries = await this.slice(0, index);
    const rightEntries = await this.slice(index);
    let left = await this.newTree(leftEntries);
    let right = await this.newTree(rightEntries);

    const lastLeft = leftEntries[leftEntries.length - 1];
    if (lastLeft?.isTree()) {
      left = await left.removeEntry(leftEntries.length - 1);
      const split = await lastLeft.splitAround(key);
      if (split[0]) {
        left = await left.append(split[0]);
      }
      if (split[1]) {
        right = await right.prepend(split[1]);
      }
    }

    return [
      (await left.isEmpty()) ? null : left,
      (await right.isEmpty()) ? null : right,
    ];
  }

  private async appendMerge(toMerge: PartialMst): Promise<PartialMst> {
    if ((await this.getLayer()) !== (await toMerge.getLayer())) {
      throw invalid("repo_state_invalid", "Attempted to merge MST nodes from different layers");
    }

    const leftEntries = await this.getEntries();
    const rightEntries = await toMerge.getEntries();
    const lastLeft = leftEntries[leftEntries.length - 1];
    const firstRight = rightEntries[0];
    if (lastLeft?.isTree() && firstRight?.isTree()) {
      const merged = await lastLeft.appendMerge(firstRight);
      return this.newTree([
        ...leftEntries.slice(0, leftEntries.length - 1),
        merged,
        ...rightEntries.slice(1),
      ]);
    }

    return this.newTree([...leftEntries, ...rightEntries]);
  }

  private async createChild(): Promise<PartialMst> {
    const layer = await this.getLayer();
    return PartialMst.create(this.store, [], layer - 1);
  }

  private async createParent(): Promise<PartialMst> {
    const layer = await this.getLayer();
    const parent = await PartialMst.create(this.store, [this], layer + 1);
    parent.outdatedPointer = true;
    return parent;
  }

  private async findGtOrEqualLeafIndex(key: string): Promise<number> {
    const entries = await this.getEntries();
    const index = entries.findIndex((entry) => entry.isLeaf() && entry.key >= key);
    return index >= 0 ? index : entries.length;
  }

  private async newTree(entries: MstEntry[]): Promise<PartialMst> {
    const next = new PartialMst(this.store, this.pointer, entries, this.layer);
    next.outdatedPointer = true;
    return next;
  }
}

async function layerForEntries(entries: MstEntry[]): Promise<number | null> {
  const firstLeaf = entries.find((entry): entry is MstLeaf => entry.isLeaf());
  if (!firstLeaf) {
    return null;
  }
  return leadingZerosOnHash(firstLeaf.key);
}

async function cidForNodeEntries(entries: MstEntry[]): Promise<CID> {
  return cidForDagCborValue(serializeNodeData(entries));
}

function serializeNodeData(entries: MstEntry[]): MstNodeData {
  const data: MstNodeData = { l: null, e: [] };
  let index = 0;
  if (entries[0]?.isTree()) {
    data.l = (entries[0] as PartialMst)["pointer"];
    index += 1;
  }

  let lastKey = "";
  while (index < entries.length) {
    const leaf = entries[index];
    const next = entries[index + 1];
    if (!leaf || !leaf.isLeaf()) {
      throw invalid("repo_state_invalid", "Invalid MST node serialization state");
    }

    let subtree: CID | null = null;
    if (next?.isTree()) {
      subtree = (next as PartialMst)["pointer"];
      index += 1;
    }

    const prefix = countPrefixLength(lastKey, leaf.key);
    data.e.push({
      p: prefix,
      k: fromAscii(leaf.key.slice(prefix)),
      v: leaf.value,
      t: subtree,
    });
    lastKey = leaf.key;
    index += 1;
  }

  return data;
}

async function deserializeNodeData(
  store: CarBlockStore,
  data: MstNodeData,
  layer: number | undefined,
): Promise<MstEntry[]> {
  const entries: MstEntry[] = [];
  if (data.l) {
    entries.push(PartialMst.load(store, data.l, layer !== undefined ? layer - 1 : null));
  }

  let lastKey = "";
  for (const entry of data.e) {
    const suffix = toAscii(entry.k);
    const key = `${lastKey.slice(0, entry.p)}${suffix}`;
    ensureValidMstKey(key);
    entries.push(new MstLeaf(key, entry.v));
    lastKey = key;

    if (entry.t) {
      entries.push(PartialMst.load(store, entry.t, layer !== undefined ? layer - 1 : null));
    }
  }

  return entries;
}
