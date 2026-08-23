import { describe, expect, it } from "vitest";
import { resolveHttpAtPasswordVerifierConfig } from "./HttpAtPasswordVerifier.js";

describe("resolveHttpAtPasswordVerifierConfig", () => {
  it("uses only the dedicated AT password verification token", () => {
    const config = resolveHttpAtPasswordVerifierConfig(
      {
        baseUrl: "http://activitypods.internal:3000",
        // Simulate the legacy production call site attempting to pass the
        // broader federation credential. The factory must ignore it.
        token: "broad-activitypods-token",
      },
      {
        ACTIVITYPODS_URL: "http://ignored.example:3000",
        ACTIVITYPODS_TOKEN: "broad-activitypods-token",
        ATPROTO_PASSWORD_VERIFY_TOKEN: "dedicated-password-verify-token",
      } as NodeJS.ProcessEnv,
    );

    expect(config.baseUrl).toBe("http://activitypods.internal:3000");
    expect(config.token).toBe("dedicated-password-verify-token");
  });

  it("fails closed when only ACTIVITYPODS_TOKEN is configured", () => {
    const config = resolveHttpAtPasswordVerifierConfig(
      { token: "broad-activitypods-token" },
      {
        ACTIVITYPODS_URL: "http://activitypods.internal:3000",
        ACTIVITYPODS_TOKEN: "broad-activitypods-token",
      } as NodeJS.ProcessEnv,
    );

    expect(config.token).toBe("");
  });

  it("keeps non-credential runtime overrides while preserving credential isolation", () => {
    const config = resolveHttpAtPasswordVerifierConfig(
      {
        baseUrl: "http://custom.internal:3000",
        timeoutMs: 2_500,
        token: "must-be-ignored",
      },
      {
        ATPROTO_PASSWORD_VERIFY_TOKEN: "dedicated",
      } as NodeJS.ProcessEnv,
    );

    expect(config).toEqual({
      baseUrl: "http://custom.internal:3000",
      timeoutMs: 2_500,
      token: "dedicated",
    });
  });
});
