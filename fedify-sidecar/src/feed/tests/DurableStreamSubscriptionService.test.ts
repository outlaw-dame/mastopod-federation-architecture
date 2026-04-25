import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  DurableStreamSubscriptionService,
  DurableStreamError,
  buildCapabilityLookup,
  type SubscriptionContext,
} from "../DurableStreamSubscriptionService.js";
import type { StreamEnvelope } from "../DurableStreamContracts.js";

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------
const TOKEN = "test-stream-token";

const capabilities = [
  {
    stream: "stream1" as const,
    supportsSse: true,
    supportsWebSocket: true,
    requiresAuthentication: false,
    replayCapable: true,
  },
  {
    stream: "stream2" as const,
    supportsSse: true,
    supportsWebSocket: false,
    requiresAuthentication: false,
    replayCapable: false,
  },
];

const capabilityLookup = buildCapabilityLookup(capabilities);

function makeService(overrides?: Partial<{ heartbeatIntervalMs: number }>) {
  return new DurableStreamSubscriptionService({
    sidecarToken: TOKEN,
    capabilityLookup,
    heartbeatIntervalMs: overrides?.heartbeatIntervalMs ?? 60_000,
  });
}

const validAuthHeaders = {
  authorization: `Bearer ${TOKEN}`,
  permissions: "provider:read",
};

function authorise(
  svc: DurableStreamSubscriptionService,
  partial?: Partial<{
    transport: string;
    streams: string[];
    cursor: string;
    viewerId: string;
  }>,
  authorizationOverride?: string,
  permissionsOverride?: string,
): SubscriptionContext {
  return svc.authoriseRequest(
    {
      transport: partial?.transport ?? "sse",
      streams: partial?.streams ?? ["stream1"],
      ...(partial?.cursor ? { cursor: partial.cursor } : {}),
      ...(partial?.viewerId ? { viewerId: partial.viewerId } : {}),
    },
    authorizationOverride ?? validAuthHeaders.authorization,
    permissionsOverride ?? validAuthHeaders.permissions,
  );
}

function sampleEnvelope(stream: string = "stream1"): StreamEnvelope {
  return {
    stream: stream as StreamEnvelope["stream"],
    eventId: "evt-001",
    cursor: "abc123",
    occurredAt: new Date().toISOString(),
    schema: "activitypods/note/v1",
    payload: { text: "hello" },
  };
}

