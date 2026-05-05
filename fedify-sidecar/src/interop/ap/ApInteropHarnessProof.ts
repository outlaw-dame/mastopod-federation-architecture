import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createClient } from "redis";
import { SigningClient } from "../../signing/signing-client.js";

import {
  buildCreateNoteWithVideoAttachment,
  buildFollowActivity,
  extractRemoteInboxTarget,
  matchesAcceptForFollow,
  matchesRejectForFollow,
  requiresSignedActivityPubGet,
  selectActivityPubSelfLink,
} from "./lib.js";

const TARGET = process.env["AP_INTEROP_TARGET"] || "gotosocial";
const TARGET_HOST = process.env["AP_INTEROP_TARGET_HOST"] || resolveTargetHost(TARGET);
const TARGET_USERNAME = process.env["AP_INTEROP_TARGET_USERNAME"] || "interop";
const TARGET_ACCT = process.env["AP_INTEROP_TARGET_ACCT"] || `${TARGET_USERNAME}@${TARGET_HOST}`;
const SIDECAR_WEBHOOK_URL =
  process.env["AP_INTEROP_SIDECAR_WEBHOOK_URL"] || "http://fedify-sidecar:8080/webhook/outbox";
const SIDECAR_TOKEN = process.env["AP_INTEROP_SIDECAR_TOKEN"] || "interop-outbox-token";
const SIDECAR_ACTOR_URI =
  process.env["AP_INTEROP_SIDECAR_ACTOR_URI"]
  || `https://sidecar/users/interop-${randomUUID().slice(0, 12)}`;
const REDIS_URL = process.env["AP_INTEROP_REDIS_URL"] || "redis://redis:6379";
const INBOUND_STREAM_KEY = process.env["AP_INTEROP_INBOUND_STREAM_KEY"] || "ap:queue:inbound:v1";
const TIMEOUT_MS = Number.parseInt(process.env["AP_INTEROP_TIMEOUT_MS"] || "120000", 10);
const ACTIVITYPODS_URL = process.env["AP_INTEROP_ACTIVITYPODS_URL"] || "http://mock-activitypods:8793";
const ACTIVITYPODS_TOKEN = process.env["AP_INTEROP_ACTIVITYPODS_TOKEN"] || "interop-activitypods-token";
const ATTACHMENT_PROOF_ENABLED = process.env["AP_INTEROP_ATTACHMENT_PROOF_ENABLED"] !== "false";
const MEDIA_FIXTURE_NAME = process.env["AP_INTEROP_MEDIA_FIXTURE_NAME"] || "sample.mp4";
const MEDIA_FIXTURE_TYPE = process.env["AP_INTEROP_MEDIA_FIXTURE_TYPE"] || "video/mp4";
const MEDIA_FIXTURE_URL =
  process.env["AP_INTEROP_MEDIA_FIXTURE_URL"] || `https://sidecar/interop-fixtures/${MEDIA_FIXTURE_NAME}`;
const MEDIA_FIXTURE_ACCESS_URL =
  process.env["AP_INTEROP_MEDIA_FIXTURE_ACCESS_URL"]
  || `http://fedify-sidecar:8080/internal/interop/fixtures/${encodeURIComponent(MEDIA_FIXTURE_NAME)}/accesses`;
const RESULT_PATH = process.env["AP_INTEROP_RESULT_PATH"] || "";
const FIXTURE_OBSERVE_TIMEOUT_MS = Number.parseInt(
  process.env["AP_INTEROP_FIXTURE_OBSERVE_TIMEOUT_MS"] || "15000",
  10,
);
const POST_FOLLOW_SETTLE_MS = Number.parseInt(
  process.env["AP_INTEROP_POST_FOLLOW_SETTLE_MS"] || "2500",
  10,
);
const FOLLOW_ACTIVITY_ID =
  process.env["AP_INTEROP_FOLLOW_ACTIVITY_ID"]
  || `${SIDECAR_ACTOR_URI.replace(/\/+$/, "")}/activities/follow-${randomUUID()}`;
const PROVIDER_ACTOR_URI = "https://sidecar/users/provider";
const PROVIDER_ACTOR_ALIAS_URI = "https://sidecar/actor";
const LEGACY_PROVIDER_ACTOR_URI = "https://sidecar/users/moderation";

