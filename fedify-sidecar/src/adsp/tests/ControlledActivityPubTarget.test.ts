import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ControlledActivityPubTargetState,
  isAdspControlledRemoteScenario,
} from "../ControlledActivityPubTarget.js";
import { createControlledActivityPubTargetServer } from "../ControlledActivityPubTargetServer.js";

function digestFor(body: string): string {
  return `SHA-256=${createHash("sha256").update(body).digest("base64")}`;
}

function signedHeaders(body: string): Record<string, string> {
  return {
    host: "127.0.0.1:18080",
    date: "Mon, 17 Aug 2026 21:00:00 GMT",
    digest: digestFor(body),
    signature: 'keyId="https://pods.example/alice#main-key",signature="abc"',
    "content-type": "application/activity+json",
  };
}

function request(
  scenario: "success" | "transient" | "permanent",
  body: string,
  headers: Record<string, string> = signedHeaders(body),
) {
  return {
    scenario,
    method: "POST",
    path: `/inbox/${scenario}`,
    headers,
    body: Buffer.from(body),
    nowMs: 1_000,
  } as const;
}

describe("ControlledActivityPubTargetState", () => {
  it("accepts a signed ActivityPub success request and records bounded evidence", () => {
    const state = new ControlledActivityPubTargetState();
    const result = state.handle(request("success", '{"type":"Create"}'));

    expect(result.statusCode).toBe(202);
    expect(state.snapshot()).toMatchObject({
      totalRequests: 1,
      droppedObservations: 0,
      counts: { success: 1, transient: 0, permanent: 0 },
      observations: [
        {
          sequence: 1,
          scenario: "success",
          scenarioAttempt: 1,
          payloadAttempt: 1,
          bodyBytes: 17,
          hasDate: true,
          hasDigest: true,
          hasValidDigest: true,
          hasSignature: true,
        },
      ],
    });
  });

  it("fails the configured number of times independently for each transient payload", () => {
    const state = new ControlledActivityPubTargetState({ transientFailuresBeforeSuccess: 2 });
    const firstBody = '{"id":"one"}';
    const secondBody = '{"id":"two"}';

    expect(state.handle(request("transient", firstBody)).statusCode).toBe(503);
    expect(state.handle(request("transient", firstBody)).statusCode).toBe(503);
    expect(state.handle(request("transient", firstBody)).statusCode).toBe(202);

    expect(state.handle(request("transient", secondBody)).statusCode).toBe(503);
    expect(state.handle(request("transient", secondBody)).statusCode).toBe(503);
    expect(state.handle(request("transient", secondBody)).statusCode).toBe(202);

    expect(state.snapshot().observations.map(item => item.payloadAttempt)).toEqual([
      1, 2, 3, 1, 2, 3,
    ]);
  });

  it("returns a deterministic permanent failure for a correctly signed request", () => {
    const state = new ControlledActivityPubTargetState();
    const result = state.handle(request("permanent", '{"type":"Delete"}'));

    expect(result.statusCode).toBe(410);
    expect(result.body).toContain("controlled_permanent_failure");
  });

  it("rejects missing or invalid signing evidence and malformed media types", () => {
    const state = new ControlledActivityPubTargetState();
    const body = "{}";
    const unsigned = state.handle(
      request("success", body, {
        host: "127.0.0.1:18080",
        "content-type": "application/activity+json",
      }),
    );
    expect(unsigned.statusCode).toBe(400);

    const invalidDigest = state.handle(
      request("success", body, {
        ...signedHeaders(body),
        digest: digestFor("different-body"),
      }),
    );
    expect(invalidDigest.statusCode).toBe(400);
    expect(invalidDigest.body).toContain("invalid_digest");

    const wrongType = state.handle(
      request("success", body, {
        ...signedHeaders(body),
        "content-type": "application/json",
      }),
    );
    expect(wrongType.statusCode).toBe(415);

    const substringType = state.handle(
      request("success", body, {
        ...signedHeaders(body),
        "content-type": "text/x-application/activity+json-invalid",
      }),
    );
    expect(substringType.statusCode).toBe(415);
  });

  it("bounds retained observations while keeping exact aggregate request counts", () => {
    const state = new ControlledActivityPubTargetState({ maxObservations: 2 });
    state.handle(request("success", '{"id":"1"}'));
    state.handle(request("success", '{"id":"2"}'));
    state.handle(request("success", '{"id":"3"}'));

    const snapshot = state.snapshot();
    expect(snapshot.totalRequests).toBe(3);
    expect(snapshot.counts.success).toBe(3);
    expect(snapshot.droppedObservations).toBe(1);
    expect(snapshot.observations).toHaveLength(2);
    expect(snapshot.observations.map(item => item.sequence)).toEqual([2, 3]);
  });

  it("reset clears payload-attempt and aggregate state", () => {
    const state = new ControlledActivityPubTargetState({ transientFailuresBeforeSuccess: 1 });
    expect(state.handle(request("transient", "same-payload")).statusCode).toBe(503);
    expect(state.handle(request("transient", "same-payload")).statusCode).toBe(202);

    state.reset();

    expect(state.snapshot().totalRequests).toBe(0);
    expect(state.handle(request("transient", "same-payload")).statusCode).toBe(503);
  });

  it("validates scenario names without widening arbitrary input", () => {
    expect(isAdspControlledRemoteScenario("success")).toBe(true);
    expect(isAdspControlledRemoteScenario("transient")).toBe(true);
    expect(isAdspControlledRemoteScenario("permanent")).toBe(true);
    expect(isAdspControlledRemoteScenario("other")).toBe(false);
  });

  it("rejects invalid fault/log bounds at construction", () => {
    expect(() => new ControlledActivityPubTargetState({ transientFailuresBeforeSuccess: -1 })).toThrow();
    expect(() => new ControlledActivityPubTargetState({ maxObservations: 0 })).toThrow();
  });
});

