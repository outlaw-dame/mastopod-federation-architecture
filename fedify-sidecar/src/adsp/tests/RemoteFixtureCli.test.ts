import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAdspRemoteFixtureCaseFile } from "../RemoteFixtureCli.js";

const tempRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "adsp-remote-fixture-"));
  tempRoots.push(root);
  return root;
}

function validCase() {
  const activityId = "https://pods.example/alice/activities/cli-1";
  return {
    scenario: "success",
    jobId: `${activityId}::http://127.0.0.1:18080/inbox/success`,
    handoff: {
      deliveryPlanIntentId: `apdm-v1-${"a".repeat(64)}`,
      actorUri: "https://pods.example/alice",
      activityId,
      activity: { id: activityId, type: "Create", actor: "https://pods.example/alice" },
      target: { inboxUrl: "http://127.0.0.1:18080/inbox/success" },
    },
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("loadAdspRemoteFixtureCaseFile", () => {
  it("loads a bounded regular JSON case through the strict case parser", async () => {
    const root = await tempRoot();
    const path = join(root, "case.json");
    const fixtureCase = validCase();
    await writeFile(path, JSON.stringify(fixtureCase), "utf8");

    await expect(loadAdspRemoteFixtureCaseFile(path)).resolves.toEqual(fixtureCase);
  });

  it("rejects directories before attempting to parse them", async () => {
    const root = await tempRoot();
    const path = join(root, "not-a-file");
    await mkdir(path);

    await expect(loadAdspRemoteFixtureCaseFile(path)).rejects.toThrow(/regular file/u);
  });

  it("rejects an oversized case before reading or parsing its contents", async () => {
    const root = await tempRoot();
    const path = join(root, "oversized.json");
    await writeFile(path, "x".repeat(33), "utf8");

    await expect(loadAdspRemoteFixtureCaseFile(path, 32)).rejects.toThrow(/exceeds 32 bytes/u);
  });

  it("rejects malformed JSON without leaking parser internals", async () => {
    const root = await tempRoot();
    const path = join(root, "malformed.json");
    await writeFile(path, "{not-json", "utf8");

    await expect(loadAdspRemoteFixtureCaseFile(path)).rejects.toThrow(
      "fixture case file contains malformed JSON",
    );
  });

  it("passes decoded input through strict shape validation", async () => {
    const root = await tempRoot();
    const path = join(root, "unsupported.json");
    await writeFile(path, JSON.stringify({ ...validCase(), hiddenOverride: true }), "utf8");

    await expect(loadAdspRemoteFixtureCaseFile(path)).rejects.toThrow(/unsupported field/u);
  });
});
