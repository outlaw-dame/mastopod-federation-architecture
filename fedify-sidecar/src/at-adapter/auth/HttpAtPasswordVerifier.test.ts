import { describe, expect, it } from "vitest";
import {
  assertAtPasswordVerifierRuntimePreflight,
  resolveHttpAtPasswordVerifierConfig,
} from "./HttpAtPasswordVerifier.js";

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

describe("assertAtPasswordVerifierRuntimePreflight", () => {
  const runtimeArgv = ["node", "/app/dist/index.js"];

  it("fails before sidecar startup when managed XRPC lacks the dedicated token", () => {
    expect(() => assertAtPasswordVerifierRuntimePreflight({
      ENABLE_XRPC_SERVER: "true",
      AT_LOCAL_FIXTURE: "false",
      ACTIVITYPODS_TOKEN: "broad-federation-token",
    } as NodeJS.ProcessEnv, runtimeArgv)).toThrow(
      /requires ATPROTO_PASSWORD_VERIFY_TOKEN/u,
    );
  });

  it("treats XRPC as enabled by default and still requires the dedicated token", () => {
    expect(() => assertAtPasswordVerifierRuntimePreflight({
      AT_LOCAL_FIXTURE: "false",
      ACTIVITYPODS_TOKEN: "broad-federation-token",
    } as NodeJS.ProcessEnv, runtimeArgv)).toThrow(
      /requires ATPROTO_PASSWORD_VERIFY_TOKEN/u,
    );
  });

  it("accepts a dedicated token independently of ACTIVITYPODS_TOKEN", () => {
    expect(() => assertAtPasswordVerifierRuntimePreflight({
      ENABLE_XRPC_SERVER: "true",
      AT_LOCAL_FIXTURE: "false",
      ATPROTO_PASSWORD_VERIFY_TOKEN: "dedicated-password-token",
    } as NodeJS.ProcessEnv, runtimeArgv)).not.toThrow();
  });

  it("does not require the production verifier token in local fixture mode", () => {
    expect(() => assertAtPasswordVerifierRuntimePreflight({
      ENABLE_XRPC_SERVER: "true",
      AT_LOCAL_FIXTURE: "true",
    } as NodeJS.ProcessEnv, runtimeArgv)).not.toThrow();
  });

  it("does not require the token when XRPC is explicitly disabled", () => {
    expect(() => assertAtPasswordVerifierRuntimePreflight({
      ENABLE_XRPC_SERVER: "false",
      AT_LOCAL_FIXTURE: "false",
    } as NodeJS.ProcessEnv, runtimeArgv)).not.toThrow();
  });

  it("does not impose entrypoint startup policy on library/test imports", () => {
    expect(() => assertAtPasswordVerifierRuntimePreflight({
      ENABLE_XRPC_SERVER: "true",
      AT_LOCAL_FIXTURE: "false",
    } as NodeJS.ProcessEnv, ["node", "/app/node_modules/vitest/vitest.mjs"])).not.toThrow();
  });
});
