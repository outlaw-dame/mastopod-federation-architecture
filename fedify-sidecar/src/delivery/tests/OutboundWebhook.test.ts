import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateOutboundWebhookBackpressure,
  normalizeAndDedupeOutboundTargets,
  OutboundWebhookValidationError,
  resolveOutboundWebhookBackpressureConfigFromEnv,
  validateApdmWebhookIdentity,
} from "../outbound-webhook.js";

const AUTHORITY = {
  schema: "ap.delivery-plan.v1",
  intentId: "apdm-phase6-test-intent",
};

const originalNodeEnv = process.env["NODE_ENV"];
const originalInteropHosts = process.env["APDM_INTEROP_PRIVATE_HOSTS"];

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env["NODE_ENV"];
  else process.env["NODE_ENV"] = originalNodeEnv;
  if (originalInteropHosts === undefined) delete process.env["APDM_INTEROP_PRIVATE_HOSTS"];
  else process.env["APDM_INTEROP_PRIVATE_HOSTS"] = originalInteropHosts;
});

function target(input: Record<string, unknown>): Record<string, unknown> {
  return { ...input, apdmAuthority: AUTHORITY };
}

function webhookConfig(maxTargetsPerRequest = 100) {
  return {
    maxPending: 25_000,
    maxQueueDepth: 0,
    retryAfterSeconds: 5,
    maxTargetsPerRequest,
  };
}

function normalizedAuthority() {
  return normalizeAndDedupeOutboundTargets(
    [target({ inboxUrl: "https://one.example/inbox" })],
    webhookConfig(),
  );
}

function deliveryPlanMeta(intentId = AUTHORITY.intentId) {
  return {
    deliveryPlanSchema: "ap.delivery-plan.v1",
    deliveryPlanIntentId: intentId,
  };
}

