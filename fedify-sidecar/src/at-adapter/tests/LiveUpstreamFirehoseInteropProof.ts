import {
  AtIngressHttpClient,
  AT_VERIFY_FAILED_TOPIC,
  DefaultAtFirehoseConsumer,
  DefaultAtFirehoseDecoder,
  DefaultAtIngressAuditPublisher,
  DefaultAtIngressVerifier,
  HttpAtIdentityResolver,
  HttpAtSyncRebuilder,
  InMemoryAtFirehoseCursorManager,
  InMemoryAtIngressEventClassifier,
  ProductionAtCommitVerifier,
  parseAtExternalFirehoseSources,
  type AtFirehoseRawEnvelope,
  type AtFirehoseSource,
  type AtIngressEvent,
  type AtVerifyFailedEvent,
} from "../ingress/index.js";
import { InMemoryAtprotoRepoRegistry } from "../../atproto/repo/AtprotoRepoRegistry.js";
import type { EventPublisher } from "../../core-domain/events/CoreIdentityEvents.js";

const DEFAULT_SOURCES = [
  "relay|wss://bsky.network",
].join("\n");
const DEFAULT_PDS_HANDLE = process.env["LIVE_FIREHOSE_PROOF_PDS_HANDLE"] ?? "atproto.com";

const PROOF_TIMEOUT_MS = clampInteger(
  Number.parseInt(process.env["LIVE_FIREHOSE_PROOF_TIMEOUT_MS"] ?? "30000", 10),
  5_000,
  120_000,
);
const HTTP_TIMEOUT_MS = clampInteger(
  Number.parseInt(process.env["LIVE_FIREHOSE_PROOF_HTTP_TIMEOUT_MS"] ?? "12000", 10),
  1_000,
  60_000,
);
const HTTP_MAX_ATTEMPTS = clampInteger(
  Number.parseInt(process.env["LIVE_FIREHOSE_PROOF_HTTP_MAX_ATTEMPTS"] ?? "4", 10),
  1,
  8,
);
const FULL_WINDOW_MODE = process.env["LIVE_FIREHOSE_PROOF_FULL_WINDOW"] === "true";
const FAILURE_SAMPLE_MAX = clampInteger(
  Number.parseInt(process.env["LIVE_FIREHOSE_PROOF_FAILURE_SAMPLE_MAX"] ?? "10", 10),
  0,
  100,
);
const FAILED_RESOLUTION_CACHE_TTL_MS = clampInteger(
  Number.parseInt(process.env["LIVE_FIREHOSE_PROOF_FAILED_RESOLUTION_CACHE_TTL_MS"] ?? "60000", 10),
  0,
  300_000,
);

interface VerifyFailureSample {
  seq: number;
  did: string | null;
  eventType: string;
  reason: string;
  details: Record<string, unknown> | null;
}

interface MissingCarBlockSample {
  seq: number;
  did: string | null;
  cid: string;
}

interface PrevDataOmittedSample {
  seq: number;
  did: string | null;
}

interface SyncRebuildFailedSample {
  seq: number;
  did: string | null;
  reason: string | null;
}

interface SourceSummary {
  sourceId: string;
  sourceType: "relay" | "pds";
  url: string;
  startedAt: string;
  durationMs: number;
  rawFramesSeen: number;
  rawCommitFramesSeen: number;
  verifiedCommitEvents: number;
  verifiedIdentityEvents: number;
  verifiedAccountEvents: number;
  syncRebuildAttempts: number;
  syncRebuildSuccesses: number;
  syncRebuildFailures: number;
  retryableVerifierFailures: number;
  verifyFailedByReason: Record<string, number>;
  verifyFailedByDidReason: Record<string, number>;
  verifyFailureSamples: VerifyFailureSample[];
  verifyFailureSamplesDropped: number;
  syncRebuildFailedByReasonCode: Record<string, number>;
  syncRebuildFailedSamples: SyncRebuildFailedSample[];
  syncRebuildFailedSamplesDropped: number;
  resolverFetchAttempts: number;
  resolverPositiveCacheHits: number;
  resolverNegativeCacheHits: number;
  resolverInFlightDedup: number;
  repoStateMissingCarBlockCount: number;
  repoStateMissingCarBlockByDid: Record<string, number>;
  repoStateMissingCarBlockSamples: MissingCarBlockSample[];
  repoStateMissingCarBlockSamplesDropped: number;
  repoStatePrevDataOmittedNonEmptyCount: number;
  repoStatePrevDataOmittedNonEmptyByDid: Record<string, number>;
  repoStatePrevDataOmittedNonEmptySamples: PrevDataOmittedSample[];
  repoStatePrevDataOmittedNonEmptySamplesDropped: number;
  firstVerifiedDid: string | null;
  firstVerifiedCollection: string | null;
  firstFailureReason: string | null;
  firstFailureDid: string | null;
  firstFailureDetails: Record<string, unknown> | null;
  passed: boolean;
  passMode: "verified_commit" | "sync_rebuild" | null;
  note: string | null;
}

