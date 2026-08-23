import { describe, expect, it } from "vitest";
import { resolveSidecarRelayActorUri } from "./signing-client.js";

describe("resolveSidecarRelayActorUri", () => {
  it("accepts the exact explicit Fedify-served relay actor URI", () => {
    expect(resolveSidecarRelayActorUri({
      DOMAIN: "example.com",
      AP_RELAY_LOCAL_ACTOR_URI: "https://example.com/users/relay",
    } as NodeJS.ProcessEnv)).toBe("https://example.com/users/relay");
  });

  it("rejects a custom relay actor path that Fedify does not serve", () => {
    expect(() => resolveSidecarRelayActorUri({
      DOMAIN: "example.com",
      AP_RELAY_LOCAL_ACTOR_URI: "https://example.com/service/relay",
    } as NodeJS.ProcessEnv)).toThrow(/must exactly match the Fedify-served relay actor URI/u);
  });

  it("rejects a relay actor on a different public authority", () => {
    expect(() => resolveSidecarRelayActorUri({
      DOMAIN: "example.com",
      AP_RELAY_LOCAL_ACTOR_URI: "https://other.example/users/relay",
    } as NodeJS.ProcessEnv)).toThrow(/must exactly match the Fedify-served relay actor URI/u);
  });

  it("falls back when AP_RELAY_LOCAL_ACTOR_URI is empty", () => {
    expect(resolveSidecarRelayActorUri({
      DOMAIN: "example.com",
      AP_RELAY_LOCAL_ACTOR_URI: "",
    } as NodeJS.ProcessEnv)).toBe("https://example.com/users/relay");
  });

  it("falls back to localhost when DOMAIN is empty", () => {
    expect(resolveSidecarRelayActorUri({
      DOMAIN: "",
      AP_RELAY_LOCAL_ACTOR_URI: "",
    } as NodeJS.ProcessEnv)).toBe("https://localhost/users/relay");
  });
});
