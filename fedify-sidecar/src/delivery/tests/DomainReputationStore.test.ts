import { describe, expect, it } from "vitest";
import {
  sanitizeDomain,
  InMemoryDomainReputationStore,
} from "../DomainReputationStore.js";

// ---------------------------------------------------------------------------
// sanitizeDomain
// ---------------------------------------------------------------------------

describe("sanitizeDomain", () => {
  it("accepts well-formed hostnames", () => {
    expect(sanitizeDomain("example.com")).toBe("example.com");
    expect(sanitizeDomain("sub.example.com")).toBe("sub.example.com");
    expect(sanitizeDomain("a.b.c.example.co.uk")).toBe("a.b.c.example.co.uk");
    expect(sanitizeDomain("xn--nxasmq6b.com")).toBe("xn--nxasmq6b.com");
  });

  it("lowercases input", () => {
    expect(sanitizeDomain("EXAMPLE.COM")).toBe("example.com");
    expect(sanitizeDomain("Spam.Example.Org")).toBe("spam.example.org");
  });

  it("strips a numeric port suffix", () => {
    expect(sanitizeDomain("example.com:8080")).toBe("example.com");
    expect(sanitizeDomain("sub.example.com:443")).toBe("sub.example.com");
  });

  it("rejects raw IPv4 addresses", () => {
    expect(sanitizeDomain("192.168.1.1")).toBeNull();
    expect(sanitizeDomain("10.0.0.1")).toBeNull();
    expect(sanitizeDomain("1.2.3.4")).toBeNull();
  });

  it("rejects IPv6 bracket notation", () => {
    expect(sanitizeDomain("[::1]")).toBeNull();
    expect(sanitizeDomain("[2001:db8::1]")).toBeNull();
  });

  it("rejects bare TLD (single label)", () => {
    expect(sanitizeDomain("com")).toBeNull();
    expect(sanitizeDomain("localhost")).toBeNull();
  });

  it("rejects empty string", () => {
    expect(sanitizeDomain("")).toBeNull();
  });

  it("rejects labels with invalid characters", () => {
    expect(sanitizeDomain("exam_ple.com")).toBeNull();
    expect(sanitizeDomain("exam ple.com")).toBeNull();
    expect(sanitizeDomain("exam@ple.com")).toBeNull();
  });

  it("rejects domains exceeding 253 characters", () => {
    const longDomain = "a".repeat(63) + "." + "b".repeat(63) + "." + "c".repeat(63) + "." + "d".repeat(64) + ".com";
    expect(sanitizeDomain(longDomain)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// InMemoryDomainReputationStore
// ---------------------------------------------------------------------------

describe("InMemoryDomainReputationStore", () => {
  it("reports a domain as not blocked initially", async () => {
    const store = new InMemoryDomainReputationStore();
    expect(await store.isDomainBlocked("spam.example.com")).toBe(false);
  });

  it("blocks a domain added as exact match", async () => {
    const store = new InMemoryDomainReputationStore();
    await store.addDomain("spam.example.com", false);
    expect(await store.isDomainBlocked("spam.example.com")).toBe(true);
    // Subdomains are NOT blocked by an exact entry
    expect(await store.isDomainBlocked("sub.spam.example.com")).toBe(false);
    // Parent domain is NOT blocked
    expect(await store.isDomainBlocked("example.com")).toBe(false);
  });

  it("blocks a domain and all subdomains added with subdomainMatch", async () => {
    const store = new InMemoryDomainReputationStore();
    await store.addDomain("evil.example.com", true);
    expect(await store.isDomainBlocked("evil.example.com")).toBe(true);
    expect(await store.isDomainBlocked("sub.evil.example.com")).toBe(true);
    expect(await store.isDomainBlocked("deep.sub.evil.example.com")).toBe(true);
    // Parent is not blocked
    expect(await store.isDomainBlocked("example.com")).toBe(false);
  });

  it("unblocks a domain after removal", async () => {
    const store = new InMemoryDomainReputationStore();
    await store.addDomain("spam.example.com", false);
    await store.removeDomain("spam.example.com", false);
    expect(await store.isDomainBlocked("spam.example.com")).toBe(false);
  });

  it("listDomains returns all entries sorted alphabetically", async () => {
    const store = new InMemoryDomainReputationStore();
    await store.addDomain("z.example.com", false);
    await store.addDomain("a.example.com", true);
    await store.addDomain("m.example.com", false);

    const list = await store.listDomains();
    expect(list.map((e) => e.domain)).toEqual(["a.example.com", "m.example.com", "z.example.com"]);
    expect(list.find((e) => e.domain === "a.example.com")?.subdomainMatch).toBe(true);
    expect(list.find((e) => e.domain === "z.example.com")?.subdomainMatch).toBe(false);
  });

  it("throws on addDomain with an invalid domain", async () => {
    const store = new InMemoryDomainReputationStore();
    await expect(store.addDomain("192.168.1.1", false)).rejects.toThrow(/Invalid domain/);
    await expect(store.addDomain("localhost", false)).rejects.toThrow(/Invalid domain/);
  });

  it("handles case-insensitive lookup via sanitizeDomain normalization", async () => {
    const store = new InMemoryDomainReputationStore();
    await store.addDomain("Spam.Example.Com", false);
    // stored as lowercase; lookup also lowercases
    expect(await store.isDomainBlocked("SPAM.EXAMPLE.COM")).toBe(true);
  });

  it("returns false without throwing for an empty domain (fail-open safety)", async () => {
    const store = new InMemoryDomainReputationStore();
    expect(await store.isDomainBlocked("")).toBe(false);
  });
});
