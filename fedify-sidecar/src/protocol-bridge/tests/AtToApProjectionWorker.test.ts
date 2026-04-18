import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalIntent } from "../canonical/CanonicalIntent.js";
import type { ActivityPubProjectionCommand } from "../ports/ProtocolBridgePorts.js";
import type { ProjectionContext, TranslationContext } from "../ports/ProtocolBridgePorts.js";
import { ProjectorRegistry } from "../registry/ProjectorRegistry.js";
import { TranslatorRegistry } from "../registry/TranslatorRegistry.js";
import { InMemoryProjectionLedger } from "../idempotency/ProjectionLedger.js";
import { AtToApProjectionWorker } from "../workers/AtToApProjectionWorker.js";
import { getMetrics, metrics } from "../../metrics/index.js";

function buildIntent(): CanonicalIntent {
  return {
    kind: "FollowAdd",
    canonicalIntentId: "intent-1",
    sourceProtocol: "atproto",
    sourceEventId: "event-1",
    sourceAccountRef: { did: "did:plc:example" },
    subject: { did: "did:plc:subject" },
    createdAt: "2026-04-11T00:00:00.000Z",
    observedAt: "2026-04-11T00:00:00.000Z",
    visibility: "public",
    provenance: {
      originProtocol: "atproto",
      originEventId: "event-1",
      projectionMode: "native",
    },
    warnings: [],
  };
}

const translationContext: TranslationContext = {
  resolveActorRef: async (ref) => ref,
  resolveObjectRef: async (ref) => ref,
};

const projectionContext: ProjectionContext = {
  ...translationContext,
  buildIntentId: () => "intent-1",
};

describe("AtToApProjectionWorker", () => {
  beforeEach(() => {
    metrics.protocolBridgeProjectionOutcomes.reset();
  });

  it("skips unbound actor projection errors without throwing", async () => {
    const translator = new TranslatorRegistry([
      {
        supports: () => true,
        translate: vi.fn(async () => buildIntent()),
      },
    ]);

    const projector = new ProjectorRegistry<ActivityPubProjectionCommand>([
      {
        supports: () => true,
        project: vi.fn(async () => ({
          kind: "error" as const,
          code: "AP_ACTOR_URI_MISSING",
          message: "missing actor",
        })),
      },
    ]);

    const publishPort = { publish: vi.fn(async () => undefined) };
    const policy = { evaluate: vi.fn(async () => ({ allowed: true })) };
    const ledger = new InMemoryProjectionLedger();
    const worker = new AtToApProjectionWorker(
      translator,
      projector,
      policy,
      ledger,
      publishPort,
      projectionContext,
    );

    await expect(worker.process({ any: "event" }, translationContext)).resolves.toMatchObject({
      kind: "FollowAdd",
    });
    expect(publishPort.publish).not.toHaveBeenCalled();

    const rendered = await getMetrics();
    expect(rendered).toContain('fedify_protocol_bridge_projection_outcomes_total{direction="at_to_ap",outcome="skipped",reason="unbound_actor"} 1');
  });

  it("throws non-actor projection errors", async () => {
    const translator = new TranslatorRegistry([
      {
        supports: () => true,
        translate: vi.fn(async () => buildIntent()),
      },
    ]);

    const projector = new ProjectorRegistry<ActivityPubProjectionCommand>([
      {
        supports: () => true,
        project: vi.fn(async () => ({
          kind: "error" as const,
          code: "AP_TARGET_MISSING",
          message: "target missing",
        })),
      },
    ]);

    const publishPort = { publish: vi.fn(async () => undefined) };
    const policy = { evaluate: vi.fn(async () => ({ allowed: true })) };
    const ledger = new InMemoryProjectionLedger();
    const worker = new AtToApProjectionWorker(
      translator,
      projector,
      policy,
      ledger,
      publishPort,
      projectionContext,
    );

    await expect(worker.process({ any: "event" }, translationContext)).rejects.toThrow(
      "AP_TARGET_MISSING: target missing",
    );
  });
});
