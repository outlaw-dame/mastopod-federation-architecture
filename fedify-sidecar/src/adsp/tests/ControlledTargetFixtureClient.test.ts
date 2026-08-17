import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createControlledActivityPubTargetServer } from "../ControlledActivityPubTargetServer.js";
import {
  assertEmptyControlledTargetSnapshot,
  HttpControlledTargetFixtureClient,
} from "../ControlledTargetFixtureClient.js";

const servers: Array<ReturnType<typeof createControlledActivityPubTargetServer>> = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

describe("HttpControlledTargetFixtureClient", () => {
  it("reads and resets the real loopback controlled target evidence ledger", async () => {
    const server = createControlledActivityPubTargetServer({ port: 0 });
    servers.push(server);
    const info = await server.start();
    const client = new HttpControlledTargetFixtureClient(`${info.origin}/stats`);
    const activityId = "https://pods.example/activities/reset-client";
    const body = JSON.stringify({ id: activityId, type: "Create" });
    const digest = `SHA-256=${createHash("sha256").update(body).digest("base64")}`;

    const response = await fetch(`${info.origin}/inbox/success`, {
      method: "POST",
      headers: {
        "content-type": "application/activity+json",
        date: "Mon, 17 Aug 2026 21:00:00 GMT",
        digest,
        signature: 'keyId="https://pods.example/alice#main-key",signature="abc"',
      },
      body,
    });
    expect(response.status).toBe(202);
    const observation = (await client.readSnapshot()).observations[0];
    expect(observation?.activityId).toBe(activityId);
    expect(observation?.hasValidDigest).toBe(true);

    await client.reset();
    const empty = await client.readSnapshot();
    expect(() => assertEmptyControlledTargetSnapshot(empty)).not.toThrow();
  });

  it("rejects non-empty evidence when isolation was not established", () => {
    expect(() => assertEmptyControlledTargetSnapshot({
      version: 1,
      transientFailuresBeforeSuccess: 2,
      maxObservations: 10,
      totalRequests: 1,
      droppedObservations: 0,
      counts: { success: 1, transient: 0, permanent: 0 },
      observations: [],
    })).toThrow(/empty evidence ledger/u);
  });
});
