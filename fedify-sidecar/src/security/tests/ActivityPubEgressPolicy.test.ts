import { describe, expect, it, vi } from "vitest";
import {
  isForbiddenActivityPubAddress,
  isUnsafeActivityPubTargetError,
  UnsafeActivityPubTargetError,
  validateActivityPubTarget,
  type ResolvedAddress,
} from "../activitypub-egress-policy.js";

const resolver = (addresses: ResolvedAddress[]) => async () => addresses;

describe("ActivityPub egress policy", () => {
  it("rejects private, loopback, link-local, multicast, reserved and documentation IPv4 ranges", () => {
    for (const address of [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.1.1",
      "172.16.0.1",
      "192.0.0.1",
      "192.0.2.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isForbiddenActivityPubAddress(address), address).toBe(true);
    }
    expect(isForbiddenActivityPubAddress("8.8.8.8")).toBe(false);
  });

  it("rejects private, loopback, link-local, multicast and documentation IPv6 ranges", () => {
    for (const address of ["::", "::1", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "2001:db8::1"]) {
      expect(isForbiddenActivityPubAddress(address), address).toBe(true);
    }
    expect(isForbiddenActivityPubAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("normalizes bracketed IPv6 literals without invoking DNS", async () => {
    const lookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 as const }]);
    await expect(validateActivityPubTarget("https://[2606:4700:4700::1111]/inbox", { lookup })).resolves.toEqual(
      expect.objectContaining({ address: "2606:4700:4700::1111", family: 6 }),
    );
    expect(lookup).not.toHaveBeenCalled();

    await expect(validateActivityPubTarget("https://[::1]/inbox", { lookup })).rejects.toBeInstanceOf(
      UnsafeActivityPubTargetError,
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects credentials, fragments and non-HTTP schemes as permanent policy failures", async () => {
    for (const invocation of [
      validateActivityPubTarget("https://user:pass@example.com/inbox", { lookup: resolver([{ address: "8.8.8.8", family: 4 }]) }),
      validateActivityPubTarget("https://example.com/inbox#fragment", { lookup: resolver([{ address: "8.8.8.8", family: 4 }]) }),
      validateActivityPubTarget("ftp://example.com/inbox", { lookup: resolver([{ address: "8.8.8.8", family: 4 }]) }),
    ]) {
      await expect(invocation).rejects.toBeInstanceOf(UnsafeActivityPubTargetError);
    }
  });

  it("rejects a hostname when any DNS answer is forbidden", async () => {
    const result = validateActivityPubTarget("https://example.com/inbox", {
      lookup: resolver([
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
    });
    await expect(result).rejects.toBeInstanceOf(UnsafeActivityPubTargetError);
  });

  it("rejects resolver address/family mismatches", async () => {
    await expect(validateActivityPubTarget("https://example.com/inbox", {
      lookup: resolver([{ address: "2606:4700:4700::1111", family: 4 }]),
    })).rejects.toBeInstanceOf(UnsafeActivityPubTargetError);
  });

  it("accepts HTTPS only when every resolved address is public", async () => {
    await expect(validateActivityPubTarget("https://example.com/inbox", {
      lookup: resolver([
        { address: "8.8.8.8", family: 4 },
        { address: "2606:4700:4700::1111", family: 6 },
      ]),
    })).resolves.toEqual(expect.objectContaining({
      address: "8.8.8.8",
      family: 4,
    }));
  });

  it("allows plain HTTP only for explicitly enabled loopback targets", async () => {
    await expect(validateActivityPubTarget("http://localhost:8080/inbox", {
      lookup: resolver([{ address: "127.0.0.1", family: 4 }]),
    })).rejects.toBeInstanceOf(UnsafeActivityPubTargetError);

    await expect(validateActivityPubTarget("http://localhost:8080/inbox", {
      allowLoopbackHttp: true,
      lookup: resolver([{ address: "127.0.0.1", family: 4 }]),
    })).resolves.toEqual(expect.objectContaining({ address: "127.0.0.1" }));

    await expect(validateActivityPubTarget("http://[::1]:8080/inbox", {
      allowLoopbackHttp: true,
    })).resolves.toEqual(expect.objectContaining({ address: "::1", family: 6 }));

    await expect(validateActivityPubTarget("http://example.com/inbox", {
      allowLoopbackHttp: true,
      lookup: resolver([{ address: "8.8.8.8", family: 4 }]),
    })).rejects.toBeInstanceOf(UnsafeActivityPubTargetError);

    await expect(validateActivityPubTarget("http://attacker.example/inbox", {
      allowLoopbackHttp: true,
      lookup: resolver([{ address: "127.0.0.1", family: 4 }]),
    })).rejects.toBeInstanceOf(UnsafeActivityPubTargetError);
  });

  it("keeps an empty DNS result retryable instead of misclassifying it as a policy violation", async () => {
    try {
      await validateActivityPubTarget("https://example.com/inbox", { lookup: resolver([]) });
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(isUnsafeActivityPubTargetError(error)).toBe(false);
      expect((error as Error).message).toMatch(/resolved to no addresses/u);
    }
  });
});