function resolveTargetHost(target: string): string {
  switch (target) {
    case "mastodon":
      return "mastodon";
    case "akkoma":
      return "akkoma";
    case "gotosocial":
    default:
      return "gotosocial";
  }
}

interface BackoffOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
}

const DEFAULT_BACKOFF: BackoffOptions = {
  baseDelayMs: 500,
  maxDelayMs: 5_000,
  multiplier: 2,
};

async function main(): Promise<void> {
  console.log("========================================================");
  console.log(" AP Interop Harness Proof");
  console.log("========================================================");
  console.log(` target:          ${TARGET}`);
  console.log(` target acct:     ${TARGET_ACCT}`);
  console.log(` sidecar webhook: ${SIDECAR_WEBHOOK_URL}`);
  console.log(` sidecar actor:   ${SIDECAR_ACTOR_URI}`);
  console.log("========================================================");

  const deadline = Date.now() + TIMEOUT_MS;
  const discoverySigningClient = new SigningClient({
    baseUrl: ACTIVITYPODS_URL,
    token: ACTIVITYPODS_TOKEN,
    maxBatchSize: 25,
    maxBodyBytes: 1024 * 1024,
    timeoutMs: 10_000,
    maxRetries: 3,
    retryDelayMs: 250,
  });

  const actorDocument = await withBackoff(
    async () => {
      const webFinger = await fetchJson(
        `https://${TARGET_HOST}/.well-known/webfinger?resource=acct:${encodeURIComponent(TARGET_ACCT)}`,
        {
          Accept: "application/jrd+json, application/json",
        },
      );
      const actorUrl = selectActivityPubSelfLink(webFinger as import("./lib.js").WebFingerDocument);
      return fetchActivityPubJson(actorUrl, {
        localActorUri: SIDECAR_ACTOR_URI,
        signingClient: discoverySigningClient,
      });
    },
    {
      deadline,
      label: `discover remote actor ${TARGET_ACCT}`,
    },
  );

  const remoteTarget = extractRemoteInboxTarget(actorDocument);
  const lockedFollowers =
    typeof (actorDocument as Record<string, unknown>)["manuallyApprovesFollowers"] === "boolean"
      ? Boolean((actorDocument as Record<string, unknown>)["manuallyApprovesFollowers"])
      : false;
  if (lockedFollowers) {
    throw new Error(
      `Remote actor ${remoteTarget.actorId} requires manual approval for followers; unlock the interop test account first.`,
    );
  }

  const followActivity = buildFollowActivity({
    actorUri: SIDECAR_ACTOR_URI,
    targetActorUri: remoteTarget.actorId,
    id: FOLLOW_ACTIVITY_ID,
  });

  const redis = createClient({ url: REDIS_URL });
  await redis.connect();

  try {
    const startedAt = Date.now();
    await postWebhook(followActivity, remoteTarget);
    const inboundAccept = await waitForAccept(redis, {
      deadline,
      startedAt,
      followActivityId: followActivity.id,
      localActorUri: SIDECAR_ACTOR_URI,
      remoteActorUri: remoteTarget.actorId,
    });
    if (POST_FOLLOW_SETTLE_MS > 0) {
      await sleep(POST_FOLLOW_SETTLE_MS);
    }

    const providerActorProof = await verifyProviderActorSurface({
      deadline,
      remoteActorUri: remoteTarget.actorId,
    });

    const attachmentProof = ATTACHMENT_PROOF_ENABLED
      ? await runAttachmentProof({
          deadline,
          remoteTarget,
          remoteActorUri: remoteTarget.actorId,
        })
      : undefined;

    const result = {
      ok: true,
      target: TARGET,
      targetAcct: TARGET_ACCT,
      remoteActorUri: remoteTarget.actorId,
      followActivityId: followActivity.id,
      inboundMessageId: inboundAccept.messageId,
      inboundReceivedAt: inboundAccept.receivedAt,
      verification: inboundAccept.verification,
      providerActorProof,
      ...(attachmentProof ? { attachmentProof } : {}),
    };

    await persistProofResult(result);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await redis.quit().catch(() => redis.disconnect());
  }
}

