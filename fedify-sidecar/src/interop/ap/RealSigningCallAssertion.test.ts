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
  signedHeaders?: string;
  algorithm?: string;
  date?: string;
  duplicate?: boolean;
  malformedJson?: boolean;
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
  const keyId = overrides.keyId ?? `${activity.actor}#main-key`;
  const signedHeaders = overrides.signedHeaders ?? "(request-target) host date digest";
  const call = {
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
        Date: overrides.date ?? "Fri, 21 Aug 2026 12:00:00 GMT",
        Signature: `keyId="${keyId}",algorithm="rsa-sha256",headers="${signedHeaders}",signature="proof"`,
        Digest: overrides.digest ?? `SHA-256=${bodySha256Base64}`
      },
      meta: { keyId, algorithm: overrides.algorithm ?? "rsa-sha256", signedHeaders, bodySha256Base64 }
    }] }
  };
  writeFileSync(callsPath, overrides.malformedJson
    ? '{not-json}\n'
    : `${JSON.stringify(call)}\n${overrides.duplicate ? `${JSON.stringify(call)}\n` : ""}`);
  return { callsPath, originPath, bodySha256Base64, keyId, signedHeaders };
}

function run(callsPath: string, originPath: string) {
  return spawnSync(process.execPath, [script, callsPath, originPath, "mastodon"], { encoding: "utf8" });
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("real ActivityPods signing call assertion", () => {
  it("accepts only a digest-bound POST Follow for the external handoff and preserves exact signed headers", () => {
    const paths = fixture();
    const result = run(paths.callsPath, paths.originPath);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      activityId: "https://activitypods/outbox/follow-1",
      deliveredInboxPaths: ["/inbox"],
      successfulSigningCalls: 1,
      signature: `keyId="${paths.keyId}",algorithm="rsa-sha256",headers="${paths.signedHeaders}",signature="proof"`,
      date: "Fri, 21 Aug 2026 12:00:00 GMT",
      digest: `SHA-256=${paths.bodySha256Base64}`,
    });
  });

  it.each([
    [{ profile: "ap_get_v1" }, "GET-profile substitution"],
    [{ digest: "SHA-256=wrong" }, "body digest mismatch"],
    [{ originMode: "native" }, "non-external origin evidence"],
    [{ requestPath: "/users/bob/inbox" }, "signed path outside the selected shared inbox"],
    [{ keyId: "https://activitypods/users/alice/keys/main" }, "stored key document leaked instead of the public signing alias"],
    [{ deliveryUrl: "https://mastodon/users/bob/inbox" }, "delivery URL inconsistent with the authoritative shared inbox"],
    [{ remoteTargetActorUri: "https://mastodon/users/mallory" }, "remote target actor drift"],
    [{ signedHeaders: "(request-target) host date" }, "digest omitted from the signed components"],
    [{ algorithm: "hs2019" }, "unexpected signing algorithm"],
    [{ date: "not-a-date" }, "invalid signed Date header"],
    [{ duplicate: true }, "duplicate successful signing calls"],
    [{ malformedJson: true }, "malformed evidence"],
  ])("rejects %s (%s)", (overrides, _label) => {
    const paths = fixture(overrides);
    expect(run(paths.callsPath, paths.originPath).status).not.toBe(0);
  });
});
