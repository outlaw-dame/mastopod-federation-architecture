/**
 * The verified Sync v1.1 firehose and unsigned Jetstream are alternative
 * external ingestion sources. They must never run together in one sidecar.
 * Keep local PDS publication (AtFirehoseRuntime) independent of this choice.
 */
export type ExternalAtIngestionSource = "disabled" | "verified" | "jetstream-unverified";

export interface ExternalAtIngestionFlags {
  enableVerifiedFirehose: boolean;
  enableJetstream: boolean;
}

export function selectExternalAtIngestionSource(flags: ExternalAtIngestionFlags): ExternalAtIngestionSource {
  if (flags.enableVerifiedFirehose && flags.enableJetstream) {
    throw new Error(
      "ENABLE_AT_EXTERNAL_FIREHOSE and ENABLE_AT_JETSTREAM are mutually exclusive",
    );
  }
  if (flags.enableVerifiedFirehose) return "verified";
  if (flags.enableJetstream) return "jetstream-unverified";
  return "disabled";
}

/**
 * A selected authoritative ingestion path must either start with a production
 * verifier or abort startup. Silent fallback to a disconnected/unsigned feed
 * causes missing records or a false-ready service.
 */
export function requireVerifiedExternalFirehoseReady(
  state: { kind: string; reason?: string },
): void {
  if (state.kind !== "ready") {
    throw new Error(
      `Verified AT firehose requested but unavailable (${state.reason ?? "not_ready"})`,
    );
  }
}