describe("controlled ActivityPub target HTTP server", () => {
  it("rejects non-loopback binds so stats/reset never become a network control surface", () => {
    expect(() => createControlledActivityPubTargetServer({ host: "0.0.0.0" })).toThrow(
      /loopback/u,
    );
    expect(() => createControlledActivityPubTargetServer({ host: "::" })).toThrow(
      /loopback/u,
    );
    expect(() => createControlledActivityPubTargetServer({ host: "192.0.2.10" })).toThrow(
      /loopback/u,
    );
  });

  it("serves actor metadata, signed inbox outcomes, stats, reset, and bounded bodies", async () => {
    const fixture = createControlledActivityPubTargetServer({
      port: 0,
      transientFailuresBeforeSuccess: 1,
      maxBodyBytes: 64,
      maxObservations: 10,
    });
    const info = await fixture.start();

    try {
      const health = await fetch(`${info.origin}/health`);
      expect(health.status).toBe(200);

      const actorResponse = await fetch(info.actors.transient, {
        headers: { accept: "application/activity+json" },
      });
      expect(actorResponse.status).toBe(200);
      expect(actorResponse.headers.get("content-type")).toContain("application/activity+json");
      const actor = await actorResponse.json() as {
        id: string;
        inbox: string;
        endpoints: { sharedInbox: string };
      };
      expect(actor.id).toBe(info.actors.transient);
      expect(actor.inbox).toBe(`${info.origin}/inbox/transient`);
      expect(actor.endpoints.sharedInbox).toBe(actor.inbox);

      const body = '{"id":"https://pods.example/activities/1","type":"Create"}';
      const deliveryHeaders = signedHeaders(body);
      const first = await fetch(actor.inbox, {
        method: "POST",
        headers: deliveryHeaders,
        body,
      });
      expect(first.status).toBe(503);
      expect(first.headers.get("retry-after")).toBe("0");

      const second = await fetch(actor.inbox, {
        method: "POST",
        headers: deliveryHeaders,
        body,
      });
      expect(second.status).toBe(202);

      const statsResponse = await fetch(`${info.origin}/stats`);
      const stats = await statsResponse.json() as {
        totalRequests: number;
        counts: { transient: number };
        observations: Array<{ payloadAttempt: number; bodyBytes: number; hasValidDigest: boolean }>;
      };
      expect(stats.totalRequests).toBe(2);
      expect(stats.counts.transient).toBe(2);
      expect(stats.observations.map(item => item.payloadAttempt)).toEqual([1, 2]);
      expect(stats.observations.every(item => item.bodyBytes === Buffer.byteLength(body))).toBe(true);
      expect(stats.observations.every(item => item.hasValidDigest)).toBe(true);

      const reset = await fetch(`${info.origin}/reset`, { method: "POST" });
      expect(reset.status).toBe(200);
      expect(fixture.snapshot().totalRequests).toBe(0);

      const oversizedBody = "x".repeat(65);
      const oversized = await fetch(`${info.origin}/inbox/success`, {
        method: "POST",
        headers: signedHeaders(oversizedBody),
        body: oversizedBody,
      });
      expect(oversized.status).toBe(413);
      expect(fixture.snapshot().totalRequests).toBe(0);
    } finally {
      await fixture.close();
    }
  });
});