async function main(): Promise<void> {
  const explicitSources = process.env["LIVE_FIREHOSE_PROOF_SOURCES"];
  const sources = parseAtExternalFirehoseSources(
    explicitSources ?? DEFAULT_SOURCES,
  );
  const shouldDiscoverPds =
    !explicitSources || process.env["LIVE_FIREHOSE_PROOF_DISCOVER_PDS"] === "true";

  if (shouldDiscoverPds) {
    const discoveredPdsSource = await discoverPdsSource(DEFAULT_PDS_HANDLE).catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
    }));

    if ("id" in discoveredPdsSource) {
      if (!sources.some((source) => source.url === discoveredPdsSource.url)) {
        sources.push(discoveredPdsSource);
      }
    } else {
      console.error(
        `[live-firehose-proof] unable to discover public PDS source from handle ${DEFAULT_PDS_HANDLE}: ${discoveredPdsSource.error}`,
      );
    }
  }

  if (sources.length === 0) {
    throw new Error("No live firehose sources were configured");
  }

  const summaries: SourceSummary[] = [];
  for (const source of sources) {
    console.error(
      `[live-firehose-proof] probing ${source.sourceType} source ${source.url} for up to ${PROOF_TIMEOUT_MS}ms`,
    );
    const summary = await proveSource(source);
    summaries.push(summary);
    console.error(
      `[live-firehose-proof] ${source.url} => ${summary.passed ? "PASS" : "FAIL"}`
      + ` (${summary.passMode ?? "no_verified_outcome"})`,
    );
  }

  const output = {
    ok: summaries.every((summary) => summary.passed),
    checkedAt: new Date().toISOString(),
    timeoutMs: PROOF_TIMEOUT_MS,
    sources: summaries,
  };

  console.log(JSON.stringify(output, null, 2));
  if (!output.ok) {
    process.exitCode = 1;
  }
}

async function discoverPdsSource(handle: string): Promise<AtFirehoseSource> {
  const httpClient = new AtIngressHttpClient({
    fetchImpl: fetch,
    timeoutMs: HTTP_TIMEOUT_MS,
    maxAttempts: HTTP_MAX_ATTEMPTS,
  });
  const identityResolver = new HttpAtIdentityResolver({
    fetchImpl: fetch,
    timeoutMs: HTTP_TIMEOUT_MS,
    maxAttempts: HTTP_MAX_ATTEMPTS,
    failedResolutionCacheTtlMs: FAILED_RESOLUTION_CACHE_TTL_MS,
  });
  const did = await resolveHandleToDid(httpClient, handle);
  const resolved = await identityResolver.resolveDocument(did);
  if (!resolved.pdsEndpoint) {
    throw new Error(`resolved DID ${did} for handle ${handle} did not expose an AtprotoPersonalDataServer endpoint`);
  }

  const wsUrl = new URL("/xrpc/com.atproto.sync.subscribeRepos", resolved.pdsEndpoint);
  wsUrl.protocol = wsUrl.protocol === "http:" ? "ws:" : "wss:";

  const [source] = parseAtExternalFirehoseSources(`pds|${wsUrl.toString()}`);
  if (!source || source.sourceType !== "pds") {
    throw new Error(`failed to build PDS firehose source from ${wsUrl.toString()}`);
  }
  return source;
}