async function verifyProviderActorSurface(params: {
  deadline: number;
  remoteActorUri: string;
}): Promise<{
  canonicalActorId: string;
  actorAliasId: string;
  legacyActorId: string;
  canonicalInbox: string;
  actorInboxPostStatus: number;
}> {
  const canonicalActor = await withBackoff(
    () => fetchActivityPubJson(PROVIDER_ACTOR_URI, {
      localActorUri: SIDECAR_ACTOR_URI,
      signingClient: new SigningClient({
        baseUrl: ACTIVITYPODS_URL,
        token: ACTIVITYPODS_TOKEN,
        maxBatchSize: 25,
        maxBodyBytes: 1024 * 1024,
        timeoutMs: 10_000,
        maxRetries: 3,
        retryDelayMs: 250,
      }),
    }),
    {
      deadline: params.deadline,
      label: "fetch canonical provider actor",
    },
  ) as Record<string, unknown>;

  const actorAlias = await fetchActivityPubJson(PROVIDER_ACTOR_ALIAS_URI, {
    localActorUri: SIDECAR_ACTOR_URI,
    signingClient: new SigningClient({
      baseUrl: ACTIVITYPODS_URL,
      token: ACTIVITYPODS_TOKEN,
      maxBatchSize: 25,
      maxBodyBytes: 1024 * 1024,
      timeoutMs: 10_000,
      maxRetries: 3,
      retryDelayMs: 250,
    }),
  }) as Record<string, unknown>;

  const legacyActor = await fetchActivityPubJson(LEGACY_PROVIDER_ACTOR_URI, {
    localActorUri: SIDECAR_ACTOR_URI,
    signingClient: new SigningClient({
      baseUrl: ACTIVITYPODS_URL,
      token: ACTIVITYPODS_TOKEN,
      maxBatchSize: 25,
      maxBodyBytes: 1024 * 1024,
      timeoutMs: 10_000,
      maxRetries: 3,
      retryDelayMs: 250,
    }),
  }) as Record<string, unknown>;

  const canonicalActorId = requireString(canonicalActor["id"], "canonical provider actor id");
  const actorAliasId = requireString(actorAlias["id"], "provider actor alias id");
  const legacyActorId = requireString(legacyActor["id"], "legacy provider actor id");
  const canonicalInbox = requireString(canonicalActor["inbox"], "canonical provider inbox");

  if (canonicalActorId !== PROVIDER_ACTOR_URI) {
    throw new Error(`Expected provider actor id ${PROVIDER_ACTOR_URI}, got ${canonicalActorId}`);
  }
  if (actorAliasId !== PROVIDER_ACTOR_URI) {
    throw new Error(`Expected /actor alias to serve canonical id ${PROVIDER_ACTOR_URI}, got ${actorAliasId}`);
  }
  if (legacyActorId !== LEGACY_PROVIDER_ACTOR_URI) {
    throw new Error(`Expected legacy provider actor id ${LEGACY_PROVIDER_ACTOR_URI}, got ${legacyActorId}`);
  }
  if (canonicalInbox !== `${PROVIDER_ACTOR_URI}/inbox`) {
    throw new Error(`Expected provider inbox ${PROVIDER_ACTOR_URI}/inbox, got ${canonicalInbox}`);
  }

  const inboxProbe = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `https://sidecar/interop/provider-inbox-probe/${randomUUID()}`,
    type: "Accept",
    actor: params.remoteActorUri,
    object: FOLLOW_ACTIVITY_ID,
    to: [PROVIDER_ACTOR_URI],
  };
  const inboxResponse = await fetch(`${PROVIDER_ACTOR_ALIAS_URI}/inbox`, {
    method: "POST",
    headers: {
      "content-type": "application/activity+json",
    },
    body: JSON.stringify(inboxProbe),
    signal: AbortSignal.timeout(10_000),
  });

  if (inboxResponse.status !== 202) {
    throw new Error(`POST /actor/inbox returned ${inboxResponse.status}: ${await readBodySnippet(inboxResponse)}`);
  }

  return {
    canonicalActorId,
    actorAliasId,
    legacyActorId,
    canonicalInbox,
    actorInboxPostStatus: inboxResponse.status,
  };
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected ${label} to be a non-empty string`);
  }
  return value;
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status}`);
  }

  return response.json();
}

