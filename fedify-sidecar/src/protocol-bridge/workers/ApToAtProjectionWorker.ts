import type { CanonicalIntent } from "../canonical/CanonicalIntent.js";
import type {
  AtProjectionCommand,
  AtprotoWritePort,
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

export class ApToAtProjectionWorker {
  private readonly retryClassifier = new DefaultRetryClassifier();

  public constructor(
    private readonly translators: TranslatorRegistry<unknown>,
    private readonly projectors: ProjectorRegistry<AtProjectionCommand>,
    private readonly policy: PolicyPort,
    private readonly ledger: ProjectionLedgerPort,
    private readonly writePort: AtprotoWritePort,
    private readonly projectionContext: ProjectionContext,
    private readonly retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY,
  ) {}

  public async process(event: unknown, translationContext: TranslationContext): Promise<CanonicalIntent | null> {
    const intent = await this.translators.translate(event, translationContext);
    if (!intent) {
      return null;
    }

    if (intent.provenance.projectionMode === "mirrored" && intent.provenance.originProtocol === "atproto") {
      return intent;
    }

    const record = await this.ledger.get(intent.canonicalIntentId);
    if (record?.projectedToAtproto) {
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

    await withRetry(() => this.writePort.apply(projection.commands), this.retryPolicy, this.retryClassifier);
    await this.ledger.markProjected(intent.canonicalIntentId, intent.sourceProtocol, "atproto");
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
