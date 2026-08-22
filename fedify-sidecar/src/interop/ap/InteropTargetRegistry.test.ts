import { describe, expect, it } from "vitest";
import {
  AP_INTEROP_TARGETS,
  assertInteropTargetRegistry,
  getInteropTarget,
} from "./InteropTargetRegistry.js";

const REQUIRED_ACTIVE_PHASE_FAMILIES = [
  "gotosocial",
  "mastodon",
  "akkoma",
  "misskey",
  "pixelfed",
  "peertube",
  "lemmy",
  "wordpress-activitypub",
  "ghost",
  "writefreely",
  "bonfire",
  "mobilizon",
] as const;

const REQUESTED_ADDITIONS = [
  "bonfire",
  "castopod",
  "emissary-bandwagon",
  "friendica",
  "funkwhale",
  "ghost",
  "loops",
  "owncast",
  "peertube",
  "pixelfed",
  "microblog-hosted",
  "misskey",
  "write-as-hosted",
  "vernissage",
] as const;

describe("ActivityPub interop target registry", () => {
  it("is internally valid", () => {
    expect(() => assertInteropTargetRegistry()).not.toThrow();
  });

  it("retains every canonical family already required by the active hardening phase", () => {
    const canonicalIds = new Set(AP_INTEROP_TARGETS.map((target) => target.id));
    for (const id of REQUIRED_ACTIVE_PHASE_FAMILIES) {
      expect(canonicalIds.has(id), `missing canonical active-phase target ${id}`).toBe(true);
    }
  });

  it("adds every newly requested platform without replacing the active-phase set", () => {
    const canonicalIds = new Set(AP_INTEROP_TARGETS.map((target) => target.id));
    for (const id of REQUESTED_ADDITIONS) {
      expect(canonicalIds.has(id), `missing canonical requested target ${id}`).toBe(true);
    }
  });

  it("resolves Bandwagon to the Emissary-based target", () => {
    expect(getInteropTarget("bandwagon")?.id).toBe("emissary-bandwagon");
    expect(getInteropTarget("emissary")?.sourceRepository).toBe("EmissarySocial/emissary");
  });

  it("keeps Micro.blog and exact Write.as out of required local CI", () => {
    for (const id of ["microblog-hosted", "write-as-hosted"]) {
      const target = getInteropTarget(id);
      expect(target?.status).toBe("hosted_only");
      expect(target?.ciTier).toBe("manual_only");
      expect(target?.executionModes).not.toContain("local_container");
      expect(target?.executionModes).toContain("opt_in_external");
    }
  });

  it("does not mislabel WriteFreely as exact Write.as conformance", () => {
    const writeFreely = getInteropTarget("writefreely");
    const writeAs = getInteropTarget("write-as-hosted");
    expect(writeFreely?.id).not.toBe(writeAs?.id);
    expect(writeFreely?.status).toBe("planned");
    expect(writeAs?.status).toBe("hosted_only");
  });

  it("requires every planned local implementation to be pinned before enable", () => {
    const plannedLocal = AP_INTEROP_TARGETS.filter((target) =>
      target.status === "planned" && target.executionModes.includes("local_container"),
    );
    expect(plannedLocal.length).toBeGreaterThan(0);
    expect(plannedLocal.every((target) => target.versionPolicy === "pin_before_enable")).toBe(true);
  });
});
