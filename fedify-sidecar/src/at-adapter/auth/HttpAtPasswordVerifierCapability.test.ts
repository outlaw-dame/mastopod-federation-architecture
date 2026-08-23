import { describe, expect, it } from "vitest";
import { resolveHttpAtPasswordVerifierConfig } from "./HttpAtPasswordVerifier.js";

describe("HTTP AT password verifier capability separation", () => {
  it("uses the dedicated verifier token even when the runtime passes the federation token override", () => {
    const config = resolveHttpAtPasswordVerifierConfig(
      { token: "federation-token", baseUrl: "http://activitypods:3000" },
      {
        ACTIVITYPODS_TOKEN: "federation-token",
        ATPROTO_PASSWORD_VERIFY_TOKEN: "password-verifier-token",
      },
    );

    expect(config.token).toBe("password-verifier-token");
    expect(config.token).not.toBe("federation-token");
  });

  it("fails closed instead of reusing ACTIVITYPODS_TOKEN when the dedicated token is absent", () => {
    const config = resolveHttpAtPasswordVerifierConfig(
      { token: "federation-token" },
      { ACTIVITYPODS_TOKEN: "federation-token" },
    );

    expect(config.token).toBe("");
  });

  it("rejects deployments that configure both capabilities with the same non-empty token", () => {
    expect(() => resolveHttpAtPasswordVerifierConfig(undefined, {
      ACTIVITYPODS_TOKEN: "shared-token",
      ATPROTO_PASSWORD_VERIFY_TOKEN: "shared-token",
    })).toThrow(/must be distinct/u);
  });

  it("allows a distinct explicit verifier token for hermetic embedding without process env", () => {
    const config = resolveHttpAtPasswordVerifierConfig(
      { token: "explicit-verifier", timeoutMs: 1234 },
      {},
    );

    expect(config.token).toBe("explicit-verifier");
    expect(config.timeoutMs).toBe(1234);
  });

  it("treats an explicitly empty dedicated environment value as unset", () => {
    const config = resolveHttpAtPasswordVerifierConfig(
      { token: "explicit-verifier" },
      { ATPROTO_PASSWORD_VERIFY_TOKEN: "" },
    );

    expect(config.token).toBe("explicit-verifier");
  });
});
