import { describe, expect, it } from "vitest";
import {
  isForbiddenActivityPubAddress,
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

  it("rejects credentials, fragments and non-HTTP schemes", async () => {
    await expect(validateActivityPubTarget("https://user:pass@example.com/inbox", { lookup: resolver([{ address: "8.8.8.8", family: 4 }]) })).rejects.toThrow(/credentials/u);
    await expect(validateActivityPubTarget("https://example.com/inbox#fragment", { lookup: resolver([{ address: "8.8.8.8", family: 4 }]) })).rejects.toThrow(/fragment/u);
    await expect(validateActivityPubTarget("ftp://example.com/inbox", { lookup: resolver([{ address: "8.8.8.8", family: 4 }]) })).rejects.toThrow(/HTTP\(S\)/u);
  });

  it("rejects a hostname when any DNS answer is forbidden", async () => {
    await expect(validateActivityPubTarget("https://example.com/inbox", {
      lookup: resolver([
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
    })).rejects.toThrow(/forbidden address 127\.0\.0\.1/u);
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

  it("allows plain HTTP only for explicitly enabled literal loopback targets", async () => {
    await expect(validateActivityPubTarget("http://localhost:8080/inbox", {
      lookup: resolver([{ address: "127.0.0.1", family: 4 }]),
    })).rejects.toThrow(/Plain HTTP|forbidden/u);

    await expect(validateActivityPubTarget("http://localhost:8080/inbox", {
      allowLoopbackHttp: true,
      lookup: resolver([{ address: "127.0.0.1", family: 4 }]),
    })).resolves.toEqual(expect.objectContaining({ address: "127.0.0.1" }));

    await expect(validateActivityPubTarget("http://example.com/inbox", {
      allowLoopbackHttp: true,
      lookup: resolver([{ address: "8.8.8.8", family: 4 }]),
    })).rejects.toThrow(/Plain HTTP/u);

    await expect(validateActivityPubTarget("http://attacker.example/inbox", {
      allowLoopbackHttp: true,
      lookup: resolver([{ address: "127.0.0.1", family: 4 }]),
    })).rejects.toThrow(/forbidden address 127\.0\.0\.1/u);
  });

  it("fails closed when DNS returns no addresses", async () => {
    await expect(validateActivityPubTarget("https://example.com/inbox", { lookup: resolver([]) })).rejects.toThrow(/resolved to no addresses/u);
  });
});
