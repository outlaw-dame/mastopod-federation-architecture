import { describe, expect, it, vi } from "vitest";
import { FeedRegistry } from "../FeedRegistry.js";
import { DefaultPodFeedService, PodFeedServiceError, type PodFeedProvider } from "../PodFeedService.js";
import type { FeedDefinition, FeedResponse } from "../contracts.js";

function buildDefinition(overrides: Partial<FeedDefinition> = {}): FeedDefinition {
  return {
    id: "urn:activitypods:feed:discovery:network",
    kind: "discovery",
    visibility: "public",
    title: "Discovery Network",
    description: "Relay-informed discovery feed",
    sourcePolicy: {
      includeStream1: false,
      includeStream2: true,
      includeCanonical: false,
      includeFirehose: false,
      includeUnified: false,
    },
    rankingPolicy: { mode: "ranked" },
    hydrationShape: "card",
    realtimeCapable: true,
    supportsSse: true,
    supportsWebSocket: true,
    providerId: "discovery-provider",
    experimental: false,
    ...overrides,
  };
}

function buildResponse(overrides: Partial<FeedResponse> = {}): FeedResponse {
  return {
    items: [
      {
        stableId: "post-1",
        canonicalUri: "https://example.com/objects/1",
        activityPubObjectId: "https://example.com/objects/1",
        source: "stream2",
        score: 1,
        publishedAt: new Date().toISOString(),
      },
    ],
    capabilities: {
      hydrationRequired: true,
      realtimeAvailable: true,
      supportsSse: true,
      supportsWebSocket: true,
    },
    ...overrides,
  };
}

describe("DefaultPodFeedService", () => {
  it("retries retryable provider failures with exponential backoff", async () => {
    const registry = new FeedRegistry([buildDefinition()]);
    const provider: PodFeedProvider = {
      getFeed: vi
        .fn()
        .mockRejectedValueOnce(new PodFeedServiceError("temporary outage", { retryable: true, statusCode: 503 }))
        .mockResolvedValue(buildResponse()),
    };
    const service = new DefaultPodFeedService(registry, new Map([["discovery-provider", provider]]), {
      initialDelayMs: 1,
      maxDelayMs: 2,
    });

    const result = await service.getFeed({ feedId: "urn:activitypods:feed:discovery:network", limit: 10 });
    expect(result.items).toHaveLength(1);
    expect(provider.getFeed).toHaveBeenCalledTimes(2);
  });

  it("rejects provider output that violates the definition source policy", async () => {
    const registry = new FeedRegistry([buildDefinition()]);
    const provider: PodFeedProvider = {
      getFeed: vi.fn().mockResolvedValue(
        buildResponse({
          items: [
            {
              stableId: "post-1",
              canonicalUri: "https://example.com/objects/1",
              activityPubObjectId: "https://example.com/objects/1",
              source: "canonical",
              publishedAt: new Date().toISOString(),
            },
          ],
        }),
      ),
    };
    const service = new DefaultPodFeedService(registry, new Map([["discovery-provider", provider]]));

    await expect(service.getFeed({ feedId: "urn:activitypods:feed:discovery:network", limit: 10 })).rejects.toThrow(
      /unsupported source canonical/i,
    );
  });
});
