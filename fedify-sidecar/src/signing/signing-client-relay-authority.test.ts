import { describe, expect, it } from "vitest";
import { resolveSidecarRelayActorUri } from "./signing-client.js";

describe("resolveSidecarRelayActorUri", () => {
  it("uses the explicit non-empty relay actor URI", () => {
    expect(resolveSidecarRelayActorUri({
      DOMAIN: "example.com",
      AP_RELAY_LOCAL_ACTOR_URI: "https://example.com/service/relay",
    } as NodeJS.ProcessEnv)).toBe("https://example.com/service/relay");
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
