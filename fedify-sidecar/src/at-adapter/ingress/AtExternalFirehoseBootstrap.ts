import { createHash } from "node:crypto";
import type { AtprotoRepoRegistry } from "../../atproto/repo/AtprotoRepoRegistry.js";
import type { EventPublisher } from "../../core-domain/events/CoreIdentityEvents.js";
import { DefaultAtFirehoseConsumer, type AtFirehoseSource } from "./AtFirehoseConsumer.js";
import { DefaultAtFirehoseCursorManager, type RedisCursorClient } from "./AtFirehoseCursorManager.js";
import { DefaultAtFirehoseDecoder } from "./AtFirehoseDecoder.js";
import { DefaultAtIngressAuditPublisher } from "./AtIngressAuditPublisher.js";
import { RedisAtIngressCheckpointStore, type RedisClient as CheckpointRedisClient } from "./AtIngressCheckpointStore.js";
import { Phase55AEventClassifier, type RedisClassifierClient } from "./AtIngressEventClassifier.js";
import {
  DefaultAtIngressVerifier,
  type AtCommitVerifier,
} from "./AtIngressVerifier.js";
import { AtIngressRuntime, type AtIngressRuntimeConfig, type AtIngressRuntimeLogger } from "./AtIngressRuntime.js";
import { HttpAtIdentityResolver, type HttpAtIdentityResolverOptions } from "./HttpAtIdentityResolver.js";
import { HttpAtSyncRebuilder, type HttpAtSyncRebuilderOptions } from "./HttpAtSyncRebuilder.js";

type AtIngressRedisClient =
  & CheckpointRedisClient
  & RedisCursorClient
  & RedisClassifierClient;

export interface AtExternalFirehoseBootstrapOptions {
  runtimeConfig: AtIngressRuntimeConfig;
  redis: AtIngressRedisClient;
  eventPublisher: EventPublisher;
  repoRegistry: AtprotoRepoRegistry;
  commitVerifier?: AtCommitVerifier | null;
  logger?: AtIngressRuntimeLogger;
  identityResolverOptions?: HttpAtIdentityResolverOptions;
  syncRebuilderOptions?: Omit<HttpAtSyncRebuilderOptions, "repoRegistry" | "identityResolver">;
}

export type AtExternalFirehoseBootstrapResult =
  | {
      kind: "disabled";
      reason: "no_sources" | "missing_commit_verifier";
      message: string;
      sources: AtFirehoseSource[];
      runtime: null;
    }
  | {
      kind: "ready";
      runtime: AtIngressRuntime;
      sources: AtFirehoseSource[];
      identityResolver: HttpAtIdentityResolver;
      syncRebuilder: HttpAtSyncRebuilder;
      verifier: DefaultAtIngressVerifier;
    };

export function buildAtExternalFirehoseBootstrap(
  options: AtExternalFirehoseBootstrapOptions,
): AtExternalFirehoseBootstrapResult {
  if (options.runtimeConfig.sources.length === 0) {
    return {
      kind: "disabled",
      reason: "no_sources",
      message: "No external AT firehose sources were configured",
      sources: [],
      runtime: null,
    };
  }

  if (!options.commitVerifier) {
    return {
      kind: "disabled",
      reason: "missing_commit_verifier",
      message: "A production AT commit verifier is required before external firehose intake can be started",
      sources: options.runtimeConfig.sources,
      runtime: null,
    };
  }

  const decoder = new DefaultAtFirehoseDecoder();
  const checkpointStore = new RedisAtIngressCheckpointStore(options.redis);
  const cursorManager = new DefaultAtFirehoseCursorManager(options.redis, checkpointStore);
  const firehoseConsumer = new DefaultAtFirehoseConsumer(
    decoder,
    cursorManager,
    options.eventPublisher,
  );
  const classifier = new Phase55AEventClassifier(options.redis);
  const auditPublisher = new DefaultAtIngressAuditPublisher(options.eventPublisher);
  const identityResolver = new HttpAtIdentityResolver(options.identityResolverOptions);
  const syncRebuilder = new HttpAtSyncRebuilder({
    repoRegistry: options.repoRegistry,
    identityResolver,
    ...options.syncRebuilderOptions,
  });
  const verifier = new DefaultAtIngressVerifier(
    decoder,
    classifier,
    auditPublisher,
    options.eventPublisher,
    options.commitVerifier,
    identityResolver,
    syncRebuilder,
  );
  const runtime = new AtIngressRuntime({
    config: options.runtimeConfig,
    firehoseConsumer,
    verifier,
    logger: options.logger,
  });

  return {
    kind: "ready",
    runtime,
    sources: options.runtimeConfig.sources,
    identityResolver,
    syncRebuilder,
    verifier,
  };
}

export function parseAtExternalFirehoseSources(raw: string | null | undefined): AtFirehoseSource[] {
  if (!raw) {
    return [];
  }

  const entries = raw
    .split(/[\n,]/g)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const sources: AtFirehoseSource[] = [];

  for (const entry of entries) {
    const source = parseAtExternalFirehoseSourceEntry(entry);
    if (seen.has(source.url)) {
      continue;
    }
    seen.add(source.url);
    sources.push(source);
  }

  return sources;
}

function parseAtExternalFirehoseSourceEntry(entry: string): AtFirehoseSource {
  const pipeIndex = entry.indexOf("|");
  const sourceTypeCandidate = pipeIndex >= 0 ? entry.slice(0, pipeIndex).trim().toLowerCase() : "";
  const rawUrl = pipeIndex >= 0 ? entry.slice(pipeIndex + 1).trim() : entry;
  const sourceType = sourceTypeCandidate === "pds" ? "pds" : "relay";
  const normalizedUrl = normalizeExternalFirehoseSourceUrl(rawUrl);

  return {
    id: buildExternalFirehoseSourceId(sourceType, normalizedUrl),
    url: normalizedUrl,
    sourceType,
  };
}

function normalizeExternalFirehoseSourceUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid external AT firehose source URL: ${rawUrl}`);
  }

  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(`External AT firehose sources must use ws:// or wss://: ${rawUrl}`);
  }

  if (parsed.username || parsed.password) {
    throw new Error(`External AT firehose source URLs must not include credentials: ${rawUrl}`);
  }

  if (parsed.search || parsed.hash) {
    throw new Error(`External AT firehose source URLs must not include query or hash components: ${rawUrl}`);
  }

  return parsed.toString();
}

function buildExternalFirehoseSourceId(sourceType: AtFirehoseSource["sourceType"], url: string): string {
  const digest = createHash("sha256").update(`${sourceType}|${url}`).digest("hex").slice(0, 16);
  return `${sourceType}-${digest}`;
}
