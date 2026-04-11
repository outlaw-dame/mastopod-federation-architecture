vi.mock("../../utils/logger.js", () => {
  const noop = () => undefined;
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { logger, default: logger };
});

vi.mock("undici", () => ({
  request: vi.fn(),
}));

import { Readable } from "node:stream";
import { MemoryKvStore } from "@fedify/fedify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "undici";
import { createFedifyAdapter } from "../FedifyFederationAdapter.js";

function makeAdapter() {
  return createFedifyAdapter(
    new MemoryKvStore(),
    {
      domain: "example.com",
      activityPodsUrl: "http://activitypods.internal",
      activityPodsToken: "test-token",
      requestTimeoutMs: 5_000,
      userAgent: "Fedify-Test/1.0",
    },
  );
}

function makeBody(text: string): Readable {
  return Readable.from(text.length > 0 ? [Buffer.from(text)] : []);
}

function makeDeliveryInput(overrides: Partial<Parameters<ReturnType<typeof makeAdapter>["deliverOutbound"]>[0]> = {}) {
  return {
    jobId: "job-001",
    actorUri: "https://example.com/users/alice",
    activityId: "https://example.com/activities/1",
    activity: JSON.stringify({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://example.com/activities/1",
      type: "Create",
      actor: "https://example.com/users/alice",
      object: {
        id: "https://example.com/notes/1",
        type: "Note",
        content: "Hello",
      },
    }),
    targetInbox: "https://remote.example/inbox",
    targetDomain: "remote.example",
    attempt: 0,
    maxAttempts: 10,
    requestTimeoutMs: 5_000,
    userAgent: "Fedify-Test/1.0",
    signHttpRequest: vi.fn().mockResolvedValue({
      ok: true,
      signedHeaders: {
        date: "Sun, 05 Apr 2026 12:00:00 GMT",
        signature: "keyId=\"test\",signature=\"abc\"",
        digest: "SHA-256=xyz",
      },
    }),
    ...overrides,
  };
}

describe("FedifyFederationAdapter outbound delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delivers through the Fedify adapter using ActivityPods signing headers", async () => {
    vi.mocked(request).mockResolvedValue({
      statusCode: 202,
      headers: {},
      body: makeBody("accepted"),
    } as never);

    const adapter = makeAdapter();
    const input = makeDeliveryInput();

    const result = await adapter.deliverOutbound(input);

    expect(result).toMatchObject({
      jobId: input.jobId,
      success: true,
      statusCode: 202,
    });
    expect(input.signHttpRequest).toHaveBeenCalledWith({
      actorUri: input.actorUri,
      method: "POST",
      targetUrl: input.targetInbox,
      body: input.activity,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("treats Fedify default permanent failure statuses as permanent", async () => {
    vi.mocked(request).mockResolvedValue({
      statusCode: 410,
      headers: {},
      body: makeBody("gone"),
    } as never);

    const adapter = makeAdapter();
    const input = makeDeliveryInput();

    const result = await adapter.deliverOutbound(input);

    expect(result).toMatchObject({
      jobId: input.jobId,
      success: false,
      statusCode: 410,
      permanent: true,
      responseBody: "gone",
    });
    expect(result.error).toContain("410");
  });

  it("honors Retry-After for transient responses", async () => {
    vi.mocked(request).mockResolvedValue({
      statusCode: 429,
      headers: { "retry-after": "7" },
      body: makeBody("slow down"),
    } as never);

    const adapter = makeAdapter();
    const input = makeDeliveryInput();

    const result = await adapter.deliverOutbound(input);

    expect(result).toMatchObject({
      jobId: input.jobId,
      success: false,
      statusCode: 429,
      permanent: false,
      retryAfterMs: 7_000,
      responseBody: "slow down",
    });
  });

  it("rejects unsafe target inbox URLs before signing or network delivery", async () => {
    const adapter = makeAdapter();
    const input = makeDeliveryInput({
      targetInbox: "http://10.0.0.5/inbox",
      targetDomain: "10.0.0.5",
    });

    const result = await adapter.deliverOutbound(input);

    expect(result).toMatchObject({
      jobId: input.jobId,
      success: false,
      permanent: true,
    });
    expect(result.error).toContain("safety validation");
    expect(input.signHttpRequest).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});
