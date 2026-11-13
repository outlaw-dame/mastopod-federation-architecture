import { afterEach, describe, expect, it, vi } from "vitest";
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
