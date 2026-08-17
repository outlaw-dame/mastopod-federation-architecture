import { describe, expect, it, vi } from "vitest";
import {
  assertExistingSidecarConsumerGroups,
  parseAdspRemoteLiveRuntimeConfig,
} from "../RemoteFixtureLiveRuntime.js";

function env() {
  return {
    ADSP_REMOTE_REDIS_URL: "redis://127.0.0.1:6379/15",
    ADSP_REMOTE_SIDECAR_WEBHOOK_URL: "http://127.0.0.1:8080/webhook/outbox",
    ADSP_REMOTE_SIDECAR_TOKEN: "test-token-not-a-production-secret",
    ADSP_REMOTE_TARGET_STATS_URL: "http://127.0.0.1:18080/stats",
    ADSP_REMOTE_CONSUMER_GROUP: "sidecar-workers",
    ADSP_REMOTE_INBOUND_STREAM_KEY: "ap:queue:inbound:v1",
    ADSP_REMOTE_OUTBOUND_STREAM_KEY: "ap:queue:outbound:v1",
    ADSP_REMOTE_OUTBOX_INTENT_STREAM_KEY: "ap:queue:outbox-intent:v1",
    ADSP_REMOTE_ORIGIN_RECONCILE_STREAM_KEY: "ap:queue:origin-reconcile:v1",
  };
}

describe("ADSP remote live runtime configuration", () => {
  it("requires every topology coordinate explicitly", () => {
    expect(parseAdspRemoteLiveRuntimeConfig(env())).toEqual({
      redisUrl: "redis://127.0.0.1:6379/15",
      sidecarWebhookUrl: "http://127.0.0.1:8080/webhook/outbox",
      sidecarToken: "test-token-not-a-production-secret",
      targetStatsUrl: "http://127.0.0.1:18080/stats",
      consumerGroup: "sidecar-workers",
      inboundStreamKey: "ap:queue:inbound:v1",
      outboundStreamKey: "ap:queue:outbound:v1",
      outboxIntentStreamKey: "ap:queue:outbox-intent:v1",
      originReconcileStreamKey: "ap:queue:origin-reconcile:v1",
    });

    const missing = env();
    delete (missing as Partial<typeof missing>).ADSP_REMOTE_CONSUMER_GROUP;
    expect(() => parseAdspRemoteLiveRuntimeConfig(missing)).toThrow(/ADSP_REMOTE_CONSUMER_GROUP/u);
  });

  it("proves all expected consumer groups exist before queue attachment", async () => {
    const inspector = {
      xInfoGroups: vi.fn().mockResolvedValue([{ name: "sidecar-workers" }]),
    };
    const config = parseAdspRemoteLiveRuntimeConfig(env());

    await expect(assertExistingSidecarConsumerGroups(inspector, config)).resolves.toBeUndefined();
    expect(inspector.xInfoGroups).toHaveBeenCalledTimes(4);
    expect(inspector.xInfoGroups).toHaveBeenNthCalledWith(1, config.inboundStreamKey);
    expect(inspector.xInfoGroups).toHaveBeenNthCalledWith(2, config.outboundStreamKey);
    expect(inspector.xInfoGroups).toHaveBeenNthCalledWith(3, config.outboxIntentStreamKey);
    expect(inspector.xInfoGroups).toHaveBeenNthCalledWith(4, config.originReconcileStreamKey);
  });

  it("refuses to create or repair measurement topology when a group is missing", async () => {
    const inspector = {
      xInfoGroups: vi.fn()
        .mockResolvedValueOnce([{ name: "sidecar-workers" }])
        .mockResolvedValueOnce([]),
    };
    const config = parseAdspRemoteLiveRuntimeConfig(env());

    await expect(assertExistingSidecarConsumerGroups(inspector, config))
      .rejects.toThrow(/refusing to create measurement topology/u);
  });

  it("fails closed when stream inspection itself cannot prove existing topology", async () => {
    const inspector = {
      xInfoGroups: vi.fn().mockRejectedValue(new Error("ERR no such key")),
    };
    const config = parseAdspRemoteLiveRuntimeConfig(env());

    await expect(assertExistingSidecarConsumerGroups(inspector, config))
      .rejects.toThrow(/requires existing inbound stream\/group/u);
  });
});