async function fetchActivityPubJson(
  url: string,
  options: {
    localActorUri: string;
    signingClient: SigningClient;
  },
): Promise<unknown> {
  const acceptHeader =
    'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"';
  const unsignedResponse = await fetch(url, {
    headers: { Accept: acceptHeader },
    signal: AbortSignal.timeout(10_000),
  });

  if (unsignedResponse.ok) {
    return unsignedResponse.json();
  }

  if (!requiresSignedActivityPubGet(unsignedResponse.status)) {
    throw new Error(
      `GET ${url} failed with ${unsignedResponse.status}: ${await readBodySnippet(unsignedResponse)}`,
    );
  }

  const signingResult = await options.signingClient.signOne({
    actorUri: options.localActorUri,
    method: "GET",
    targetUrl: url,
  });

  if (!signingResult.ok) {
    throw new Error(
      `Signing secure GET ${url} failed: ${signingResult.error.code} ${signingResult.error.message}`,
    );
  }

  const signedResponse = await fetch(url, {
    headers: {
      Accept: acceptHeader,
      Date: signingResult.signedHeaders.date,
      Signature: signingResult.signedHeaders.signature,
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!signedResponse.ok) {
    throw new Error(
      `Signed GET ${url} failed with ${signedResponse.status}: ${await readBodySnippet(signedResponse)}`,
    );
  }

  return signedResponse.json();
}

async function readBodySnippet(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  return body.slice(0, 512);
}

async function postWebhook(
  activity: { id?: unknown },
  remoteTarget: ReturnType<typeof extractRemoteInboxTarget>,
): Promise<void> {
  const response = await fetch(SIDECAR_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${SIDECAR_TOKEN}`,
    },
    body: JSON.stringify({
      actorUri: SIDECAR_ACTOR_URI,
      activityId: typeof activity.id === "string" ? activity.id : undefined,
      activity,
      remoteTargets: [
        {
          inboxUrl: remoteTarget.inboxUrl,
          ...(remoteTarget.sharedInboxUrl ? { sharedInboxUrl: remoteTarget.sharedInboxUrl } : {}),
        },
      ],
      meta: {
        visibility: "public",
        isPublicIndexable: false,
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (response.status !== 202) {
    const body = await response.text().catch(() => "");
    throw new Error(`Outbound webhook returned ${response.status}: ${body}`);
  }
}

async function waitForAccept(
  redis: ReturnType<typeof createClient>,
  params: {
    deadline: number;
    startedAt: number;
    followActivityId: string;
    localActorUri: string;
    remoteActorUri: string;
  },
): Promise<{
  messageId: string;
  receivedAt: number;
  verification?: Record<string, unknown>;
}> {
  let attempt = 0;

  while (Date.now() < params.deadline) {
    const entries = await redis.xRevRange(INBOUND_STREAM_KEY, "+", "-", {
      COUNT: 200,
    });

    for (const entry of entries) {
      const receivedAt = Number.parseInt(entry.message["receivedAt"] || "0", 10);
      if (receivedAt < params.startedAt) {
        continue;
      }

      let body: unknown;
      try {
        body = JSON.parse(entry.message["body"] || "{}");
      } catch {
        continue;
      }

      if (
        matchesAcceptForFollow(body, {
          followActivityId: params.followActivityId,
          localActorUri: params.localActorUri,
          remoteActorUri: params.remoteActorUri,
        })
      ) {
        return {
          messageId: entry.id,
          receivedAt,
          ...(entry.message["verification"]
            ? { verification: JSON.parse(entry.message["verification"]) as Record<string, unknown> }
            : {}),
        };
      }

      if (
        matchesRejectForFollow(body, {
          followActivityId: params.followActivityId,
          localActorUri: params.localActorUri,
          remoteActorUri: params.remoteActorUri,
        })
      ) {
        throw new Error(`Remote server rejected follow activity ${params.followActivityId}`);
      }
    }

    const delayMs = computeBackoffDelay(attempt++, DEFAULT_BACKOFF);
    await sleep(delayMs);
  }

  throw new Error(
    `Timed out waiting for Accept of ${params.followActivityId} on inbound stream ${INBOUND_STREAM_KEY}`,
  );
}

async function runAttachmentProof(params: {
  deadline: number;
  remoteTarget: ReturnType<typeof extractRemoteInboxTarget>;
  remoteActorUri: string;
}): Promise<{
  fixtureUrl: string;
  fixtureType: string;
  mediaActivityId: string;
  mediaObjectId: string;
  contentMarker: string;
  publishedAt: string;
  dereferenceObserved: boolean;
  accessCount: number;
  methods: string[];
  firstReceivedAt?: number;
  userAgents: string[];
}> {
  await resetFixtureAccesses();
  const contentMarker = `ap-interop-media-${randomUUID()}`;

  const mediaActivity = buildCreateNoteWithVideoAttachment({
    actorUri: SIDECAR_ACTOR_URI,
    targetActorUri: params.remoteActorUri,
    mediaUrl: MEDIA_FIXTURE_URL,
    mediaType: MEDIA_FIXTURE_TYPE,
    contentMarker,
  });

  await postWebhook(mediaActivity, params.remoteTarget);
  const fixtureAccess = await observeFixtureAccess({
    deadline: Math.min(params.deadline, Date.now() + Math.max(FIXTURE_OBSERVE_TIMEOUT_MS, 1_000)),
  });
  const mediaObject =
    mediaActivity.object && typeof mediaActivity.object === "object" && !Array.isArray(mediaActivity.object)
      ? mediaActivity.object as { id?: unknown }
      : {};

  return {
    fixtureUrl: MEDIA_FIXTURE_URL,
    fixtureType: MEDIA_FIXTURE_TYPE,
    mediaActivityId: mediaActivity.id,
    mediaObjectId: typeof mediaObject.id === "string" ? mediaObject.id : `${mediaActivity.id}#object`,
    contentMarker,
    publishedAt: mediaActivity.published,
    dereferenceObserved: fixtureAccess.accessCount > 0,
    accessCount: fixtureAccess.accessCount,
    methods: fixtureAccess.methods,
    ...(fixtureAccess.firstReceivedAt != null ? { firstReceivedAt: fixtureAccess.firstReceivedAt } : {}),
    userAgents: fixtureAccess.userAgents,
  };
}

async function resetFixtureAccesses(): Promise<void> {
  const response = await fetch(MEDIA_FIXTURE_ACCESS_URL, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${SIDECAR_TOKEN}`,
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (response.status !== 204) {
    const body = await response.text().catch(() => "");
    throw new Error(`Failed to reset fixture access log: ${response.status} ${body}`);
  }
}

async function observeFixtureAccess(params: {
  deadline: number;
}): Promise<{
  accessCount: number;
  methods: string[];
  firstReceivedAt?: number;
  userAgents: string[];
}> {
  let attempt = 0;

  while (Date.now() < params.deadline) {
    const response = await fetch(MEDIA_FIXTURE_ACCESS_URL, {
      headers: {
        authorization: `Bearer ${SIDECAR_TOKEN}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Fixture access query failed with ${response.status}: ${body}`);
    }

    const payload = await response.json() as {
      count?: number;
      accesses?: Array<{ method?: string; receivedAt?: number; userAgent?: string }>;
    };

    const accesses = Array.isArray(payload.accesses) ? payload.accesses : [];
    if (accesses.length > 0) {
      return {
        accessCount: accesses.length,
        methods: [...new Set(accesses
          .map((entry) => entry.method)
          .filter((entry): entry is string => typeof entry === "string" && entry.length > 0))],
        firstReceivedAt: Math.min(...accesses
          .map((entry) => entry.receivedAt)
          .filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry))),
        userAgents: [...new Set(accesses
          .map((entry) => entry.userAgent)
          .filter((entry): entry is string => typeof entry === "string" && entry.length > 0))],
      };
    }

    const delayMs = computeBackoffDelay(attempt++, DEFAULT_BACKOFF);
    await sleep(delayMs);
  }

  return {
    accessCount: 0,
    methods: [],
    userAgents: [],
  };
}

async function withBackoff<T>(
  fn: () => Promise<T>,
  options: {
    deadline: number;
    label: string;
  },
): Promise<T> {
  let attempt = 0;
  let lastError: unknown;

  while (Date.now() < options.deadline) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const delayMs = computeBackoffDelay(attempt++, DEFAULT_BACKOFF);
      await sleep(delayMs);
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Timed out waiting to ${options.label}: ${message}`);
}

function computeBackoffDelay(attempt: number, options: BackoffOptions): number {
  const exponential = Math.min(
    options.baseDelayMs * Math.pow(options.multiplier, attempt),
    options.maxDelayMs,
  );
  const jitter = Math.floor(Math.random() * Math.max(250, Math.floor(exponential / 5)));
  return exponential + jitter;
}

async function persistProofResult(result: Record<string, unknown>): Promise<void> {
  if (RESULT_PATH.length === 0) {
    return;
  }

  await mkdir(dirname(RESULT_PATH), { recursive: true });
  await writeFile(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

main().catch((error) => {
  console.error("[ap-interop-proof] failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
