import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { TID, type DidDocument } from "@atproto/common-web";
import { CarWriter } from "@ipld/car";
import * as dagCbor from "@ipld/dag-cbor";
import { sha256 } from "multiformats/hashes/sha2";
import { CID } from "multiformats/cid";
import {
  InMemoryAtprotoRepoRegistry,
  RegistryError,
  RegistryErrorCode,
  type AtprotoRepoRegistry,
} from "../../atproto/repo/AtprotoRepoRegistry.js";
import { ProductionAtCommitVerifier } from "../ingress/ProductionAtCommitVerifier.js";

const DID = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
const P256_ORDER = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");

describe("ProductionAtCommitVerifier", () => {
  it("accepts a valid signed create commit and persists the verified head", async () => {
    const signer = createDidSigner();
    const repoRegistry = new InMemoryAtprotoRepoRegistry();
    const verifier = new ProductionAtCommitVerifier({
      identityResolver: createIdentityResolver(DID, signer.publicJwk),
      repoRegistry,
    });

    const path = `app.bsky.feed.post/${TID.nextStr()}`;
    const recordBlock = await createDagCborBlock({
      $type: "app.bsky.feed.post",
      text: "hello from the verifier proof",
      createdAt: "2026-04-03T12:00:00.000Z",
    });
    const rootBlock = await createMstRoot([{ key: path, value: recordBlock.cid }]);
    const rev = TID.nextStr();
    const commitBlock = await createSignedCommitBlock({
      signer: signer.privateKey,
      did: DID,
      rev,
      data: rootBlock.cid,
      prev: null,
    });

    const result = await verifier.verifyCommit({
      repo: DID,
      rev,
      since: null,
      commit: commitBlock.cid,
      prevData: null,
      tooBig: false,
      blocks: await encodeCar(commitBlock.cid, [commitBlock, rootBlock, recordBlock]),
      ops: [
        {
          action: "create",
          path,
          cid: recordBlock.cid,
        },
      ],
    });

    if (!result.isValid || result.requiresSync) {
      throw new Error(`Expected valid commit result, received ${JSON.stringify(result)}`);
    }

    expect(result.ops).toEqual([
      {
        action: "create",
        collection: "app.bsky.feed.post",
        rkey: path.split("/")[1],
        cid: recordBlock.cid.toString(),
        record: {
          $type: "app.bsky.feed.post",
          text: "hello from the verifier proof",
          createdAt: "2026-04-03T12:00:00.000Z",
        },
      },
    ]);

    const state = await repoRegistry.getRepoState(DID);
    expect(state).toMatchObject({
      did: DID,
      rootCid: rootBlock.cid.toString(),
      rev,
      status: "active",
    });
    expect(state?.commits[0]).toMatchObject({
      cid: commitBlock.cid.toString(),
      rootCid: rootBlock.cid.toString(),
      rev,
    });
  });

  it("rejects commits whose signature does not match the DID signing key", async () => {
    const expectedSigner = createDidSigner();
    const actualSigner = createDidSigner();
    const verifier = new ProductionAtCommitVerifier({
      identityResolver: createIdentityResolver(DID, expectedSigner.publicJwk),
      repoRegistry: new InMemoryAtprotoRepoRegistry(),
    });

    const path = `app.bsky.feed.post/${TID.nextStr()}`;
    const recordBlock = await createDagCborBlock({
      $type: "app.bsky.feed.post",
      text: "forged signature",
      createdAt: "2026-04-03T12:00:00.000Z",
    });
    const rootBlock = await createMstRoot([{ key: path, value: recordBlock.cid }]);
    const rev = TID.nextStr();
    const commitBlock = await createSignedCommitBlock({
      signer: actualSigner.privateKey,
      did: DID,
      rev,
      data: rootBlock.cid,
      prev: null,
    });

    const result = await verifier.verifyCommit({
      repo: DID,
      rev,
      since: null,
      commit: commitBlock.cid,
      prevData: null,
      tooBig: false,
      blocks: await encodeCar(commitBlock.cid, [commitBlock, rootBlock, recordBlock]),
      ops: [
        {
          action: "create",
          path,
          cid: recordBlock.cid,
        },
      ],
    });

    expect(result.isValid).toBe(false);
    if (result.isValid) {
      throw new Error("Expected invalid signature result");
    }
    expect(result.failureReason).toBe("signature_invalid");
    expect(result.reason).toMatch(/signature did not verify/i);
  });

  it("rejects advertised ops that cannot be proven from the commit CAR slice", async () => {
    const signer = createDidSigner();
    const verifier = new ProductionAtCommitVerifier({
      identityResolver: createIdentityResolver(DID, signer.publicJwk),
      repoRegistry: new InMemoryAtprotoRepoRegistry(),
    });

    const actualPath = `app.bsky.feed.post/${TID.nextStr()}`;
    const forgedPath = `app.bsky.feed.post/${TID.nextStr()}`;
    const recordBlock = await createDagCborBlock({
      $type: "app.bsky.feed.post",
      text: "proof against forged ops",
      createdAt: "2026-04-03T12:00:00.000Z",
    });
    const rootBlock = await createMstRoot([{ key: actualPath, value: recordBlock.cid }]);
    const rev = TID.nextStr();
    const commitBlock = await createSignedCommitBlock({
      signer: signer.privateKey,
      did: DID,
      rev,
      data: rootBlock.cid,
      prev: null,
    });

    const result = await verifier.verifyCommit({
      repo: DID,
      rev,
      since: null,
      commit: commitBlock.cid,
      prevData: null,
      tooBig: false,
      blocks: await encodeCar(commitBlock.cid, [commitBlock, rootBlock, recordBlock]),
      ops: [
        {
          action: "create",
          path: forgedPath,
          cid: recordBlock.cid,
        },
      ],
    });

    expect(result.isValid).toBe(false);
    if (result.isValid) {
      throw new Error("Expected repo_state_invalid result");
    }
    expect(result.failureReason).toBe("repo_state_invalid");
    expect(result.reason).toMatch(/current MST state/i);
  });

  it("requires an authoritative sync rebuild for tooBig commits even when the signature is valid", async () => {
    const signer = createDidSigner();
    const verifier = new ProductionAtCommitVerifier({
      identityResolver: createIdentityResolver(DID, signer.publicJwk),
      repoRegistry: new InMemoryAtprotoRepoRegistry(),
    });

    const emptyRoot = await createMstRoot([]);
    const rev = TID.nextStr();
    const commitBlock = await createSignedCommitBlock({
      signer: signer.privateKey,
      did: DID,
      rev,
      data: emptyRoot.cid,
      prev: null,
    });

    const result = await verifier.verifyCommit({
      repo: DID,
      rev,
      since: null,
      commit: commitBlock.cid,
      prevData: null,
      tooBig: true,
      blocks: await encodeCar(commitBlock.cid, [commitBlock, emptyRoot]),
      ops: [],
    });

    expect(result).toMatchObject({
      isValid: true,
      requiresSync: true,
    });
    if (!result.isValid || !result.requiresSync) {
      throw new Error(`Expected requiresSync result, received ${JSON.stringify(result)}`);
    }
    expect(result.reason).toMatch(/tooBig/i);
  });

  it("requires sync for signed update commits that omit prev CID in the advertised ops", async () => {
    const signer = createDidSigner();
    const verifier = new ProductionAtCommitVerifier({
      identityResolver: createIdentityResolver(DID, signer.publicJwk),
      repoRegistry: new InMemoryAtprotoRepoRegistry(),
    });

    const path = `place.stream.live.viewerCount/${DID}::did:web:prod-chi0.stream.place`;
    const currentRecordBlock = await createDagCborBlock({
      $type: "place.stream.live.viewerCount",
      count: 42,
      updatedAt: "2026-04-03T12:10:00.000Z",
    });
    const currentRoot = await createMstRoot([{ key: path, value: currentRecordBlock.cid }]);
    const rev = TID.nextStr();
    const commitBlock = await createSignedCommitBlock({
      signer: signer.privateKey,
      did: DID,
      rev,
      data: currentRoot.cid,
      prev: null,
    });

    const result = await verifier.verifyCommit({
      repo: DID,
      rev,
      since: null,
      commit: commitBlock.cid,
      prevData: null,
      tooBig: false,
      blocks: await encodeCar(commitBlock.cid, [commitBlock, currentRoot, currentRecordBlock]),
      ops: [
        {
          action: "update",
          path,
          cid: currentRecordBlock.cid,
        },
      ],
    });

    expect(result).toMatchObject({
      isValid: true,
      requiresSync: true,
    });
    if (!result.isValid || !result.requiresSync) {
      throw new Error(`Expected requiresSync result for missing prev CID, received ${JSON.stringify(result)}`);
    }
    expect(result.reason).toMatch(/omitted prev CID/i);
  });

  it("requires sync when the stored repo head does not match the commit prevData", async () => {
    const signer = createDidSigner();
    const repoRegistry = new InMemoryAtprotoRepoRegistry();
    const verifier = new ProductionAtCommitVerifier({
      identityResolver: createIdentityResolver(DID, signer.publicJwk),
      repoRegistry,
    });

    const path = `app.bsky.feed.post/${TID.nextStr()}`;
    const previousRecordBlock = await createDagCborBlock({
      $type: "app.bsky.feed.post",
      text: "before",
      createdAt: "2026-04-03T12:00:00.000Z",
    });
    const currentRecordBlock = await createDagCborBlock({
      $type: "app.bsky.feed.post",
      text: "after",
      createdAt: "2026-04-03T12:10:00.000Z",
    });
    const previousRoot = await createMstRoot([{ key: path, value: previousRecordBlock.cid }]);
    const currentRoot = await createMstRoot([{ key: path, value: currentRecordBlock.cid }]);
    const unrelatedRoot = await createMstRoot([
      {
        key: `app.bsky.feed.post/${TID.nextStr()}`,
        value: currentRecordBlock.cid,
      },
    ]);
    const previousRev = TID.nextStr();
    const currentRev = TID.nextStr();
    const commitBlock = await createSignedCommitBlock({
      signer: signer.privateKey,
      did: DID,
      rev: currentRev,
      data: currentRoot.cid,
      prev: null,
    });

    await repoRegistry.register({
      did: DID,
      rootCid: unrelatedRoot.cid.toString(),
      rev: previousRev,
      commits: [],
      collections: [],
      totalRecords: 1,
      sizeBytes: 0,
      status: "active",
      lastCommitAt: "2026-04-03T12:00:00.000Z",
      snapshotAt: "2026-04-03T12:00:00.000Z",
      createdAt: "2026-04-03T12:00:00.000Z",
      updatedAt: "2026-04-03T12:00:00.000Z",
    });

    const result = await verifier.verifyCommit({
      repo: DID,
      rev: currentRev,
      since: previousRev,
      commit: commitBlock.cid,
      prevData: previousRoot.cid,
      tooBig: false,
      blocks: await encodeCar(commitBlock.cid, [
        commitBlock,
        currentRoot,
        previousRoot,
        currentRecordBlock,
      ]),
      ops: [
        {
          action: "update",
          path,
          cid: currentRecordBlock.cid,
          prev: previousRecordBlock.cid,
        },
      ],
    });

    expect(result).toMatchObject({
      isValid: true,
      requiresSync: true,
    });
    if (!result.isValid || !result.requiresSync) {
      throw new Error(`Expected continuity requiresSync result, received ${JSON.stringify(result)}`);
    }
    expect(result.reason).toMatch(/authoritative sync rebuild required/i);
  });

  it("accepts a valid commit when repo-head persistence races with another writer", async () => {
    const signer = createDidSigner();
    const path = `app.bsky.feed.post/${TID.nextStr()}`;
    const recordBlock = await createDagCborBlock({
      $type: "app.bsky.feed.post",
      text: "concurrent persist race",
      createdAt: "2026-04-03T13:00:00.000Z",
    });
    const rootBlock = await createMstRoot([{ key: path, value: recordBlock.cid }]);
    const rev = TID.nextStr();
    const commitBlock = await createSignedCommitBlock({
      signer: signer.privateKey,
      did: DID,
      rev,
      data: rootBlock.cid,
      prev: null,
    });

    let storedState: any = null;
    let getCalls = 0;
    const repoRegistry: AtprotoRepoRegistry = {
      register: vi.fn(async (state) => {
        storedState = state;
        throw new RegistryError(
          RegistryErrorCode.ALREADY_EXISTS,
          `Repository already exists: ${state.did}`,
        );
      }),
      getByDid: vi.fn(async () => null),
      getRepoState: vi.fn(async () => {
        getCalls += 1;
        return getCalls === 1 ? null : storedState;
      }),
      update: vi.fn(async (state) => {
        storedState = state;
      }),
      delete: vi.fn(async () => false),
      list: vi.fn(async () => []),
      count: vi.fn(async () => 1),
      exists: vi.fn(async () => true),
      getByCollection: vi.fn(async () => []),
      getWithPendingCommits: vi.fn(async () => []),
      transaction: vi.fn(async (callback) => callback(repoRegistry)),
      health: vi.fn(async () => true),
    };

    const verifier = new ProductionAtCommitVerifier({
      identityResolver: createIdentityResolver(DID, signer.publicJwk),
      repoRegistry,
    });

    const result = await verifier.verifyCommit({
      repo: DID,
      rev,
      since: null,
      commit: commitBlock.cid,
      prevData: null,
      tooBig: false,
      blocks: await encodeCar(commitBlock.cid, [commitBlock, rootBlock, recordBlock]),
      ops: [
        {
          action: "create",
          path,
          cid: recordBlock.cid,
        },
      ],
    });

    expect(result.isValid).toBe(true);
    if (!result.isValid) {
      throw new Error(`Expected valid result during persistence race, received ${JSON.stringify(result)}`);
    }
    expect(result.requiresSync).not.toBe(true);
    expect(repoRegistry.register).toHaveBeenCalledTimes(1);
    expect(repoRegistry.getRepoState).toHaveBeenCalledTimes(3);
  });
});

