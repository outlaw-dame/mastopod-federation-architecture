import { describe, expect, it } from "vitest";
import {
  ControlledActivityPubTargetState,
  isAdspControlledRemoteScenario,
} from "../ControlledActivityPubTarget.js";
import { createControlledActivityPubTargetServer } from "../ControlledActivityPubTargetServer.js";

const SIGNED_HEADERS: Record<string, string> = {
  host: "127.0.0.1:18080",
  date: "Mon, 17 Aug 2026 21:00:00 GMT",
  digest: "SHA-256=abc",
  signature: 'keyId="https://pods.example/alice#main-key",signature="abc"',
  "content-type": "application/activity+json",
};

function request(
  scenario: "success" | "transient" | "permanent",
  body: string,
  headers: Record<string, string> = SIGNED_HEADERS,
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

  it("rejects unsigned or incorrectly typed POSTs so a broken signing path cannot look successful", () => {
    const state = new ControlledActivityPubTargetState();
    const unsigned = state.handle(
      request("success", "{}", {
        host: "127.0.0.1:18080",
        "content-type": "application/activity+json",
      }),
    );
    expect(unsigned.statusCode).toBe(400);

    const wrongType = state.handle(
      request("success", "{}", {
        ...SIGNED_HEADERS,
        "content-type": "application/json",
      }),
    );
    expect(wrongType.statusCode).toBe(415);
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
      const deliveryHeaders = {
        date: "Mon, 17 Aug 2026 21:00:00 GMT",
        digest: "SHA-256=abc",
        signature: 'keyId="https://pods.example/alice#main-key",signature="abc"',
        "content-type": "application/activity+json",
      };
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
        observations: Array<{ payloadAttempt: number; bodyBytes: number }>;
      };
      expect(stats.totalRequests).toBe(2);
      expect(stats.counts.transient).toBe(2);
      expect(stats.observations.map(item => item.payloadAttempt)).toEqual([1, 2]);
      expect(stats.observations.every(item => item.bodyBytes === Buffer.byteLength(body))).toBe(true);

      const reset = await fetch(`${info.origin}/reset`, { method: "POST" });
      expect(reset.status).toBe(200);
      expect(fixture.snapshot().totalRequests).toBe(0);

      const oversized = await fetch(`${info.origin}/inbox/success`, {
        method: "POST",
        headers: deliveryHeaders,
        body: "x".repeat(65),
      });
      expect(oversized.status).toBe(413);
      expect(fixture.snapshot().totalRequests).toBe(0);
    } finally {
      await fixture.close();
    }
  });
});
