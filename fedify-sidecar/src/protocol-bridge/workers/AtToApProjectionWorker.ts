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
  ) {}

  public async process(event: unknown, translationContext: TranslationContext): Promise<CanonicalIntent | null> {
    const intent = await this.translators.translate(event, translationContext);
    if (!intent) {
      return null;
    }

    if (intent.provenance.projectionMode === "mirrored" && intent.provenance.originProtocol === "activitypub") {
      return intent;
    }

    // Publish to canonical.v1 before projection — captures intent even if
    // projection fails. Fault-isolated: errors are logged but not rethrown.
    if (this.canonicalPublisher) {
      await this.canonicalPublisher.publish(intent).catch(() => undefined);
    }

    const record = await this.ledger.get(intent.canonicalIntentId);
    if (record?.projectedToActivityPub) {
      return intent;
    }

    const policyResult = await this.policy.evaluate(intent);
    if (!policyResult.allowed) {
      return intent;
    }

    const effectiveIntent = mergePolicyWarnings(intent, policyResult.warnings);
    const projection = await this.projectors.project(effectiveIntent, this.projectionContext);
    if (projection.kind === "unsupported") {
      return effectiveIntent;
    }
    if (projection.kind === "error") {
      throw new Error(`${projection.code}: ${projection.message}`);
    }

    await withRetry(() => this.publishPort.publish(projection.commands), this.retryPolicy, this.retryClassifier);
    await this.ledger.markProjected(intent.canonicalIntentId, intent.sourceProtocol, "activitypub");
    return effectiveIntent;
  }
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