function createDidSigner(): {
  privateKey: KeyObject;
  publicJwk: Record<string, unknown>;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  return {
    privateKey,
    publicJwk: publicKey.export({ format: "jwk" }) as Record<string, unknown>,
  };
}

function createIdentityResolver(did: string, publicJwk: Record<string, unknown>) {
  const didDocument = buildDidDocument(did, publicJwk);
  return {
    resolveIdentity: vi.fn().mockResolvedValue({
      success: true,
      didDocument,
    }),
  };
}

function buildDidDocument(did: string, publicJwk: Record<string, unknown>): DidDocument {
  return {
    id: did,
    verificationMethod: [
      {
        id: `${did}#atproto`,
        type: "JsonWebKey2020",
        controller: did,
        publicKeyJwk: publicJwk,
      },
    ],
    assertionMethod: [`${did}#atproto`],
  } as unknown as DidDocument;
}

async function createSignedCommitBlock(input: {
  signer: KeyObject;
  did: string;
  rev: string;
  data: CID;
  prev: CID | null;
}): Promise<Block> {
  const unsignedValue = {
    did: input.did,
    version: 3,
    data: input.data,
    rev: input.rev,
    prev: input.prev,
  };
  const unsignedBytes = dagCbor.encode(unsignedValue);
  const signature = signLowS(unsignedBytes, input.signer);
  return createDagCborBlock({
    ...unsignedValue,
    sig: signature,
  });
}

