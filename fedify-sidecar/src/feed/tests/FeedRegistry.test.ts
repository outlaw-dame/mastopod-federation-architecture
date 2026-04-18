import { describe, expect, it } from "vitest";
import { FeedRegistry } from "../FeedRegistry.js";
import type { FeedDefinition } from "../contracts.js";

function buildDefinition(overrides: Partial<FeedDefinition> = {}): FeedDefinition {
  return {
    id: "urn:activitypods:feed:graph:default",
    kind: "graph",
    visibility: "public",
    title: "Graph Feed",
    description: "Viewer-scoped graph feed",
    sourcePolicy: {
      includeStream1: true,
      includeStream2: false,
      includeCanonical: true,
      includeFirehose: false,
      includeUnified: false,
    },
    rankingPolicy: { mode: "blended" },
    hydrationShape: "card",
    realtimeCapable: true,
    supportsSse: true,
    supportsWebSocket: true,
    providerId: "graph-provider",
    experimental: false,
    ...overrides,
  };
}

describe("FeedRegistry", () => {
  it("filters authenticated and internal feeds from anonymous viewers", () => {
    const registry = new FeedRegistry([
      buildDefinition({ id: "public-feed", visibility: "public" }),
      buildDefinition({ id: "auth-feed", visibility: "authenticated" }),
      buildDefinition({ id: "internal-feed", visibility: "internal" }),
    ]);

    expect(registry.listPublic()).toHaveLength(1);
    expect(registry.listPublic({ viewerId: "did:plc:alice" })).toHaveLength(2);
    expect(registry.listPublic({ viewerId: "did:plc:alice", includeInternal: true })).toHaveLength(3);
  });

  it("strips providerId from public definitions", () => {
    const registry = new FeedRegistry([buildDefinition()]);
    const definition = registry.getPublic("urn:activitypods:feed:graph:default", { viewerId: "did:plc:alice" });
    expect(definition).not.toBeNull();
    expect(definition).not.toHaveProperty("providerId");
  });
});
