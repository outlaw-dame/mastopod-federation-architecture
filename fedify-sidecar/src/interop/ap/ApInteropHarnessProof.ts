import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createClient } from "redis";
import { SigningClient } from "../../signing/signing-client.js";

import {
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
const FOLLOW_ACTIVITY_ID =
  process.env["AP_INTEROP_FOLLOW_ACTIVITY_ID"]
  || `${SIDECAR_ACTOR_URI.replace(/\/+$/, "")}/activities/follow-${randomUUID()}`;

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

    console.log(
      JSON.stringify(
        {
          ok: true,
          target: TARGET,
          targetAcct: TARGET_ACCT,
          remoteActorUri: remoteTarget.actorId,
          followActivityId: followActivity.id,
          inboundMessageId: inboundAccept.messageId,
          inboundReceivedAt: inboundAccept.receivedAt,
          verification: inboundAccept.verification,
        },
        null,
        2,
      ),
    );
  } finally {
    await redis.quit().catch(() => redis.disconnect());
  }
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
  followActivity: ReturnType<typeof buildFollowActivity>,
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
      activityId: followActivity.id,
      activity: followActivity,
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

main().catch((error) => {
  console.error("[ap-interop-proof] failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