function signLowS(unsignedBytes: Uint8Array, signer: KeyObject): Uint8Array {
  const signerStream = createSign("sha256");
  signerStream.update(unsignedBytes);
  signerStream.end();

  const signature = signerStream.sign({
    key: signer,
    dsaEncoding: "ieee-p1363",
  });

  return normalizeLowSP256(signature);
}

function normalizeLowSP256(signature: Uint8Array): Uint8Array {
  if (signature.length !== 64) {
    throw new Error(`Expected 64-byte P-256 signature, received ${signature.length}`);
  }

  const r = bytesToBigInt(signature.subarray(0, 32));
  let s = bytesToBigInt(signature.subarray(32));
  if (s > P256_ORDER / 2n) {
    s = P256_ORDER - s;
  }

  return Uint8Array.from(Buffer.concat([bigIntToFixedWidth(r, 32), bigIntToFixedWidth(s, 32)]));
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  return BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
}

function bigIntToFixedWidth(value: bigint, width: number): Buffer {
  return Buffer.from(value.toString(16).padStart(width * 2, "0"), "hex");
}

async function createDagCborBlock(value: unknown): Promise<Block> {
  const bytes = dagCbor.encode(value);
  return {
    cid: CID.createV1(dagCbor.code, await sha256.digest(bytes)),
    bytes,
  };
}

async function createMstRoot(entries: Array<{ key: string; value: CID }>): Promise<Block> {
  const sorted = [...entries].sort((left, right) => left.key.localeCompare(right.key));
  let lastKey = "";
  const node = {
    l: null,
    e: sorted.map((entry) => {
      const prefixLength = countPrefixLength(lastKey, entry.key);
      const serialized = {
        p: prefixLength,
        k: Uint8Array.from(Buffer.from(entry.key.slice(prefixLength), "ascii")),
        v: entry.value,
        t: null,
      };
      lastKey = entry.key;
      return serialized;
    }),
  };
  return createDagCborBlock(node);
}

async function encodeCar(root: CID, blocks: Block[]): Promise<Uint8Array> {
  const { writer, out } = CarWriter.create([root]);
  const chunksPromise = collectAsync(out);

  for (const block of blocks) {
    await writer.put(block);
  }
  await writer.close();

  const chunks = await chunksPromise;
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function collectAsync(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

function countPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

interface Block {
  cid: CID;
  bytes: Uint8Array;
}