// ---------------------------------------------------------------------------
// Auth tests
// ---------------------------------------------------------------------------
describe("DurableStreamSubscriptionService — authorisation", () => {
  it("rejects missing authorization header", () => {
    const svc = makeService();
    expect(() => svc.authoriseRequest({ transport: "sse", streams: ["stream1"] }, undefined, "provider:read"))
      .toThrow(DurableStreamError);
    try {
      svc.authoriseRequest({ transport: "sse", streams: ["stream1"] }, undefined, "provider:read");
    } catch (error) {
      expect(error).toBeInstanceOf(DurableStreamError);
      expect((error as DurableStreamError).statusCode).toBe(401);
    }
  });

  it("rejects wrong bearer token", () => {
    const svc = makeService();
    try {
      svc.authoriseRequest(
        { transport: "sse", streams: ["stream1"] },
        "Bearer wrong",
        "provider:read",
      );
    } catch (error) {
      expect(error).toBeInstanceOf(DurableStreamError);
      expect((error as DurableStreamError).statusCode).toBe(401);
    }
  });

  it("rejects missing provider:read permission", () => {
    const svc = makeService();
    try {
      authorise(svc, undefined, undefined, "provider:write");
    } catch (error) {
      expect(error).toBeInstanceOf(DurableStreamError);
      expect((error as DurableStreamError).statusCode).toBe(403);
    }
  });

  it("accepts valid credentials and returns SubscriptionContext", () => {
    const svc = makeService();
    const ctx = authorise(svc);
    expect(ctx.connectionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ctx.transport).toBe("sse");
    expect(Array.from(ctx.streams)).toContain("stream1");
    expect(ctx.resumeCursor).toBeNull();
  });

  it("rejects subscription to unknown stream", () => {
    const svc = makeService();
    try {
      authorise(svc, { streams: ["firehose"] });
    } catch (error) {
      expect(error).toBeInstanceOf(DurableStreamError);
      expect((error as DurableStreamError).code).toBe("stream_not_found");
      expect((error as DurableStreamError).statusCode).toBe(404);
    }
  });

  it("rejects WebSocket transport for stream that disables it", () => {
    const svc = makeService();
    try {
      authorise(svc, { transport: "websocket", streams: ["stream2"] });
    } catch (error) {
      expect(error).toBeInstanceOf(DurableStreamError);
      expect((error as DurableStreamError).code).toBe("transport_not_supported");
      expect((error as DurableStreamError).statusCode).toBe(422);
    }
  });

  it("rejects duplicate streams in request", () => {
    const svc = makeService();
    try {
      authorise(svc, { streams: ["stream1", "stream1"] });
    } catch (error) {
      expect(error).toBeInstanceOf(DurableStreamError);
      expect((error as DurableStreamError).statusCode).toBe(400);
    }
  });

  it("accepts multi-stream subscription when all streams are supported", () => {
    const svc = makeService();
    const ctx = authorise(svc, { streams: ["stream1", "stream2"] });
    expect(Array.from(ctx.streams)).toEqual(expect.arrayContaining(["stream1", "stream2"]));
  });
});

