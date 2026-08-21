import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
const script = resolve("interop/ap/scripts/assert-real-signing-call.mjs");

function fixture(overrides: {
  profile?: string;
  digest?: string;
  originMode?: string;
  requestPath?: string;
  keyId?: string;
  deliveryUrl?: string;
  remoteTargetActorUri?: string;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "real-signing-assertion-"));
  directories.push(directory);
  const activity = {
    id: "https://activitypods/outbox/follow-1",
    type: "Follow",
    actor: "https://activitypods/users/alice",
    object: "https://mastodon/users/bob"
  };
  const bytes = JSON.stringify(activity);
  const bodySha256Base64 = createHash("sha256").update(bytes).digest("base64");
  const originPath = join(directory, "origin.json");
  const callsPath = join(directory, "calls.jsonl");
  const deliveryUrl = overrides.deliveryUrl ?? "https://mastodon/inbox";
  writeFileSync(originPath, JSON.stringify({
    ok: true,
    mode: overrides.originMode ?? "external",
    durableHandoffQueued: true,
    nativeRemotePostSuppressed: true,
    actorUri: activity.actor,
    activityId: activity.id,
    remoteActorUri: activity.object,
    remoteDeliveryTarget: {
      actorUri: overrides.remoteTargetActorUri ?? activity.object,
      inboxUrl: "https://mastodon/users/bob/inbox",
      sharedInboxUrl: "https://mastodon/inbox",
      targetDomain: "mastodon",
      deliveryUrl
    }
  }));
  const keyId = overrides.keyId ?? `${activity.actor}/keys/main`;
  writeFileSync(callsPath, `${JSON.stringify({
    schema: "ap.real-signing-api-call.v1",
    path: "/api/internal/signatures/batch",
    responseStatus: 200,
    request: { requests: [{
      requestId: "request-1",
      actorUri: activity.actor,
      method: "POST",
      profile: overrides.profile ?? "ap_post_v1",
      target: { host: "mastodon", path: overrides.requestPath ?? "/inbox", query: "" },
      body: { bytes, encoding: "utf8" }
    }] },
    response: { results: [{
      requestId: "request-1",
      ok: true,
      outHeaders: {
        Signature: `keyId="${keyId}"`,
        Digest: overrides.digest ?? `SHA-256=${bodySha256Base64}`
      },
      meta: { keyId, bodySha256Base64 }
    }] }
  })}\n`);
  return { callsPath, originPath };
}

function run(callsPath: string, originPath: string) {
  return spawnSync(process.execPath, [script, callsPath, originPath, "mastodon"], { encoding: "utf8" });
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("real ActivityPods signing call assertion", () => {
  it("accepts only a digest-bound POST Follow for the external handoff", () => {
    const paths = fixture();
    const result = run(paths.callsPath, paths.originPath);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      activityId: "https://activitypods/outbox/follow-1",
      deliveredInboxPaths: ["/inbox"],
      successfulSigningCalls: 1
    });
  });

  it.each([
    [{ profile: "ap_get_v1" }, "GET-profile substitution"],
    [{ digest: "SHA-256=wrong" }, "body digest mismatch"],
    [{ originMode: "native" }, "non-external origin evidence"],
    [{ requestPath: "/users/bob/inbox" }, "signed path outside the selected shared inbox"],
    [{ keyId: "https://activitypods/users/alice#main-key" }, "legacy key fragment instead of the exact published key document"],
    [{ deliveryUrl: "https://mastodon/users/bob/inbox" }, "delivery URL inconsistent with the authoritative shared inbox"],
    [{ remoteTargetActorUri: "https://mastodon/users/mallory" }, "remote target actor drift"]
  ])("rejects %s (%s)", (overrides, _label) => {
    const paths = fixture(overrides);
    expect(run(paths.callsPath, paths.originPath).status).not.toBe(0);
  });
});
