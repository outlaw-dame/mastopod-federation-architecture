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
});