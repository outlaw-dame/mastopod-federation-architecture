import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
const script = resolve("interop/ap/scripts/assert-real-native-inbound-accept.mjs");

function run(overrides: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "native-inbound-accept-"));
  directories.push(directory);
  const originPath = join(directory, "origin.json");
  const evidencePath = join(directory, "inbound.jsonl");
  const outputPath = join(directory, "result.json");
  writeFileSync(originPath, JSON.stringify({
    ok: true,
    mode: "native",
    activityId: "https://activitypods.test/alice/follows/1",
    actorUri: "https://activitypods.test/alice",
    remoteActorUri: "https://remote.test/users/bob",
  }));
  writeFileSync(evidencePath, `${JSON.stringify({
    schema: "ap.real-inbound-api-call.v1",
    method: "POST",
    path: "/alice/inbox",
    responseStatus: 202,
    bodyBytes: 321,
    bodySha256Base64: "proof-sha",
    activityId: "https://remote.test/accept/1",
    activityType: "Accept",
    actorUri: "https://remote.test/users/bob",
    objectId: "https://activitypods.test/alice/follows/1",
    objectType: "Follow",
    objectActorUri: "https://activitypods.test/alice",
    objectTargetUri: "https://remote.test/users/bob",
    ...overrides,
  })}\n`);
  return spawnSync(process.execPath, [script, evidencePath, originPath, "remote.test", outputPath], { encoding: "utf8" });
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("native inbound Accept assertion", () => {
  it("binds a successful ActivityPods receipt to the exact outgoing Follow", () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      followActivityId: "https://activitypods.test/alice/follows/1",
      acceptActivityId: "https://remote.test/accept/1",
      acceptedByActivityPods: true,
    });
  });

  it.each([
    { objectId: "https://activitypods.test/alice/follows/other" },
    { objectActorUri: "https://activitypods.test/mallory" },
    { objectTargetUri: "https://remote.test/users/eve" },
    { actorUri: "https://evil.test/users/bob" },
    { responseStatus: 401 },
  ])("rejects an uncorrelated or unsuccessful receipt %o", overrides => {
    expect(run(overrides).status).not.toBe(0);
  });
});
