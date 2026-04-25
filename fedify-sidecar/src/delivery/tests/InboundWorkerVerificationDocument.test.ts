import { describe, expect, it, vi } from "vitest";

vi.mock("../../utils/logger.js", () => {
  const noop = () => undefined;
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { logger, default: logger };
});
import {
  extractPublicKeyPemFromVerificationDocument,
  resolveActorUriFromVerificationDocument,
} from "../inbound-worker.js";

describe("InboundWorker verification document helpers", () => {
  it("extracts a top-level publicKeyPem from key documents", () => {
    expect(
      extractPublicKeyPemFromVerificationDocument({
        id: "https://remote.example/users/alice/main-key",
        owner: "https://remote.example/users/alice",
        publicKeyPem: "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----",
      }),
    ).toContain("BEGIN PUBLIC KEY");
  });

  it("resolves the actor owner from dedicated key documents", () => {
    expect(
      resolveActorUriFromVerificationDocument(
        "https://remote.example/users/alice/main-key",
        {
          id: "https://remote.example/users/alice/main-key",
          owner: "https://remote.example/users/alice",
          publicKeyPem: "pem",
        },
      ),
    ).toBe("https://remote.example/users/alice");
  });

  it("falls back to actor document ids for actor-shaped documents", () => {
    expect(
      resolveActorUriFromVerificationDocument(
        "https://remote.example/users/alice#main-key",
        {
          id: "https://remote.example/users/alice",
          type: "Person",
          inbox: "https://remote.example/users/alice/inbox",
          publicKey: {
            id: "https://remote.example/users/alice#main-key",
            publicKeyPem: "pem",
          },
        },
      ),
    ).toBe("https://remote.example/users/alice");
  });
});
