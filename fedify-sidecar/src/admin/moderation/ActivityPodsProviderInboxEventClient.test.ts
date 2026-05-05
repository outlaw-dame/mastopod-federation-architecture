vi.mock("../../utils/logger.js", () => {
  const noop = () => undefined;
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { logger, default: logger };
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ActivityPodsProviderInboxEventClient } from "./ActivityPodsProviderInboxEventClient.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeClient(overrides: {
  retries?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
} = {}) {
  return new ActivityPodsProviderInboxEventClient({
    baseUrl: "https://activitypods.example",
    bearerToken: "test-bearer-token",
    timeoutMs: 1_000,
    retries: overrides.retries ?? 0,    // default: no retries in tests
    retryBaseMs: overrides.retryBaseMs ?? 1,
    retryMaxMs: overrides.retryMaxMs ?? 1,
  });
}

function mockFetch(status: number, body = "") {
  return vi.fn().mockResolvedValue(
    new Response(body, { status }),
  );
}

function mockFetchSequence(...responses: Array<{ status: number; body?: string }>) {
  let call = 0;
  return vi.fn().mockImplementation(async () => {
    const r = responses[Math.min(call++, responses.length - 1)];
    return new Response(r!.body ?? "", { status: r!.status });
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ActivityPodsProviderInboxEventClient", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  // ── sendUndoFlag ──────────────────────────────────────────────────────────

  describe("sendUndoFlag", () => {
    it("returns true when ActivityPods returns 200", async () => {
      globalThis.fetch = mockFetch(200, '{"ok":true}');
      const client = makeClient();

      const result = await client.sendUndoFlag({
        activityId: "https://remote.example/undo/1",
        actorUri: "https://remote.example/users/alice",
        originalFlagId: "https://remote.example/flags/1",
        envelopePath: "/users/provider/inbox",
        receivedAt: "2026-04-25T00:00:00.000Z",
        rawActivity: { type: "Undo", actor: "https://remote.example/users/alice" },
      });

      expect(result).toBe(true);
      expect(globalThis.fetch).toHaveBeenCalledOnce();
    });

    it("sends the correct endpoint and payload shape", async () => {
      const fetchSpy = mockFetch(200);
      globalThis.fetch = fetchSpy;
      const client = makeClient();

      await client.sendUndoFlag({
        activityId: "https://remote.example/undo/1",
        actorUri: "https://remote.example/users/alice",
        originalFlagId: "https://remote.example/flags/1",
        envelopePath: "/users/provider/inbox",
        receivedAt: "2026-04-25T00:00:00.000Z",
        rawActivity: { type: "Undo" },
      });

      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(String(url)).toBe("https://activitypods.example/api/internal/moderation/inbox-events");
      expect((init as RequestInit).method).toBe("POST");
      expect((init as RequestInit).headers).toMatchObject({
        authorization: "Bearer test-bearer-token",
        "content-type": "application/json",
        "cache-control": "no-store",
      });

      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.eventType).toBe("UndoFlag");
      expect(body.activityId).toBe("https://remote.example/undo/1");
      expect(body.actorUri).toBe("https://remote.example/users/alice");
      expect(body.originalFlagId).toBe("https://remote.example/flags/1");
      // rawActivity is serialized as a string
      expect(typeof body.rawActivity).toBe("string");
      expect(JSON.parse(body.rawActivity)).toMatchObject({ type: "Undo" });
    });

    it("returns true for non-retryable 4xx (400) and does not throw", async () => {
      globalThis.fetch = mockFetch(400, '{"error":"bad request"}');
      const client = makeClient();

      const result = await client.sendUndoFlag({
        activityId: "https://remote.example/undo/2",
        actorUri: "https://remote.example/users/alice",
        originalFlagId: "https://remote.example/flags/2",
        envelopePath: "/users/provider/inbox",
        receivedAt: "2026-04-25T00:00:00.000Z",
        rawActivity: {},
      });

      // Unrecoverable 4xx → return true (caller ACKs, moves on)
      expect(result).toBe(true);
    });

    it("returns true for non-retryable 422", async () => {
      globalThis.fetch = mockFetch(422, '{"error":"unprocessable"}');
      const client = makeClient();
      const result = await client.sendUndoFlag({
        activityId: "id", actorUri: "https://remote.example/users/x",
        originalFlagId: "flag-id", envelopePath: "/inbox",
        receivedAt: new Date().toISOString(), rawActivity: {},
      });
      expect(result).toBe(true);
    });

    it("returns false after all retries exhausted on 500", async () => {
      // retries: 2 → 3 total attempts, all 500
      globalThis.fetch = mockFetch(500, "internal server error");
      const client = makeClient({ retries: 2, retryBaseMs: 1, retryMaxMs: 1 });

      const result = await client.sendUndoFlag({
        activityId: "https://remote.example/undo/3",
        actorUri: "https://remote.example/users/alice",
        originalFlagId: "https://remote.example/flags/3",
        envelopePath: "/users/provider/inbox",
        receivedAt: "2026-04-25T00:00:00.000Z",
        rawActivity: {},
      });

      // Transient 5xx exhausted → return false (caller must NOT ACK)
      expect(result).toBe(false);
      expect(globalThis.fetch).toHaveBeenCalledTimes(3); // 1 + 2 retries
    });

    it("returns false on network error after retries", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
      const client = makeClient({ retries: 1, retryBaseMs: 1, retryMaxMs: 1 });

      const result = await client.sendUndoFlag({
        activityId: "id", actorUri: "https://remote.example/users/x",
        originalFlagId: "flag", envelopePath: "/inbox",
        receivedAt: new Date().toISOString(), rawActivity: {},
      });

      expect(result).toBe(false);
    });

    it("retries on 429 and eventually returns false after exhaustion", async () => {
      globalThis.fetch = mockFetch(429);
      const client = makeClient({ retries: 1, retryBaseMs: 1, retryMaxMs: 1 });
      const result = await client.sendUndoFlag({
        activityId: "id", actorUri: "a", originalFlagId: "f",
        envelopePath: "/inbox", receivedAt: new Date().toISOString(), rawActivity: {},
      });
      expect(result).toBe(false);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2); // 1 + 1 retry
    });

    it("succeeds on retry when first call fails", async () => {
      globalThis.fetch = mockFetchSequence(
        { status: 503 },
        { status: 200, body: '{"ok":true}' },
      );
      const client = makeClient({ retries: 1, retryBaseMs: 1, retryMaxMs: 1 });

      const result = await client.sendUndoFlag({
        activityId: "id", actorUri: "a", originalFlagId: "f",
        envelopePath: "/inbox", receivedAt: new Date().toISOString(), rawActivity: {},
      });

      expect(result).toBe(true);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });
  });

  // ── sendAcceptReject ──────────────────────────────────────────────────────

  describe("sendAcceptReject", () => {
    it("sends eventType: Accept for Accept activities", async () => {
      const fetchSpy = mockFetch(200);
      globalThis.fetch = fetchSpy;
      const client = makeClient();

      const result = await client.sendAcceptReject({
        activityId: "https://remote.example/accept/1",
        actorUri: "https://remote.example/users/alice",
        activityType: "Accept",
        objectId: "https://local.example/follows/1",
        envelopePath: "/actor/inbox",
        receivedAt: "2026-04-25T00:00:00.000Z",
        rawActivity: { type: "Accept" },
      });

      expect(result).toBe(true);
      const body = JSON.parse(
        ((fetchSpy.mock.calls[0]![1] as RequestInit).body) as string,
      );
      expect(body.eventType).toBe("Accept");
      expect(body.objectId).toBe("https://local.example/follows/1");
    });

    it("sends eventType: Reject for Reject activities", async () => {
      const fetchSpy = mockFetch(200);
      globalThis.fetch = fetchSpy;
      const client = makeClient();

      await client.sendAcceptReject({
        activityId: "https://remote.example/reject/1",
        actorUri: "https://remote.example/users/alice",
        activityType: "Reject",
        objectId: null,
        envelopePath: "/users/provider/inbox",
        receivedAt: "2026-04-25T00:00:00.000Z",
        rawActivity: { type: "Reject" },
      });

      const body = JSON.parse(
        ((fetchSpy.mock.calls[0]![1] as RequestInit).body) as string,
      );
      expect(body.eventType).toBe("Reject");
      expect(body.objectId).toBeNull();
    });

    it("returns false on 503", async () => {
      globalThis.fetch = mockFetch(503);
      const client = makeClient();
      const result = await client.sendAcceptReject({
        activityId: "id", actorUri: "a", activityType: "Accept",
        objectId: null, envelopePath: "/inbox",
        receivedAt: new Date().toISOString(), rawActivity: {},
      });
      expect(result).toBe(false);
    });
  });

  // ── sendGenericEvent ──────────────────────────────────────────────────────

  describe("sendGenericEvent", () => {
    it("sends eventType: Generic with activityType field", async () => {
      const fetchSpy = mockFetch(201, '{}');
      globalThis.fetch = fetchSpy;
      const client = makeClient();

      const result = await client.sendGenericEvent({
        activityId: "https://remote.example/follows/1",
        actorUri: "https://remote.example/users/alice",
        activityType: "Follow",
        envelopePath: "/users/provider/inbox",
        receivedAt: "2026-04-25T00:00:00.000Z",
        rawActivity: { type: "Follow", actor: "https://remote.example/users/alice" },
      });

      expect(result).toBe(true);
      const body = JSON.parse(
        ((fetchSpy.mock.calls[0]![1] as RequestInit).body) as string,
      );
      expect(body.eventType).toBe("Generic");
      expect(body.activityType).toBe("Follow");
    });

    it("handles null activityId", async () => {
      const fetchSpy = mockFetch(200);
      globalThis.fetch = fetchSpy;
      const client = makeClient();

      await client.sendGenericEvent({
        activityId: null,
        actorUri: "https://remote.example/users/alice",
        activityType: "Create",
        envelopePath: "/inbox",
        receivedAt: new Date().toISOString(),
        rawActivity: {},
      });

      const body = JSON.parse(
        ((fetchSpy.mock.calls[0]![1] as RequestInit).body) as string,
      );
      expect(body.activityId).toBeNull();
    });
  });

  // ── Input sanitization ────────────────────────────────────────────────────

  describe("input sanitization", () => {
    it("truncates URIs longer than 2048 chars", async () => {
      const fetchSpy = mockFetch(200);
      globalThis.fetch = fetchSpy;
      const client = makeClient();

      const longUri = "https://remote.example/" + "x".repeat(3000);
      await client.sendGenericEvent({
        activityId: null,
        actorUri: longUri,
        activityType: "Follow",
        envelopePath: "/inbox",
        receivedAt: new Date().toISOString(),
        rawActivity: {},
      });

      const body = JSON.parse(
        ((fetchSpy.mock.calls[0]![1] as RequestInit).body) as string,
      );
      expect(body.actorUri.length).toBe(2048);
    });

    it("truncates activityId longer than 512 chars", async () => {
      const fetchSpy = mockFetch(200);
      globalThis.fetch = fetchSpy;
      const client = makeClient();

      const longId = "https://remote.example/" + "a".repeat(600);
      await client.sendUndoFlag({
        activityId: longId,
        actorUri: "https://remote.example/users/alice",
        originalFlagId: "https://remote.example/flags/1",
        envelopePath: "/inbox",
        receivedAt: new Date().toISOString(),
        rawActivity: {},
      });

      const body = JSON.parse(
        ((fetchSpy.mock.calls[0]![1] as RequestInit).body) as string,
      );
      expect(body.activityId.length).toBe(512);
    });

    it("truncates activityType longer than 64 chars", async () => {
      const fetchSpy = mockFetch(200);
      globalThis.fetch = fetchSpy;
      const client = makeClient();

      await client.sendGenericEvent({
        activityId: null,
        actorUri: "https://remote.example/users/alice",
        activityType: "A".repeat(100),
        envelopePath: "/inbox",
        receivedAt: new Date().toISOString(),
        rawActivity: {},
      });

      const body = JSON.parse(
        ((fetchSpy.mock.calls[0]![1] as RequestInit).body) as string,
      );
      expect(body.activityType.length).toBe(64);
    });

    it("serializes rawActivity as a JSON string inside the payload", async () => {
      const fetchSpy = mockFetch(200);
      globalThis.fetch = fetchSpy;
      const client = makeClient();

      const rawActivity = { type: "Follow", actor: "https://remote.example/users/bob", nested: { a: 1 } };
      await client.sendGenericEvent({
        activityId: "id", actorUri: "a", activityType: "Follow",
        envelopePath: "/inbox", receivedAt: new Date().toISOString(),
        rawActivity,
      });

      const body = JSON.parse(
        ((fetchSpy.mock.calls[0]![1] as RequestInit).body) as string,
      );
      expect(typeof body.rawActivity).toBe("string");
      expect(JSON.parse(body.rawActivity)).toEqual(rawActivity);
    });

    it("truncates rawActivity that exceeds 32 KB", async () => {
      const fetchSpy = mockFetch(200);
      globalThis.fetch = fetchSpy;
      const client = makeClient();

      // 32KB + 1 byte of JSON string content
      const hugeContent = "x".repeat(32 * 1024 + 100);
      await client.sendGenericEvent({
        activityId: "id", actorUri: "a", activityType: "Create",
        envelopePath: "/inbox", receivedAt: new Date().toISOString(),
        rawActivity: { content: hugeContent },
      });

      const outerBody = JSON.parse(
        ((fetchSpy.mock.calls[0]![1] as RequestInit).body) as string,
      );
      // rawActivity is a string; its length must be ≤ 32768
      expect(typeof outerBody.rawActivity).toBe("string");
      expect(outerBody.rawActivity.length).toBeLessThanOrEqual(32 * 1024);
    });

    it("strips trailing slash from baseUrl", async () => {
      const fetchSpy = mockFetch(200);
      globalThis.fetch = fetchSpy;
      const client = new ActivityPodsProviderInboxEventClient({
        baseUrl: "https://activitypods.example/", // trailing slash
        bearerToken: "token",
        retries: 0,
      });

      await client.sendGenericEvent({
        activityId: null, actorUri: "a", activityType: "Follow",
        envelopePath: "/inbox", receivedAt: new Date().toISOString(), rawActivity: {},
      });

      const [url] = fetchSpy.mock.calls[0]!;
      expect(String(url)).toBe("https://activitypods.example/api/internal/moderation/inbox-events");
    });
  });

  // ── Authorization header ──────────────────────────────────────────────────

  describe("authorization", () => {
    it("always sends Authorization: Bearer header", async () => {
      const fetchSpy = mockFetch(200);
      globalThis.fetch = fetchSpy;
      const client = new ActivityPodsProviderInboxEventClient({
        baseUrl: "https://activitypods.example",
        bearerToken: "secret-token-123",
        retries: 0,
      });

      await client.sendGenericEvent({
        activityId: "id", actorUri: "a", activityType: "Follow",
        envelopePath: "/inbox", receivedAt: new Date().toISOString(), rawActivity: {},
      });

      const [, init] = fetchSpy.mock.calls[0]!;
      expect((init as RequestInit).headers).toMatchObject({
        authorization: "Bearer secret-token-123",
      });
    });
  });
});
