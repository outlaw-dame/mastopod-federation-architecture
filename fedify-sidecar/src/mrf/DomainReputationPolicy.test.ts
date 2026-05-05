import { describe, expect, it } from "vitest";
import { ensureDefaultModuleConfigs } from "../admin/mrf/bootstrap.js";
import { InMemoryMRFAdminStore } from "../admin/mrf/store.memory.js";
import { InMemoryDomainReputationStore } from "../delivery/DomainReputationStore.js";
import { evaluateDomainReputation } from "./DomainReputationPolicy.js";

const NOW = () => "2026-04-27T12:00:00.000Z";

async function makeStore(mode: "dry-run" | "enforce" = "enforce") {
  const mrf = new InMemoryMRFAdminStore(NOW);
  await ensureDefaultModuleConfigs(mrf, NOW);
  const current = await mrf.getModuleConfig("domain-reputation");
  if (!current) throw new Error("domain-reputation module missing from registry");
  await mrf.setModuleConfig("domain-reputation", { ...current, enabled: true, mode });
  return mrf;
}

describe("evaluateDomainReputation", () => {
  it("returns null when mrfStore is null", async () => {
    const domainStore = new InMemoryDomainReputationStore();
    const result = await evaluateDomainReputation(null, domainStore, {
      activityId: "https://remote.example/activities/1",
      actorUri: "https://remote.example/users/alice",
      domains: ["blocked.example.com"],
    });
    expect(result).toBeNull();
  });

  it("returns null when domainStore is null", async () => {
    const mrf = await makeStore();
    const result = await evaluateDomainReputation(mrf, null, {
      activityId: "https://remote.example/activities/2",
      actorUri: "https://remote.example/users/alice",
      domains: ["blocked.example.com"],
    });
    expect(result).toBeNull();
  });

  it("returns null when domains list is empty", async () => {
    const mrf = await makeStore();
    const domainStore = new InMemoryDomainReputationStore();
    await domainStore.addDomain("blocked.example.com", false);
    const result = await evaluateDomainReputation(mrf, domainStore, {
      activityId: "https://remote.example/activities/3",
      actorUri: "https://remote.example/users/alice",
      domains: [],
    });
    expect(result).toBeNull();
  });

  it("returns null when module is disabled", async () => {
    const mrf = new InMemoryMRFAdminStore(NOW);
    await ensureDefaultModuleConfigs(mrf, NOW);
    const current = await mrf.getModuleConfig("domain-reputation");
    if (!current) throw new Error("missing");
    await mrf.setModuleConfig("domain-reputation", { ...current, enabled: false });

    const domainStore = new InMemoryDomainReputationStore();
    await domainStore.addDomain("blocked.example.com", false);

    const result = await evaluateDomainReputation(mrf, domainStore, {
      activityId: "https://remote.example/activities/4",
      actorUri: "https://remote.example/users/alice",
      domains: ["blocked.example.com"],
    });
    expect(result).toBeNull();
  });

  it("returns null when no domain in list is blocked", async () => {
    const mrf = await makeStore();
    const domainStore = new InMemoryDomainReputationStore();
    await domainStore.addDomain("blocked.example.com", false);

    const result = await evaluateDomainReputation(mrf, domainStore, {
      activityId: "https://remote.example/activities/5",
      actorUri: "https://remote.example/users/alice",
      domains: ["safe.example.com", "also.safe.example.com"],
    });
    expect(result).toBeNull();
  });

  it("blocks a matched domain in enforce mode", async () => {
    const mrf = await makeStore("enforce");
    const domainStore = new InMemoryDomainReputationStore();
    await domainStore.addDomain("spam.example.com", false);

    const result = await evaluateDomainReputation(mrf, domainStore, {
      activityId: "https://remote.example/activities/6",
      actorUri: "https://remote.example/users/alice",
      domains: ["spam.example.com"],
    }, { now: NOW, requestId: "req-dr-test-1" });

    expect(result).not.toBeNull();
    expect(result!.moduleId).toBe("domain-reputation");
    expect(result!.matchedDomain).toBe("spam.example.com");
    expect(result!.desiredAction).toBeDefined();
    // In enforce mode the applied action equals the desired action
    expect(result!.appliedAction).toBe(result!.desiredAction);
    expect(result!.appliedAction).not.toBe("accept");
  });

  it("records desiredAction but applies accept in dry-run mode", async () => {
    const mrf = await makeStore("dry-run");
    const domainStore = new InMemoryDomainReputationStore();
    await domainStore.addDomain("spam.example.com", false);

    const result = await evaluateDomainReputation(mrf, domainStore, {
      activityId: "https://remote.example/activities/7",
      actorUri: "https://remote.example/users/alice",
      domains: ["spam.example.com"],
    }, { now: NOW, requestId: "req-dr-test-2" });

    expect(result).not.toBeNull();
    expect(result!.appliedAction).toBe("accept");
    expect(["filter", "reject", "label"]).toContain(result!.desiredAction);
  });

  it("stops at the first matched domain and ignores subsequent domains", async () => {
    const mrf = await makeStore("enforce");
    const domainStore = new InMemoryDomainReputationStore();
    await domainStore.addDomain("first-blocked.example.com", false);
    await domainStore.addDomain("second-blocked.example.com", false);

    const result = await evaluateDomainReputation(mrf, domainStore, {
      activityId: "https://remote.example/activities/8",
      actorUri: "https://remote.example/users/alice",
      domains: ["safe.example.com", "first-blocked.example.com", "second-blocked.example.com"],
    }, { now: NOW, requestId: "req-dr-test-3" });

    expect(result).not.toBeNull();
    expect(result!.matchedDomain).toBe("first-blocked.example.com");
  });

  it("writes a trace entry for matched domain", async () => {
    const mrf = await makeStore("enforce");
    const domainStore = new InMemoryDomainReputationStore();
    await domainStore.addDomain("spam.example.com", false);

    await evaluateDomainReputation(mrf, domainStore, {
      activityId: "https://remote.example/activities/9",
      actorUri: "https://remote.example/users/alice",
      domains: ["spam.example.com"],
    }, { now: NOW, requestId: "req-dr-trace" });

    const traces = await mrf.listTraces({ limit: 10 });
    const trace = traces.items.find((t) => t.moduleId === "domain-reputation");
    expect(trace).toBeDefined();
    expect(trace!.activityId).toBe("https://remote.example/activities/9");
  });
});