describe("normalizeAndDedupeOutboundTargets", () => {
  it("dedupes repeated shared inbox targets and skips invalid URLs after APDM authority validation", () => {
    const result = normalizeAndDedupeOutboundTargets(
      [
        target({
          inboxUrl: "https://mastodon.example/users/alice/inbox",
          sharedInboxUrl: "https://mastodon.example/inbox",
          targetDomain: "mastodon.example",
        }),
        target({
          inboxUrl: "https://mastodon.example/users/bob/inbox",
          sharedInboxUrl: "https://mastodon.example/inbox",
          targetDomain: "mastodon.example",
        }),
        target({
          inboxUrl: "http://10.0.0.5/inbox",
          targetDomain: "10.0.0.5",
        }),
      ],
      webhookConfig(),
    );

    expect(result.targets).toEqual([
      {
        inboxUrl: "https://mastodon.example/users/alice/inbox",
        sharedInboxUrl: "https://mastodon.example/inbox",
        deliveryUrl: "https://mastodon.example/inbox",
        targetDomain: "mastodon.example",
      },
    ]);
    expect(result.inputTargetCount).toBe(3);
    expect(result.duplicateTargetCount).toBe(1);
    expect(result.invalidTargetCount).toBe(1);
    expect(result.apdmAuthorityIntentId).toBe(AUTHORITY.intentId);
  });

  it("preserves already-normalized durable intent targets without transport authority metadata", () => {
    delete process.env["APDM_INTEROP_PRIVATE_HOSTS"];
    process.env["NODE_ENV"] = "production";

    const result = normalizeAndDedupeOutboundTargets(
      [
        {
          inboxUrl: "https://remote.example/users/alice/inbox",
          deliveryUrl: "https://remote.example/users/alice/inbox",
          targetDomain: "remote.example",
        },
      ],
      { maxTargetsPerRequest: 100 },
    );

    expect(result.targets).toEqual([
      {
        inboxUrl: "https://remote.example/users/alice/inbox",
        deliveryUrl: "https://remote.example/users/alice/inbox",
        targetDomain: "remote.example",
      },
    ]);
    expect(result.apdmAuthorityIntentId).toBeUndefined();
  });

  it("does not let raw callers bypass authority by supplying normalized-looking target fields", () => {
    delete process.env["APDM_INTEROP_PRIVATE_HOSTS"];
    process.env["NODE_ENV"] = "production";

    expect(() =>
      normalizeAndDedupeOutboundTargets(
        [
          {
            inboxUrl: "https://one.example/inbox",
            deliveryUrl: "https://one.example/inbox",
            targetDomain: "one.example",
          },
        ],
        webhookConfig(),
      ),
    ).toThrowError(/ap\.delivery-plan\.v1 APDM authority marker/u);
  });

  it("rejects the retired legacy raw-routing target shape by default", () => {
    delete process.env["APDM_INTEROP_PRIVATE_HOSTS"];
    expect(() =>
      normalizeAndDedupeOutboundTargets(
        [{ inboxUrl: "https://one.example/inbox" }],
        webhookConfig(),
      ),
    ).toThrowError(/ap\.delivery-plan\.v1 APDM authority marker/u);

    try {
      normalizeAndDedupeOutboundTargets(
        [{ inboxUrl: "https://one.example/inbox" }],
        webhookConfig(),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(OutboundWebhookValidationError);
      expect((error as OutboundWebhookValidationError).code).toBe("OUTBOUND_APDM_AUTHORITY_REQUIRED");
      expect((error as OutboundWebhookValidationError).statusCode).toBe(400);
    }
  });

  it("permits only explicitly allowlisted unmarked interop hosts in test/development", () => {
    process.env["NODE_ENV"] = "development";
    process.env["APDM_INTEROP_PRIVATE_HOSTS"] = "gotosocial,mastodon";

    const result = normalizeAndDedupeOutboundTargets(
      [{ inboxUrl: "https://gotosocial/users/interop/inbox" }],
      webhookConfig(),
    );
    expect(result.apdmAuthorityIntentId).toBe("apdm-interop-legacy-fixture");
    expect(
      validateApdmWebhookIdentity({
        normalizedTargets: result,
        headerIntentId: undefined,
        meta: undefined,
      }),
    ).toBeUndefined();

    expect(() =>
      normalizeAndDedupeOutboundTargets(
        [{ inboxUrl: "https://attacker.example/inbox" }],
        webhookConfig(),
      ),
    ).toThrowError(OutboundWebhookValidationError);
  });

  it("keeps the interop allowlist fail-closed in production and unknown environments", () => {
    process.env["APDM_INTEROP_PRIVATE_HOSTS"] = "gotosocial";
    for (const environment of ["production", "staging", ""]) {
      process.env["NODE_ENV"] = environment;
      expect(() =>
        normalizeAndDedupeOutboundTargets(
          [{ inboxUrl: "https://gotosocial/users/interop/inbox" }],
          webhookConfig(),
        ),
      ).toThrowError(OutboundWebhookValidationError);
    }
  });

  it("rejects wrong schemas, blank intent IDs, and mixed Delivery Plan identities", () => {
    delete process.env["APDM_INTEROP_PRIVATE_HOSTS"];
    for (const apdmAuthority of [
      { schema: "ap.delivery-plan.v0", intentId: AUTHORITY.intentId },
      { schema: "ap.delivery-plan.v1", intentId: "" },
      { schema: "ap.delivery-plan.v1", intentId: " padded " },
      null,
    ]) {
      expect(() =>
        normalizeAndDedupeOutboundTargets(
          [{ inboxUrl: "https://one.example/inbox", apdmAuthority }],
          webhookConfig(),
        ),
      ).toThrowError(OutboundWebhookValidationError);
    }

    expect(() =>
      normalizeAndDedupeOutboundTargets(
        [
          target({ inboxUrl: "https://one.example/inbox" }),
          {
            inboxUrl: "https://two.example/inbox",
            apdmAuthority: { schema: "ap.delivery-plan.v1", intentId: "different-intent" },
          },
        ],
        webhookConfig(),
      ),
    ).toThrowError(/same APDM Delivery Plan intentId/u);
  });

  it("rejects requests that exceed the configured maximum target count", () => {
    expect(() =>
      normalizeAndDedupeOutboundTargets(
        [
          target({ inboxUrl: "https://one.example/inbox" }),
          target({ inboxUrl: "https://two.example/inbox" }),
        ],
        webhookConfig(1),
      ),
    ).toThrowError(OutboundWebhookValidationError);
  });
});

describe("validateApdmWebhookIdentity", () => {
  it("returns the authoritative intent only when marker, header, schema, and metadata agree", () => {
    expect(
      validateApdmWebhookIdentity({
        normalizedTargets: normalizedAuthority(),
        headerIntentId: AUTHORITY.intentId,
        meta: deliveryPlanMeta(),
      }),
    ).toBe(AUTHORITY.intentId);
  });

  it("rejects missing and padded X-APDM-Intent-Id headers", () => {
    for (const headerIntentId of [undefined, "", ` ${AUTHORITY.intentId} `]) {
      expect(() =>
        validateApdmWebhookIdentity({
          normalizedTargets: normalizedAuthority(),
          headerIntentId,
          meta: deliveryPlanMeta(),
        }),
      ).toThrowError(OutboundWebhookValidationError);
    }
  });

  it("rejects missing or wrong Delivery Plan metadata schema", () => {
    for (const meta of [
      undefined,
      { deliveryPlanIntentId: AUTHORITY.intentId },
      { deliveryPlanSchema: "ap.delivery-plan.v0", deliveryPlanIntentId: AUTHORITY.intentId },
    ]) {
      expect(() =>
        validateApdmWebhookIdentity({
          normalizedTargets: normalizedAuthority(),
          headerIntentId: AUTHORITY.intentId,
          meta,
        }),
      ).toThrowError(OutboundWebhookValidationError);
    }
  });

  it("rejects marker/header/meta intent mismatches", () => {
    expect(() =>
      validateApdmWebhookIdentity({
        normalizedTargets: normalizedAuthority(),
        headerIntentId: "different-header-intent",
        meta: deliveryPlanMeta(),
      }),
    ).toThrowError(/must match/u);

    expect(() =>
      validateApdmWebhookIdentity({
        normalizedTargets: normalizedAuthority(),
        headerIntentId: AUTHORITY.intentId,
        meta: deliveryPlanMeta("different-meta-intent"),
      }),
    ).toThrowError(/must match/u);
  });
});

describe("evaluateOutboundWebhookBackpressure", () => {
  it("rejects when pending jobs exceed the configured threshold", () => {
    const result = evaluateOutboundWebhookBackpressure(
      { pendingCount: 200, streamLength: 50 },
      { maxPending: 200, maxQueueDepth: 500, retryAfterSeconds: 5, maxTargetsPerRequest: 100 },
    );
    expect(result).toEqual({ reject: true, reason: "pending", retryAfterSeconds: 5 });
  });

  it("rejects when queue depth exceeds the configured threshold", () => {
    const result = evaluateOutboundWebhookBackpressure(
      { pendingCount: 10, streamLength: 500 },
      { maxPending: 200, maxQueueDepth: 500, retryAfterSeconds: 7, maxTargetsPerRequest: 100 },
    );
    expect(result).toEqual({ reject: true, reason: "queue_depth", retryAfterSeconds: 7 });
  });

  it("does not reject on queue depth alone when there is no pending backlog", () => {
    const result = evaluateOutboundWebhookBackpressure(
      { pendingCount: 0, streamLength: 500 },
      { maxPending: 200, maxQueueDepth: 500, retryAfterSeconds: 7, maxTargetsPerRequest: 100 },
    );
    expect(result).toEqual({ reject: false });
  });

  it("does not reject on stream length when queue-depth gate is disabled", () => {
    const result = evaluateOutboundWebhookBackpressure(
      { pendingCount: 10, streamLength: 500_000 },
      { maxPending: 200, maxQueueDepth: 0, retryAfterSeconds: 7, maxTargetsPerRequest: 100 },
    );
    expect(result).toEqual({ reject: false });
  });
});

describe("resolveOutboundWebhookBackpressureConfigFromEnv", () => {
  it("defaults queue-depth gate to disabled to avoid stream-history false positives", () => {
    const previous = process.env["OUTBOUND_WEBHOOK_MAX_QUEUE_DEPTH"];
    delete process.env["OUTBOUND_WEBHOOK_MAX_QUEUE_DEPTH"];
    const config = resolveOutboundWebhookBackpressureConfigFromEnv();
    expect(config.maxQueueDepth).toBe(0);
    if (previous === undefined) delete process.env["OUTBOUND_WEBHOOK_MAX_QUEUE_DEPTH"];
    else process.env["OUTBOUND_WEBHOOK_MAX_QUEUE_DEPTH"] = previous;
  });

  it("allows explicit queue-depth thresholds via env when desired", () => {
    const previous = process.env["OUTBOUND_WEBHOOK_MAX_QUEUE_DEPTH"];
    process.env["OUTBOUND_WEBHOOK_MAX_QUEUE_DEPTH"] = "75000";
    const config = resolveOutboundWebhookBackpressureConfigFromEnv();
    expect(config.maxQueueDepth).toBe(75_000);
    if (previous === undefined) delete process.env["OUTBOUND_WEBHOOK_MAX_QUEUE_DEPTH"];
    else process.env["OUTBOUND_WEBHOOK_MAX_QUEUE_DEPTH"] = previous;
  });
});
