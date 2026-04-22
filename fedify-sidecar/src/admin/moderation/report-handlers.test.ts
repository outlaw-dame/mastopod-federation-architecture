import { describe, expect, it, vi } from "vitest";
import { CanonicalIntentPublisher } from "../../protocol-bridge/canonical/CanonicalIntentPublisher.js";
import { handleIngestReportCreate } from "./report-handlers.js";

describe("handleIngestReportCreate", () => {
  it("publishes a canonical local report create intent for an account subject", async () => {
    const rawPublisher = {
      publish: vi.fn().mockResolvedValue(undefined),
    };
    const canonicalPublisher = new CanonicalIntentPublisher(rawPublisher);

    const response = await handleIngestReportCreate(
      new Request("http://localhost/internal/bridge/moderation/reports", {
        method: "POST",
        headers: {
          authorization: "Bearer bridge-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          caseId: "01JREPORTCASE00000000000001",
          reporterWebId: "https://pod.example/alice#me",
          sourceAccountRef: {
            canonicalAccountId: "https://pod.example/alice#me",
            webId: "https://pod.example/alice#me",
            activityPubActorUri: "https://pod.example/users/alice",
          },
          subject: {
            kind: "account",
            actor: {
              activityPubActorUri: "https://remote.example/users/bob",
            },
            authoritativeProtocol: "ap",
          },
          reasonType: "harassment",
          reason: "Targeted harassment",
          evidenceObjectRefs: [
            {
              canonicalObjectId: "https://remote.example/notes/123",
              activityPubObjectId: "https://remote.example/notes/123",
            },
          ],
          requestedForwarding: { remote: true },
          clientContext: { app: "memory", surface: "report-sheet" },
          createdAt: "2026-04-22T12:00:00.000Z",
          observedAt: "2026-04-22T12:00:05.000Z",
        }),
      }),
      {
        internalBridgeToken: "bridge-token",
        canonicalPublisher,
        now: () => "2026-04-22T12:00:05.000Z",
      },
    );

    expect(response.status).toBe(202);
    const payload = await response.json() as { ok: boolean; canonicalIntentId: string };
    expect(payload.ok).toBe(true);
    expect(payload.canonicalIntentId).toMatch(/^[a-f0-9]{64}$/);

    expect(rawPublisher.publish).toHaveBeenCalledTimes(1);
    expect(rawPublisher.publish).toHaveBeenCalledWith(
      "canonical.v1",
      expect.objectContaining({
        kind: "ReportCreate",
        sourceProtocol: "activitypods",
        actor: expect.objectContaining({
          webId: "https://pod.example/alice#me",
        }),
        report: expect.objectContaining({
          subjectKind: "account",
          authoritativeProtocol: "ap",
          reasonType: "harassment",
          requestedForwardingRemote: true,
          clientContext: { app: "memory", surface: "report-sheet" },
        }),
      }),
      expect.any(Object),
    );
  });
});
