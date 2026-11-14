import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { DefaultAtXrpcServer } from "../xrpc/AtXrpcServer.js";
import { registerAtXrpcRoutes } from "../xrpc/AtXrpcFastifyBridge.js";
import { mapToXrpcError } from "../xrpc/middleware/XrpcErrorMapper.js";
import { DefaultAtCommitBuilder } from "./AtCommitBuilder.js";
import { DefaultAtCarExporter } from "./AtCarExporter.js";
import { DefaultAtCommitPersistenceService } from "./AtCommitPersistenceService.js";
import {
  AtprotoRepositoryNotReadyError, assertMockRepositoryAllowed,
} from "./AtprotoRepositoryReadiness.js";

afterEach(() => vi.unstubAllEnvs());

describe("legacy mock PDS never serves production account/repository state", () => {
  it("returns a stable nonretryable 503 instead of a fake success", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(assertMockRepositoryAllowed).toThrow(AtprotoRepositoryNotReadyError);
    try {
      assertMockRepositoryAllowed();
    } catch (error) {
      expect(error).toMatchObject({
        code: "ATPROTO_PDS_REPOSITORY_NOT_READY",
        statusCode: 503,
        retryable: false,
      });
    }
  });

  it("rejects mock commit construction before asking ActivityPods to sign", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const signAtprotoCommit = vi.fn();
    const builder = new DefaultAtCommitBuilder({ signAtprotoCommit } as any);
    await expect(builder.buildCommit(
      { did: "did:plc:abcdefghijklmnopqrstuvwx", rev: "1" } as any,
      [{ opType: "create", canonicalAccountId: "https://pods.example/alice" }] as any
    )).rejects.toMatchObject({ code: "ATPROTO_PDS_REPOSITORY_NOT_READY" });
    expect(signAtprotoCommit).not.toHaveBeenCalled();
  });

  it("rejects empty CAR export before any repo-registry read", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const getByDid = vi.fn();
    const exporter = new DefaultAtCarExporter({ getByDid } as any);
    await expect(exporter.exportRepo("did:plc:abcdefghijklmnopqrstuvwx"))
      .rejects.toMatchObject({ code: "ATPROTO_PDS_REPOSITORY_NOT_READY" });
    expect(getByDid).not.toHaveBeenCalled();
  });

  it("rejects fake commits before Redis, alias changes or event publication", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const updateCidAndRev = vi.fn();
    const publish = vi.fn();
    const set = vi.fn();
    const persistence = new DefaultAtCommitPersistenceService(
      { updateCidAndRev } as any,
      { publish } as any,
      { set } as any
    );
    await expect(persistence.persist({
      did: "did:plc:abcdefghijklmnopqrstuvwx",
      rev: "3kabcdef", commitCid: "bafyreimock", prevCommitCid: null,
      signature: "", unsignedCommitBytesBase64: "", ops: []
    })).rejects.toMatchObject({ code: "ATPROTO_PDS_REPOSITORY_NOT_READY" });
    expect(set).not.toHaveBeenCalled();
    expect(updateCidAndRev).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("keeps existing isolated development mock fixtures available", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(assertMockRepositoryAllowed).not.toThrow();
    vi.stubEnv("NODE_ENV", "test");
    expect(assertMockRepositoryAllowed).not.toThrow();
  });
});

describe("production repository readiness is preserved at the real XRPC HTTP boundary", () => {
  it("returns a stable HTTP 503 from getRepo and guarded authenticated writes", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const did = "did:plc:abcdefghijklmnopqrstuvwx";
    const signer = { signAtprotoCommit: vi.fn() };
    const builder = new DefaultAtCommitBuilder(signer as any);
    const carRegistry = { getByDid: vi.fn() };
    const exporter = new DefaultAtCarExporter(carRegistry as any);
    const handle = {
      resolveRepoInput: vi.fn().mockResolvedValue({ did, handle: "writer.example.org" }),
    };
    const repoRegistry = {
      getByDid: vi.fn().mockResolvedValue({ did, status: "active" }),
    };
    const writeGateway = {
      createRecord: vi.fn().mockImplementation(() =>
        builder.buildCommit(
          { did, rev: "1" } as any,
          [{ opType: "create", canonicalAccountId: "https://paper.example.org/users/writer" }] as any
        )
      ),
    };
    const sessions = {
      verifyAccessToken: vi.fn().mockResolvedValue({
        did, handle: "writer.example.org",
        canonicalAccountId: "https://paper.example.org/users/writer",
      }),
    };
    const xrpcServer = new DefaultAtXrpcServer({
      recordReader: {} as any,
      carExporter: exporter,
      handleResolutionReader: handle as any,
      firehoseSubscriptions: {} as any,
      repoRegistry: repoRegistry as any,
      writeGateway: writeGateway as any,
    });
    const app = Fastify({ logger: false });
    registerAtXrpcRoutes(app, {
      xrpcServer,
      sessionService: sessions as any,
    });
    try {
      const read = await app.inject({
        method: "GET",
        url: "/xrpc/com.atproto.sync.getRepo?did=" + encodeURIComponent(did),
      });
      expect(read.statusCode).toBe(503);
      expect(read.json()).toEqual({
        error: "ServiceUnavailable",
        message: "Signed repository storage is not available",
      });
      expect(read.headers["x-content-type-options"]).toBe("nosniff");

      const write = await app.inject({
        method: "POST",
        url: "/xrpc/com.atproto.repo.createRecord",
        headers: { authorization: "Bearer disposable-test-token" },
        payload: {
          repo: did, collection: "app.bsky.feed.post",
          record: { text: "test-only", createdAt: "2026-11-14T12:00:00Z" },
        },
      });
      expect(write.statusCode).toBe(503);
      expect(write.json()).toEqual({
        error: "ServiceUnavailable",
        message: "Signed repository storage is not available",
      });
      expect(write.headers["x-content-type-options"]).toBe("nosniff");
      expect(writeGateway.createRecord).toHaveBeenCalledTimes(1);
      expect(signer.signAtprotoCommit).not.toHaveBeenCalled();
      expect(carRegistry.getByDid).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("does not trust arbitrary HTTP-status-looking objects as repository readiness errors", () => {
    const impostor = Object.assign(new Error("sensitive internal detail"), {
      statusCode: 503, code: "ATPROTO_PDS_REPOSITORY_NOT_READY",
      retryable: false,
    });
    expect(mapToXrpcError(impostor)).toEqual({
      status: 500,
      body: {
        error: "InternalServerError",
        message: "An unexpected error occurred",
      },
    });
    expect(mapToXrpcError(new AtprotoRepositoryNotReadyError())).toEqual({
      status: 503,
      body: {
        error: "ServiceUnavailable",
        message: "Signed repository storage is not available",
      },
    });
  });
});
