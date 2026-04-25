import { describe, expect, it } from "vitest";
import { InMemoryMRFAdminStore } from "../admin/mrf/store.memory.js";
import { ensureDefaultModuleConfigs } from "../admin/mrf/bootstrap.js";
import { evaluateMediaSignalPolicy } from "./MediaSignalPolicy.js";

describe("evaluateMediaSignalPolicy", () => {
  it("marks matching media as sensitive in enforce mode", async () => {
    const now = () => "2026-04-17T12:00:00.000Z";
    const store = new InMemoryMRFAdminStore(now);
    await ensureDefaultModuleConfigs(store, now);

    const current = await store.getModuleConfig("media-policy");
    expect(current).not.toBeNull();
    if (!current) throw new Error("media-policy config missing");
    await store.setModuleConfig("media-policy", {
      ...current,
      mode: "enforce",
      config: {
        ...current.config,
        sensitiveLabels: ["nsfw"],
        blockedLabels: ["csam"],
        minSensitiveConfidence: 0.6,
      },
    });

    const decision = await evaluateMediaSignalPolicy(store, {
      activityId: "https://example.com/media/123",
      signals: [{ source: "google-vision", labels: ["nsfw"], confidence: 0.91 }],
    }, { now, requestId: "req-1" });

    expect(decision?.desiredAction).toBe("label");
    expect(decision?.appliedAction).toBe("label");
    expect(decision?.markSensitive).toBe(true);
    expect(decision?.contentWarning).toBe("Sensitive media");
  });

  it("keeps dry-run decisions non-applying while still tracing them", async () => {
    const now = () => "2026-04-17T12:00:00.000Z";
    const store = new InMemoryMRFAdminStore(now);
    await ensureDefaultModuleConfigs(store, now);

    const decision = await evaluateMediaSignalPolicy(store, {
      activityId: "https://example.com/media/456",
      signals: [{ source: "cloudflare-csam", labels: ["csam"], confidence: 0.99 }],
    }, { now, requestId: "req-2" });

    expect(decision?.desiredAction).toBe("reject");
    expect(decision?.appliedAction).toBe("accept");
    expect(decision?.markSensitive).toBe(false);
  });

  it("treats PDQ matches as blocked images when quality and distance pass", async () => {
    const now = () => "2026-04-17T12:00:00.000Z";
    const store = new InMemoryMRFAdminStore(now);
    await ensureDefaultModuleConfigs(store, now);

    const current = await store.getModuleConfig("media-policy");
    expect(current).not.toBeNull();
    if (!current) throw new Error("media-policy config missing");

    const blockedHash = "1".repeat(256);
    const nearMatch = `${"1".repeat(252)}0000`;

    await store.setModuleConfig("media-policy", {
      ...current,
      mode: "enforce",
      config: {
        ...current.config,
        blockedPdqHashes: [blockedHash],
        minPdqQuality: 70,
        pdqHammingThreshold: 15,
        blockedAction: "filter",
      },
    });

    const decision = await evaluateMediaSignalPolicy(store, {
      activityId: "https://example.com/media/pdq",
      signals: [
        {
          source: "pdq-hash",
          labels: ["pdq-hash"],
          confidence: 0.88,
          raw: {
            pdqHashBinary: nearMatch,
            quality: 88,
          },
        },
      ],
    }, { now, requestId: "req-pdq-1" });

    expect(decision?.desiredAction).toBe("filter");
    expect(decision?.appliedAction).toBe("filter");
    expect(decision?.matchedLabels).toContain("pdq-blocked-image");
    expect(decision?.matchedSources).toContain("pdq-hash");
    expect(decision?.reason).toMatch(/PDQ hash matched/i);
  });

  it("ignores PDQ signals below the configured quality threshold", async () => {
    const now = () => "2026-04-17T12:00:00.000Z";
    const store = new InMemoryMRFAdminStore(now);
    await ensureDefaultModuleConfigs(store, now);

    const current = await store.getModuleConfig("media-policy");
    expect(current).not.toBeNull();
    if (!current) throw new Error("media-policy config missing");

    await store.setModuleConfig("media-policy", {
      ...current,
      mode: "enforce",
      config: {
        ...current.config,
        blockedPdqHashes: ["1".repeat(256)],
        minPdqQuality: 70,
        pdqHammingThreshold: 15,
        blockedAction: "reject",
      },
    });

    const decision = await evaluateMediaSignalPolicy(store, {
      activityId: "https://example.com/media/pdq-low-quality",
      signals: [
        {
          source: "pdq-hash",
          labels: ["pdq-hash"],
          raw: {
            pdqHashBinary: "1".repeat(256),
            quality: 55,
          },
        },
      ],
    }, { now, requestId: "req-pdq-2" });

    expect(decision?.desiredAction).toBe("accept");
    expect(decision?.appliedAction).toBe("accept");
  });

  it("accepts PDQ quality at the configured floor", async () => {
    const now = () => "2026-04-17T12:00:00.000Z";
    const store = new InMemoryMRFAdminStore(now);
    await ensureDefaultModuleConfigs(store, now);

    const current = await store.getModuleConfig("media-policy");
    expect(current).not.toBeNull();
    if (!current) throw new Error("media-policy config missing");

    await store.setModuleConfig("media-policy", {
      ...current,
      mode: "enforce",
      config: {
        ...current.config,
        blockedPdqHashes: ["1".repeat(256)],
        minPdqQuality: 70,
        pdqHammingThreshold: 15,
        blockedAction: "reject",
      },
    });

    const decision = await evaluateMediaSignalPolicy(store, {
      activityId: "https://example.com/media/pdq-quality-boundary",
      signals: [
        {
          source: "pdq-hash",
          labels: ["pdq-hash"],
          raw: {
            pdqHashBinary: "1".repeat(256),
            quality: 70,
          },
        },
      ],
    }, { now, requestId: "req-pdq-3" });

    expect(decision?.desiredAction).toBe("reject");
    expect(decision?.appliedAction).toBe("reject");
  });

  it("requires PDQ distance to stay strictly below the configured threshold", async () => {
    const now = () => "2026-04-17T12:00:00.000Z";
    const store = new InMemoryMRFAdminStore(now);
    await ensureDefaultModuleConfigs(store, now);

    const current = await store.getModuleConfig("media-policy");
    expect(current).not.toBeNull();
    if (!current) throw new Error("media-policy config missing");

    const blockedHash = "1".repeat(256);
    const thresholdBoundaryMatch = `${"1".repeat(241)}${"0".repeat(15)}`;

    await store.setModuleConfig("media-policy", {
      ...current,
      mode: "enforce",
      config: {
        ...current.config,
        blockedPdqHashes: [blockedHash],
        minPdqQuality: 70,
        pdqHammingThreshold: 15,
        blockedAction: "filter",
      },
    });

    const decision = await evaluateMediaSignalPolicy(store, {
      activityId: "https://example.com/media/pdq-distance-boundary",
      signals: [
        {
          source: "pdq-hash",
          labels: ["pdq-hash"],
          raw: {
            pdqHashBinary: thresholdBoundaryMatch,
            quality: 90,
          },
        },
      ],
    }, { now, requestId: "req-pdq-4" });

    expect(decision?.desiredAction).toBe("accept");
    expect(decision?.appliedAction).toBe("accept");
  });
});
