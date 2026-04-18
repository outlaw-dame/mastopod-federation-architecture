import type { CanonicalIntent } from "../canonical/CanonicalIntent.js";
import type { CanonicalIntentPublisher } from "../canonical/CanonicalIntentPublisher.js";
import type {
  ActivityPubProjectionCommand,
  ActivityPubPublishPort,
  PolicyPort,
  ProjectionContext,
  ProjectionLedgerPort,
  RetryPolicy,
  TranslationContext,
} from "../ports/ProtocolBridgePorts.js";
import { ProjectorRegistry } from "../registry/ProjectorRegistry.js";
import { TranslatorRegistry } from "../registry/TranslatorRegistry.js";
import { DefaultRetryClassifier, withRetry } from "./Retry.js";
import { metrics } from "../../metrics/index.js";
import type { AtIdentityObservationOutcome } from "../identity/ObservedAtIdentityStore.js";
import type { AtIdentityObservationService } from "../identity/AtIdentityObservationService.js";

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
  jitter: "full",
};

export class AtToApProjectionWorker {
  private readonly retryClassifier = new DefaultRetryClassifier();

  public constructor(
    private readonly translators: TranslatorRegistry<unknown>,
    private readonly projectors: ProjectorRegistry<ActivityPubProjectionCommand>,
    private readonly policy: PolicyPort,
    private readonly ledger: ProjectionLedgerPort,
    private readonly publishPort: ActivityPubPublishPort,
    private readonly projectionContext: ProjectionContext,
    private readonly retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY,
    private readonly canonicalPublisher?: CanonicalIntentPublisher,
    private readonly identityObservationService?: AtIdentityObservationService,
  ) {}

  public async process(event: unknown, translationContext: TranslationContext): Promise<CanonicalIntent | null> {
    const intent = await this.translators.translate(event, translationContext);
    if (!intent) {
      metrics.protocolBridgeProjectionOutcomes.inc({
        direction: "at_to_ap",
        outcome: "skipped",
        reason: "untranslated",
      });
      return null;
    }

    if (intent.provenance.projectionMode === "mirrored" && intent.provenance.originProtocol === "activitypub") {
      metrics.protocolBridgeProjectionOutcomes.inc({
        direction: "at_to_ap",
        outcome: "skipped",
        reason: "loopback_mirrored",
      });
      await this.observeIdentity(intent, "skipped_loopback_mirrored");
      return intent;
    }

    // Publish to canonical.v1 before projection — captures intent even if
    // projection fails. Fault-isolated: errors are logged but not rethrown.
    if (this.canonicalPublisher) {
      await this.canonicalPublisher.publish(intent).catch(() => undefined);
    }

    const record = await this.ledger.get(intent.canonicalIntentId);
    if (record?.projectedToActivityPub) {
      metrics.protocolBridgeProjectionOutcomes.inc({
        direction: "at_to_ap",
        outcome: "skipped",
        reason: "already_projected",
      });
      await this.observeIdentity(intent, "skipped_already_projected");
      return intent;
    }

    const policyResult = await this.policy.evaluate(intent);
    if (!policyResult.allowed) {
      metrics.protocolBridgeProjectionOutcomes.inc({
        direction: "at_to_ap",
        outcome: "skipped",
        reason: "policy_denied",
      });
      await this.observeIdentity(intent, "skipped_policy_denied");
      return intent;
    }

    const effectiveIntent = mergePolicyWarnings(intent, policyResult.warnings);
    const projection = await this.projectors.project(effectiveIntent, this.projectionContext);
    if (projection.kind === "unsupported") {
      metrics.protocolBridgeProjectionOutcomes.inc({
        direction: "at_to_ap",
        outcome: "skipped",
        reason: "unsupported",
      });
      await this.observeIdentity(effectiveIntent, "skipped_unsupported");
      return effectiveIntent;
    }
    if (projection.kind === "error") {
      if (isUnboundActorProjectionError(projection.code)) {
        metrics.protocolBridgeProjectionOutcomes.inc({
          direction: "at_to_ap",
          outcome: "skipped",
          reason: "unbound_actor",
        });
        await this.observeIdentity(effectiveIntent, "skipped_unbound_actor");
        return effectiveIntent;
      }

      metrics.protocolBridgeProjectionOutcomes.inc({
        direction: "at_to_ap",
        outcome: "failed",
        reason: "projection_error",
      });
      await this.observeIdentity(effectiveIntent, "failed_projection_error");
      throw new Error(`${projection.code}: ${projection.message}`);
    }

    await withRetry(() => this.publishPort.publish(projection.commands), this.retryPolicy, this.retryClassifier);
    await this.ledger.markProjected(intent.canonicalIntentId, intent.sourceProtocol, "activitypub");
    metrics.protocolBridgeProjectionOutcomes.inc({
      direction: "at_to_ap",
      outcome: "projected",
      reason: "published",
    });
    await this.observeIdentity(effectiveIntent, "projected");
    return effectiveIntent;
  }

  private async observeIdentity(
    intent: CanonicalIntent,
    outcome: AtIdentityObservationOutcome,
  ): Promise<void> {
    if (!this.identityObservationService || intent.sourceProtocol !== "atproto") {
      return;
    }

    await this.identityObservationService.observeActor(
      intent.sourceAccountRef,
      outcome,
      intent.observedAt,
    ).catch(() => undefined);
  }
}

function isUnboundActorProjectionError(code: string): boolean {
  return code.endsWith("ACTOR_URI_MISSING");
}

function mergePolicyWarnings(intent: CanonicalIntent, warnings: CanonicalIntent["warnings"] | undefined): CanonicalIntent {
  if (!warnings || warnings.length === 0) {
    return intent;
  }
  return {
    ...intent,
    warnings: [...intent.warnings, ...warnings],
  };
}
