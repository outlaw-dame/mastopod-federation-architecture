import { describe, expect, it, vi } from "vitest";
import { InMemoryAtprotoRepoRegistry } from "../../atproto/repo/AtprotoRepoRegistry.js";
import {
  buildAtExternalFirehoseBootstrap,
  parseAtExternalFirehoseSources,
} from "../ingress/AtExternalFirehoseBootstrap.js";

describe("AtExternalFirehoseBootstrap", () => {
  it("parses stable, deduplicated external firehose sources", () => {
    const sources = parseAtExternalFirehoseSources(`
      relay|wss://relay.bsky.network
      relay|wss://relay.bsky.network
      pds|wss://bsky.social/xrpc/com.atproto.sync.subscribeRepos
    `);

    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({
      sourceType: "relay",
      url: "wss://relay.bsky.network/",
    });
    expect(sources[1]).toMatchObject({
      sourceType: "pds",
      url: "wss://bsky.social/xrpc/com.atproto.sync.subscribeRepos",
    });
    const firstSource = sources[0];
    const secondSource = sources[1];
    expect(firstSource).toBeDefined();
    expect(secondSource).toBeDefined();
    expect(firstSource?.id).not.toBe(secondSource?.id);
  });

  it("refuses unsafe external firehose source URLs", () => {
    expect(() => parseAtExternalFirehoseSources("relay|https://relay.bsky.network")).toThrow(
      /must use ws:\/\/ or wss:\/\//,
    );
    expect(() => parseAtExternalFirehoseSources("relay|wss://user:pass@relay.bsky.network")).toThrow(
      /must not include credentials/,
    );
  });

  it("returns a disabled bootstrap result when commit verification is missing", () => {
    const bootstrap = buildAtExternalFirehoseBootstrap({
      runtimeConfig: {
        brokers: ["localhost:9092"],
        clientId: "fedify-sidecar",
        consumerGroupId: "fedify-sidecar-at-firehose-external",
        rawTopic: "at.firehose.raw.v1",
        sources: parseAtExternalFirehoseSources("relay|wss://relay.bsky.network"),
      },
      redis: buildMockRedis(),
      eventPublisher: {
        publish: vi.fn().mockResolvedValue(undefined),
        publishBatch: vi.fn().mockResolvedValue(undefined),
      },
      repoRegistry: new InMemoryAtprotoRepoRegistry(),
      commitVerifier: null,
    });

    expect(bootstrap.kind).toBe("disabled");
    if (bootstrap.kind !== "disabled") {
      throw new Error(`expected disabled bootstrap, got ${bootstrap.kind}`);
    }
    expect(bootstrap.reason).toBe("missing_commit_verifier");
    expect(bootstrap.sources).toHaveLength(1);
  });

  it("builds a ready runtime when all verifier dependencies are present", () => {
    const bootstrap = buildAtExternalFirehoseBootstrap({
      runtimeConfig: {
        brokers: ["localhost:9092"],
        clientId: "fedify-sidecar",
        consumerGroupId: "fedify-sidecar-at-firehose-external",
        rawTopic: "at.firehose.raw.v1",
        sources: parseAtExternalFirehoseSources("relay|wss://relay.bsky.network"),
      },
      redis: buildMockRedis(),
      eventPublisher: {
        publish: vi.fn().mockResolvedValue(undefined),
        publishBatch: vi.fn().mockResolvedValue(undefined),
      },
      repoRegistry: new InMemoryAtprotoRepoRegistry(),
      commitVerifier: {
        verifyCommit: vi.fn().mockResolvedValue({
          isValid: true,
          ops: [],
        }),
      },
      identityResolverOptions: {
        fetchImpl: vi.fn(),
      },
      syncRebuilderOptions: {
        fetchImpl: vi.fn(),
      },
    });

    expect(bootstrap.kind).toBe("ready");
    expect(bootstrap.sources).toHaveLength(1);
  });
});

function buildMockRedis() {
  const values = new Map<string, string>();
  return {
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async set(key: string, value: string) {
      values.set(key, value);
      return "OK";
    },
    async setex(key: string, _ttl: number, value: string) {
      values.set(key, value);
      return "OK";
    },
    async exists(key: string) {
      return values.has(key) ? 1 : 0;
    },
    async del(key: string) {
      values.delete(key);
      return 1;
    },
  };
}
