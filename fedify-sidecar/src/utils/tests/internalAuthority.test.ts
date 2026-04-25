import { describe, expect, it } from "vitest";
import { isSecureOrTrustedInternalUrl, isTrustedInternalHostname } from "../internalAuthority.js";

describe("internal authority helpers", () => {
  it("allows https for any hostname", () => {
    expect(isSecureOrTrustedInternalUrl(new URL("https://example.com"))).toBe(true);
  });

  it("allows trusted internal http authorities", () => {
    expect(isSecureOrTrustedInternalUrl(new URL("http://localhost:3000"))).toBe(true);
    expect(isSecureOrTrustedInternalUrl(new URL("http://mock-activitypods:8793"))).toBe(true);
    expect(isSecureOrTrustedInternalUrl(new URL("http://10.0.0.15:3000"))).toBe(true);
  });

  it("rejects public http authorities", () => {
    expect(isSecureOrTrustedInternalUrl(new URL("http://example.com"))).toBe(false);
    expect(isSecureOrTrustedInternalUrl(new URL("http://8.8.8.8"))).toBe(false);
  });

  it("classifies single-label service names as internal", () => {
    expect(isTrustedInternalHostname("activitypods")).toBe(true);
    expect(isTrustedInternalHostname("mock-activitypods")).toBe(true);
    expect(isTrustedInternalHostname("api.example.com")).toBe(false);
  });
});
