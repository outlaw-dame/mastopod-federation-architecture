import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
const script = resolve("interop/ap/scripts/assert-real-wire-signature.mjs");

function fixture(overrides: {
  mode?: "native" | "external" | "sidecar_service";
  keyId?: string;
  host?: string;
  activityId?: string;
  digest?: string;
  duplicate?: boolean;
  signingMismatch?: boolean;
  signingSignatureMismatch?: boolean;
  signingDateMismatch?: boolean;
  signingDigestMismatch?: boolean;
  omitAlgorithm?: boolean;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "wire-signature-assertion-"));
  directories.push(directory);
  const mode = overrides.mode ?? "external";
  const actorUri = mode === "sidecar_service"
    ? "https://sidecar/users/relay"
    : "https://activitypods/users/alice";
  const activityId = overrides.activityId ?? `${actorUri}/activities/follow-1`;
  const remoteActorUri = "https://mastodon/users/bob";
  const bodySha = "proof-body-sha";
  const expectedKeyId = mode === "sidecar_service"
    ? `${actorUri}#main-key`
    : `${actorUri}/keys/main`;
  const descriptorPath = join(directory, "descriptor.json");
  const wirePath = join(directory, "wire.jsonl");
  const signingPath = join(directory, "signing.json");
  writeFileSync(descriptorPath, JSON.stringify({
    ok: true,
    mode,
    actorUri,
    activityId,
    remoteActorUri,
    durableHandoffQueued: mode === "external",
    nativeRemotePostSuppressed: mode === "external",
  }));
  const algorithmPart = overrides.omitAlgorithm ? "" : "algorithm=\"rsa-sha256\",";
  const row = {
    schema: "ap.interop.wire-request.v1",
    method: "POST",
    path: "/inbox",
    host: overrides.host ?? "mastodon",
    date: "Sun, 23 Aug 2026 12:00:00 GMT",
    digest: overrides.digest ?? `SHA-256=${bodySha}`,
    signature: `keyId="${overrides.keyId ?? expectedKeyId}",${algorithmPart}headers="(request-target) host date digest",signature="proof"`,
    bodyBytes: 321,
    bodySha256Base64: bodySha,
    activityId,
    activityType: "Follow",
    actorUri,
    objectUri: remoteActorUri,
  };
  writeFileSync(wirePath, `${JSON.stringify(row)}\n${overrides.duplicate ? `${JSON.stringify(row)}\n` : ""}`);
  writeFileSync(signingPath, JSON.stringify({
    ok: true,
    actorUri,
    activityId,
    targetHost: "mastodon",
    signerKeyIds: [expectedKeyId],
    bodySha256Base64: [overrides.signingMismatch ? "wrong" : bodySha],
    successfulSigningCalls: 1,
    requestIds: ["request-1"],
    signature: overrides.signingSignatureMismatch
      ? `keyId="${expectedKeyId}",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="different"`
      : row.signature,
    date: overrides.signingDateMismatch ? "Mon, 24 Aug 2026 12:00:00 GMT" : row.date,
    digest: overrides.signingDigestMismatch ? "SHA-256=other" : row.digest,
  }));
  return { descriptorPath, wirePath, signingPath };
}

function run(paths: ReturnType<typeof fixture>, withSigning = true) {
  return spawnSync(process.execPath, [
    script,
    paths.wirePath,
    paths.descriptorPath,
    "mastodon",
    "",
    ...(withSigning ? [paths.signingPath] : []),
  ], { encoding: "utf8" });
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("real wire signature assertion", () => {
  it("correlates an external ActivityPods wire signature with the exact signer result", () => {
    const result = run(fixture());
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      mode: "external",
      keyId: "https://activitypods/users/alice/keys/main",
      bodySha256Base64: "proof-body-sha",
      algorithm: "rsa-sha256",
      signingCorrelation: {
        exactSignedHeadersMatched: true,
      },
    });
  });

  it("accepts native wire evidence without sidecar signing-API evidence", () => {
    const result = run(fixture({ mode: "native" }), false);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).mode).toBe("native");
  });

  it("binds service actor evidence to its published fragment key", () => {
    const result = run(fixture({ mode: "sidecar_service" }), false);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).keyId).toBe("https://sidecar/users/relay#main-key");
  });

  it.each([
    [{ keyId: "https://sidecar/users/relay#main-key" }, "wrong key authority"],
    [{ host: "other.example" }, "wrong target host"],
    [{ digest: "SHA-256=wrong" }, "wrong body digest"],
    [{ duplicate: true }, "duplicate matching wire request"],
    [{ signingMismatch: true }, "signing/wire body mismatch"],
    [{ signingSignatureMismatch: true }, "signing/wire Signature mismatch"],
    [{ signingDateMismatch: true }, "signing/wire Date mismatch"],
    [{ signingDigestMismatch: true }, "signing/wire Digest mismatch"],
    [{ omitAlgorithm: true }, "missing literal wire algorithm"],
  ])("rejects %s (%s)", (overrides, _label) => {
    expect(run(fixture(overrides)).status).not.toBe(0);
  });
});
