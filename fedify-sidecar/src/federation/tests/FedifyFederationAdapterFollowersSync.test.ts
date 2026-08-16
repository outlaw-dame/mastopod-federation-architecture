const { buildHeaderMock } = vi.hoisted(() => ({
  buildHeaderMock: vi.fn(),
}));

vi.mock("../../utils/logger.js", () => {
  const noop = () => undefined;
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { logger, default: logger };
});

vi.mock("../fep8fcf/FedifyFollowersSyncSender.js", () => ({
  createFedifyFollowersSyncSender: vi.fn(() => ({ buildHeader: buildHeaderMock })),
}));

vi.mock("undici", async () => {
  const actual = await vi.importActual<typeof import("undici")>("undici");
  return {
    ...actual,
    request: vi.fn(),
  };
});

import { Readable } from "node:stream";
import { MemoryKvStore } from "@fedify/fedify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "undici";
import { createFedifyAdapter } from "../FedifyFederationAdapter.js";
import { COLLECTION_SYNC_HEADER } from "../fep8fcf/CollectionSyncHeader.js";

function makeBody(text: string): Readable {
  return Readable.from(text.length > 0 ? [Buffer.from(text)] : []);
}

function makeAdapter() {
  return createFedifyAdapter(new MemoryKvStore(), {
    domain: "example.com",
    activityPodsUrl: "http://activitypods.internal",
    activityPodsToken: "test-token",
    requestTimeoutMs: 5_000,
    userAgent: "Fedify-Test/1.0",
  });
}

function makeDeliveryInput() {
  const activity = JSON.stringify({
    "@context": "https://www.w3.org/ns/activitystreams",
    id: "https://example.com/activities/1",
    type: "Create",
    actor: "https://example.com/users/alice",
    cc: ["https://example.com/users/alice/followers"],
    object: {
      id: "https://example.com/notes/1",
      type: "Note",
      content: "Hello",
    },
  });

  return {
    jobId: "job-fep-001",
    actorUri: "https://example.com/users/alice",
    activityId: "https://example.com/activities/1",
    activity,
    targetInbox: "http://localhost:8080/inbox",
    targetDomain: "localhost",
    attempt: 0,
    maxAttempts: 10,
    requestTimeoutMs: 5_000,
    userAgent: "Fedify-Test/1.0",
    assertExternalPostAllowed: vi.fn(),
    signHttpRequest: vi.fn().mockResolvedValue({
      ok: true,
      signedHeaders: {
        date: "Sun, 16 Aug 2026 12:00:00 GMT",
        signature: "keyId=\"test\",signature=\"abc\"",
        digest: "SHA-256=xyz",
      },
    }),
  };
}

describe("FedifyFederationAdapter FEP-8fcf outbound integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildHeaderMock.mockReset();
    vi.mocked(request).mockResolvedValue({
      statusCode: 202,
      headers: {},
      body: makeBody("accepted"),
    } as never);
  });

  it("carries a prepared Collection-Synchronization header on the primary Fedify POST", async () => {
    const syncHeader = "collectionId=\"https://example.com/users/alice/followers\", digest=\"sha-256=:abc:\", url=\"https://example.com/users/alice/followers_synchronization\"";
    buildHeaderMock.mockResolvedValue(syncHeader);

    const input = makeDeliveryInput();
    const result = await makeAdapter().deliverOutbound(input);

    expect(result).toMatchObject({ success: true, statusCode: 202 });
    expect(buildHeaderMock).toHaveBeenCalledWith({
      actorUri: input.actorUri,
      activity: input.activity,
      targetInbox: input.targetInbox,
    });

    const options = vi.mocked(request).mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
    expect(options?.headers?.[COLLECTION_SYNC_HEADER]).toBe(syncHeader);
  });

  it("delivers normally without the optional header when no sync header is available", async () => {
    buildHeaderMock.mockResolvedValue(null);

    const result = await makeAdapter().deliverOutbound(makeDeliveryInput());
    expect(result).toMatchObject({ success: true, statusCode: 202 });

    const options = vi.mocked(request).mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
    expect(options?.headers?.[COLLECTION_SYNC_HEADER]).toBeUndefined();
  });

  it("delivers normally when FEP header preparation throws", async () => {
    buildHeaderMock.mockRejectedValue(new Error("authority unavailable"));

    const result = await makeAdapter().deliverOutbound(makeDeliveryInput());
    expect(result).toMatchObject({ success: true, statusCode: 202 });
    expect(request).toHaveBeenCalledTimes(1);

    const options = vi.mocked(request).mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
    expect(options?.headers?.[COLLECTION_SYNC_HEADER]).toBeUndefined();
  });
});