async function resolveHandleToDid(httpClient: AtIngressHttpClient, handle: string): Promise<string> {
  const candidateOrigins = [
    "https://public.api.bsky.app",
    "https://api.bsky.app",
  ];

  let lastError: Error | null = null;
  for (const origin of candidateOrigins) {
    try {
      const url = new URL("/xrpc/com.atproto.identity.resolveHandle", origin);
      url.searchParams.set("handle", handle);
      const payload = await httpClient.requestJson(url.toString(), {
        accept: "application/json",
        maxBytes: 64_000,
      });
      const did = typeof payload["did"] === "string" ? payload["did"] : null;
      if (did) {
        return did;
      }
      throw new Error(`handle resolution response from ${origin} was missing did`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error(`Unable to resolve handle ${handle}`);
}

async function proveSource(source: {
  id: string;
  sourceType: "relay" | "pds";
  url: string;
}): Promise<SourceSummary> {
  const startedAt = Date.now();
  const summary: SourceSummary = {
    sourceId: source.id,
    sourceType: source.sourceType,
    url: source.url,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: 0,
    rawFramesSeen: 0,
    rawCommitFramesSeen: 0,
    verifiedCommitEvents: 0,
    verifiedIdentityEvents: 0,
    verifiedAccountEvents: 0,
    syncRebuildAttempts: 0,
    syncRebuildSuccesses: 0,
    syncRebuildFailures: 0,
    retryableVerifierFailures: 0,
    verifyFailedByReason: {},
    verifyFailedByDidReason: {},
    verifyFailureSamples: [],
    verifyFailureSamplesDropped: 0,
    syncRebuildFailedByReasonCode: {},
    syncRebuildFailedSamples: [],
    syncRebuildFailedSamplesDropped: 0,
    resolverFetchAttempts: 0,
    resolverPositiveCacheHits: 0,
    resolverNegativeCacheHits: 0,
    resolverInFlightDedup: 0,
    repoStateMissingCarBlockCount: 0,
    repoStateMissingCarBlockByDid: {},
    repoStateMissingCarBlockSamples: [],
    repoStateMissingCarBlockSamplesDropped: 0,
    repoStatePrevDataOmittedNonEmptyCount: 0,
    repoStatePrevDataOmittedNonEmptyByDid: {},
    repoStatePrevDataOmittedNonEmptySamples: [],
    repoStatePrevDataOmittedNonEmptySamplesDropped: 0,
    firstVerifiedDid: null,
    firstVerifiedCollection: null,
    firstFailureReason: null,
    firstFailureDid: null,
    firstFailureDetails: null,
    passed: false,
    passMode: null,
    note: null,
  };

  const decoder = new DefaultAtFirehoseDecoder();
  const cursorManager = new InMemoryAtFirehoseCursorManager();
  const repoRegistry = new InMemoryAtprotoRepoRegistry();
  const identityResolver = new HttpAtIdentityResolver({
    fetchImpl: fetch,
    timeoutMs: HTTP_TIMEOUT_MS,
    maxAttempts: HTTP_MAX_ATTEMPTS,
    failedResolutionCacheTtlMs: FAILED_RESOLUTION_CACHE_TTL_MS,
  });
  const commitVerifier = new ProductionAtCommitVerifier({
    identityResolver,
    repoRegistry,
  });
  const syncRebuilder = new HttpAtSyncRebuilder({
    repoRegistry,
    identityResolver,
    fetchImpl: fetch,
    timeoutMs: HTTP_TIMEOUT_MS,
    maxAttempts: HTTP_MAX_ATTEMPTS,
  });
  const classifier = new InMemoryAtIngressEventClassifier({ acceptAll: true });

  let verifier: DefaultAtIngressVerifier;
  let resolveSatisfied: ((value: void | PromiseLike<void>) => void) | null = null;
  const satisfied = new Promise<void>((resolve) => {
    resolveSatisfied = resolve;
  });

  const markPassed = (mode: "verified_commit" | "sync_rebuild", note: string): void => {
    if (!summary.passed) {
      summary.passed = true;
      summary.passMode = mode;
      summary.note = note;
    }
    if (!FULL_WINDOW_MODE) {
      resolveSatisfied?.();
    }
  };

  const maybeUpgradePassMode = (mode: "verified_commit" | "sync_rebuild", note: string): void => {
    if (summary.passed && summary.passMode === "verified_commit") {
      return;
    }
    markPassed(mode, note);
  };

  const eventPublisher: EventPublisher = {
    publish: async (topic: string, event: unknown) => {
      if (topic === "at.firehose.raw.v1") {
        const envelope = event as AtFirehoseRawEnvelope;
        summary.rawFramesSeen += 1;
        if (envelope.eventType === "#commit") {
          summary.rawCommitFramesSeen += 1;
        }
        const handled = await verifier.handleRawEvent(envelope);
        if (!handled) {
          summary.retryableVerifierFailures += 1;
        }
        return;
      }

      if (topic === "at.ingress.v1") {
        const ingressEvent = event as AtIngressEvent;
        if (ingressEvent.eventType === "#commit") {
          summary.verifiedCommitEvents += 1;
          summary.firstVerifiedDid ??= ingressEvent.did;
          summary.firstVerifiedCollection ??= ingressEvent.commit?.collection ?? null;
          maybeUpgradePassMode(
            "verified_commit",
            `verified ${ingressEvent.commit?.operation ?? "commit"}`
            + ` ${ingressEvent.commit?.collection ?? "unknown"} for ${ingressEvent.did}`,
          );
          return;
        }

        if (ingressEvent.eventType === "#identity") {
          summary.verifiedIdentityEvents += 1;
          return;
        }

        if (ingressEvent.eventType === "#account") {
          summary.verifiedAccountEvents += 1;
        }
        return;
      }

      if (topic === AT_VERIFY_FAILED_TOPIC) {
        const failure = event as AtVerifyFailedEvent;
        summary.verifyFailedByReason[failure.reason] =
          (summary.verifyFailedByReason[failure.reason] ?? 0) + 1;
        const didReasonKey = `${failure.did ?? "<unknown>"}::${failure.reason}`;
        summary.verifyFailedByDidReason[didReasonKey] =
          (summary.verifyFailedByDidReason[didReasonKey] ?? 0) + 1;

        if (summary.verifyFailureSamples.length < FAILURE_SAMPLE_MAX) {
          summary.verifyFailureSamples.push({
            seq: failure.seq,
            did: failure.did ?? null,
            eventType: failure.eventType,
            reason: failure.reason,
            details: failure.details ?? null,
          });
        } else {
          summary.verifyFailureSamplesDropped += 1;
        }

        const missingCarCid = extractMissingCarBlockCid(failure.details);
        if (failure.reason === "repo_state_invalid" && missingCarCid) {
          summary.repoStateMissingCarBlockCount += 1;
          const didKey = failure.did ?? "<unknown>";
          summary.repoStateMissingCarBlockByDid[didKey] =
            (summary.repoStateMissingCarBlockByDid[didKey] ?? 0) + 1;

          if (summary.repoStateMissingCarBlockSamples.length < FAILURE_SAMPLE_MAX) {
            summary.repoStateMissingCarBlockSamples.push({
              seq: failure.seq,
              did: failure.did ?? null,
              cid: missingCarCid,
            });
          } else {
            summary.repoStateMissingCarBlockSamplesDropped += 1;
          }
        }

        if (failure.reason === "repo_state_invalid" && isPrevDataOmittedNonEmpty(failure.details)) {
          summary.repoStatePrevDataOmittedNonEmptyCount += 1;
          const didKey = failure.did ?? "<unknown>";
          summary.repoStatePrevDataOmittedNonEmptyByDid[didKey] =
            (summary.repoStatePrevDataOmittedNonEmptyByDid[didKey] ?? 0) + 1;
          if (summary.repoStatePrevDataOmittedNonEmptySamples.length < FAILURE_SAMPLE_MAX) {
            summary.repoStatePrevDataOmittedNonEmptySamples.push({
              seq: failure.seq,
              did: failure.did ?? null,
            });
          } else {
            summary.repoStatePrevDataOmittedNonEmptySamplesDropped += 1;
          }
        }

        if (failure.reason === "sync_rebuild_failed") {
          const reasonCode = classifySyncRebuildFailureReason(failure.details);
          summary.syncRebuildFailedByReasonCode[reasonCode] =
            (summary.syncRebuildFailedByReasonCode[reasonCode] ?? 0) + 1;
          if (summary.syncRebuildFailedSamples.length < FAILURE_SAMPLE_MAX) {
            summary.syncRebuildFailedSamples.push({
              seq: failure.seq,
              did: failure.did ?? null,
              reason: typeof failure.details?.["reason"] === "string" ? failure.details["reason"] : null,
            });
          } else {
            summary.syncRebuildFailedSamplesDropped += 1;
          }
        }

        summary.firstFailureReason ??= failure.reason;
        summary.firstFailureDid ??= failure.did ?? null;
        summary.firstFailureDetails ??= failure.details ?? null;
      }
    },
    publishBatch: async (events) => {
      for (const entry of events) {
        await eventPublisher.publish(
          entry.topic,
          entry.event as any,
          entry.metadata,
        );
      }
    },
  };

  let pendingRebuildPromises: Promise<unknown>[] = [];
  const auditPublisher = new DefaultAtIngressAuditPublisher(eventPublisher);
  const trackedSyncRebuilder = {
    rebuildRepo: async (did: string, options?: { source?: string | null }) => {
      summary.syncRebuildAttempts += 1;
      const p = syncRebuilder.rebuildRepo(did, options).then((result) => {
        if (result.success) {
          summary.syncRebuildSuccesses += 1;
          maybeUpgradePassMode(
            "sync_rebuild",
            `verified signed commit path required authoritative repo rebuild for ${did}`,
          );
        } else {
          summary.syncRebuildFailures += 1;
        }
        return result;
      });
      pendingRebuildPromises.push(p.catch(() => {}));
      return p;
    },
  };

  verifier = new DefaultAtIngressVerifier(
    decoder,
    classifier,
    auditPublisher,
    eventPublisher,
    commitVerifier,
    identityResolver,
    trackedSyncRebuilder,
  );

  const consumer = new DefaultAtFirehoseConsumer(
    decoder,
    cursorManager,
    eventPublisher,
  );

  try {
    await consumer.start(source);
    await Promise.race([
      FULL_WINDOW_MODE ? sleep(PROOF_TIMEOUT_MS) : satisfied,
      sleep(PROOF_TIMEOUT_MS),
    ]);
  } finally {
    await consumer.stop(source.id);
    // Drain any in-flight sync rebuild promises so counters are accurate.
    if (pendingRebuildPromises.length > 0) {
      await Promise.allSettled(pendingRebuildPromises);
      pendingRebuildPromises = [];
    }
    summary.durationMs = Date.now() - startedAt;
    const resolverMetrics = identityResolver.getMetrics();
    summary.resolverFetchAttempts = resolverMetrics.fetchAttempts;
    summary.resolverPositiveCacheHits = resolverMetrics.positiveCacheHits;
    summary.resolverNegativeCacheHits = resolverMetrics.negativeCacheHits;
    summary.resolverInFlightDedup = resolverMetrics.inFlightDedup;
  }

  if (!summary.passed) {
    if (summary.rawFramesSeen === 0) {
      summary.note = "timed out before receiving any raw frames";
    } else if (summary.rawCommitFramesSeen === 0) {
      summary.note = "received frames but no commit frames within the proof window";
    } else if (Object.keys(summary.verifyFailedByReason).length > 0) {
      summary.note = `received commit frames but only verification failures: ${JSON.stringify(summary.verifyFailedByReason)}`;
    } else {
      summary.note = "received commit frames but no verified outcome before timeout";
    }
  }

  return summary;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function isPrevDataOmittedNonEmpty(details: Record<string, unknown> | undefined): boolean {
  const reason = typeof details?.["reason"] === "string" ? details["reason"] : null;
  return reason !== null && reason.includes("Commit omitted prevData but the reconstructed previous repository state was not empty");
}

function classifySyncRebuildFailureReason(details: Record<string, unknown> | undefined): string {
  const reason = typeof details?.["reason"] === "string" ? details["reason"] : "";
  if (reason.includes("CAR root") && reason.includes("did not match")) return "car_root_mismatch";
  if (reason.includes("AtprotoPersonalDataServer endpoint")) return "no_pds_endpoint";
  if (/unable to fetch|fetch repo export/i.test(reason)) return "car_fetch_failed";
  if (/timed out|timeout/i.test(reason)) return "timeout";
  if (/fetch failed|network/i.test(reason)) return "network_error";
  if (/http\s*(4[0-9]{2}|5[0-9]{2})/i.test(reason) || /status\s*(4[0-9]{2}|5[0-9]{2})/i.test(reason)) return "http_error";
  if (reason.includes("Unsupported or invalid DID")) return "invalid_did";
  if (reason.includes("did not contain") || reason.includes("pds") || reason.includes("PDS")) return "no_pds_endpoint";
  if (reason.includes("getLatestCommit") || reason.includes("latest commit") || reason.includes("cid") || reason.includes("rev")) return "commit_fetch_failed";
  if (reason !== "") return "other";
  return "no_reason";
}

function extractMissingCarBlockCid(details: Record<string, unknown> | undefined): string | null {
  const reason = typeof details?.["reason"] === "string" ? details["reason"] : null;
  if (!reason) {
    return null;
  }
  const match = reason.match(/Missing CAR block\s+([a-z0-9]+)/i);
  return match?.[1] ?? null;
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