// ---------------------------------------------------------------------------
// Cursor round-trip tests
// ---------------------------------------------------------------------------
describe("DurableStreamSubscriptionService — cursor", () => {
  it("returns null resumeCursor when no cursor supplied", () => {
    const svc = makeService();
    const ctx = authorise(svc);
    expect(ctx.resumeCursor).toBeNull();
  });

  it("round-trips cursor through buildCursor and authoriseRequest", () => {
    const svc = makeService();
    const ctx = authorise(svc);
    const envelope = sampleEnvelope();
    const cursorStr = svc.buildCursor(ctx.streams, envelope);
    expect(typeof cursorStr).toBe("string");
    expect(cursorStr.length).toBeGreaterThan(0);

    // Resume from the cursor
    const ctx2 = authorise(svc, { cursor: cursorStr });
    expect(ctx2.resumeCursor).not.toBeNull();
    expect(ctx2.resumeCursor?.eventId).toBe(envelope.eventId);
    expect(ctx2.resumeCursor?.occurredAt).toBe(envelope.occurredAt);
  });

  it("treats corrupted cursor as null (graceful degradation)", () => {
    const svc = makeService();
    const ctx = authorise(svc, { cursor: "not-valid-base64url-json" });
    // Should not throw — corrupted cursor just resets to beginning
    expect(ctx.resumeCursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Connection lifecycle tests
// ---------------------------------------------------------------------------
describe("DurableStreamSubscriptionService — connections", () => {
  it("registers and deregisters SSE connection", () => {
    const svc = makeService();
    const ctx = authorise(svc);
    expect(svc.connectionCount).toBe(0);

    const send = vi.fn().mockReturnValue(true);
    const close = vi.fn();
    const cleanup = svc.registerSseConnection(ctx, send, close);

    expect(svc.connectionCount).toBe(1);
    cleanup();
    expect(svc.connectionCount).toBe(0);
  });

  it("canAcceptConnection returns false when at capacity", () => {
    const svc = new DurableStreamSubscriptionService({
      sidecarToken: TOKEN,
      capabilityLookup,
      maxConnections: 2,
    });

    const ctx1 = authorise(svc);
    const ctx2 = authorise(svc);

    svc.registerSseConnection(ctx1, vi.fn().mockReturnValue(true), vi.fn());
    svc.registerSseConnection(ctx2, vi.fn().mockReturnValue(true), vi.fn());

    expect(svc.canAcceptConnection()).toBe(false);
  });

  it("shutdown terminates all SSE connections and clears registry", () => {
    const svc = makeService();
    const ctx = authorise(svc);
    const close = vi.fn();
    svc.registerSseConnection(ctx, vi.fn().mockReturnValue(true), close);

    svc.shutdown();

    expect(close).toHaveBeenCalledOnce();
    expect(svc.connectionCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fan-out / publish tests
// ---------------------------------------------------------------------------
describe("DurableStreamSubscriptionService — publish", () => {
  it("delivers envelope to SSE connections subscribed to matching stream", () => {
    const svc = makeService();
    const ctx = authorise(svc, { streams: ["stream1"] });
    const sent: string[] = [];
    svc.registerSseConnection(
      ctx,
      (_event, data) => { sent.push(data); return true; },
      vi.fn(),
    );

    svc.publish(sampleEnvelope("stream1"));
    expect(sent.length).toBe(1);
    const rawSent = sent[0];
    expect(rawSent).toBeDefined();
    const parsed = JSON.parse(rawSent!);
    expect(parsed.eventId).toBe("evt-001");
  });

  it("does not deliver envelope to connections on a different stream", () => {
    const svc = makeService();
    const ctx = authorise(svc, { streams: ["stream2"] });
    const sent: string[] = [];
    svc.registerSseConnection(
      ctx,
      (_event, data) => { sent.push(data); return true; },
      vi.fn(),
    );

    svc.publish(sampleEnvelope("stream1")); // stream1 but connection is on stream2
    expect(sent.length).toBe(0);
  });

  it("drops envelope when send returns false (closed connection)", () => {
    const svc = makeService();
    const ctx = authorise(svc);
    let callCount = 0;
    svc.registerSseConnection(
      ctx,
      () => { callCount++; return false; }, // always returns false → connection is closed
      vi.fn(),
    );

    svc.publish(sampleEnvelope());
    expect(callCount).toBe(1);
    // Connection should have been cleaned up
    expect(svc.connectionCount).toBe(0);
  });

  it("silently ignores invalid envelopes", () => {
    const svc = makeService();
    const ctx = authorise(svc);
    const send = vi.fn().mockReturnValue(true);
    svc.registerSseConnection(ctx, send, vi.fn());

    // Missing required fields
    svc.publish({ stream: "stream1" });
    expect(send).not.toHaveBeenCalled();
  });

  it("continues fan-out after one connection throws", () => {
    const svc = makeService();
    const ctx1 = authorise(svc, { streams: ["stream1"] });
    const ctx2 = authorise(svc, { streams: ["stream1"] });

    const sent2: string[] = [];
    svc.registerSseConnection(ctx1, () => { throw new Error("connection dead"); }, vi.fn());
    svc.registerSseConnection(ctx2, (_e, d) => { sent2.push(d); return true; }, vi.fn());

    // Should not throw — bad connection is removed, good connection still receives
    expect(() => svc.publish(sampleEnvelope())).not.toThrow();
    expect(sent2.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// buildCapabilityLookup tests
// ---------------------------------------------------------------------------
describe("buildCapabilityLookup", () => {
  it("returns capability for known stream", () => {
    const lookup = buildCapabilityLookup(capabilities);
    const cap = lookup("stream1");
    expect(cap).toBeDefined();
    expect(cap?.supportsSse).toBe(true);
  });

  it("returns undefined for unknown stream", () => {
    const lookup = buildCapabilityLookup(capabilities);
    expect(lookup("firehose" as any)).toBeUndefined();
  });

  it("rejects malformed capability entries silently", () => {
    // Should not throw even with corrupt entries
    const lookup = buildCapabilityLookup([{ stream: "NOT_VALID" } as any]);
    expect(lookup("stream1")).toBeUndefined();
  });
});
