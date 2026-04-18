import { describe, expect, it, vi } from "vitest";
import { DefaultPodHydrationService, PodHydrationServiceError, type PodHydrator } from "../PodHydrationService.js";

describe("DefaultPodHydrationService", () => {
  it("deduplicates items before hydration", async () => {
    const hydrator: PodHydrator = {
      hydrate: vi.fn().mockResolvedValue({
        items: [
          {
            id: "https://example.com/objects/1",
            type: "Note",
            provenance: { source: "stream2" },
          },
        ],
      }),
    };

    const service = new DefaultPodHydrationService(new Map([["stream2", hydrator]]));
    const result = await service.hydrate({
      shape: "card",
      items: [
        {
          stableId: "post-1",
          canonicalUri: "https://example.com/objects/1",
          source: "stream2",
        },
        {
          stableId: "post-1",
          canonicalUri: "https://example.com/objects/1",
          source: "stream2",
        },
      ],
    });

    expect(result.items).toHaveLength(1);
    expect(hydrator.hydrate).toHaveBeenCalledTimes(1);
    expect((hydrator.hydrate as any).mock.calls[0][0].items).toHaveLength(1);
  });

  it("marks a source group omitted when retries are exhausted", async () => {
    const hydrator: PodHydrator = {
      hydrate: vi.fn().mockRejectedValue(new PodHydrationServiceError("temporary", { retryable: true })),
    };

    const service = new DefaultPodHydrationService(new Map([["stream2", hydrator]]), {
      initialDelayMs: 1,
      maxDelayMs: 2,
    });

    const result = await service.hydrate({
      shape: "card",
      items: [
        {
          stableId: "post-1",
          canonicalUri: "https://example.com/objects/1",
          source: "stream2",
        },
      ],
    });

    expect(result.items).toHaveLength(0);
    expect(result.omitted).toEqual([{ id: "post-1", reason: "temporarily_unavailable" }]);
  });
});
