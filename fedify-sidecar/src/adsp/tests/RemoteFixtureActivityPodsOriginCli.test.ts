import { describe, expect, it } from "vitest";
import { parseActivityPodsRemoteOriginSettlementOptions } from "../RemoteFixtureActivityPodsOriginCli.js";

describe("parseActivityPodsRemoteOriginSettlementOptions", () => {
  it("uses a fixture-only observation window long enough for two production 60-second retries", () => {
    expect(parseActivityPodsRemoteOriginSettlementOptions({})).toEqual({ timeoutMs: 180_000 });
    expect(parseActivityPodsRemoteOriginSettlementOptions({
      ADSP_REMOTE_SETTLEMENT_TIMEOUT_MS: "",
    })).toEqual({ timeoutMs: 180_000 });
  });

  it("accepts an explicit fixture-only settlement observation window", () => {
    expect(parseActivityPodsRemoteOriginSettlementOptions({
      ADSP_REMOTE_SETTLEMENT_TIMEOUT_MS: "240000",
    })).toEqual({ timeoutMs: 240_000 });
  });

  it.each(["0", "-1", "001", "1.5", " 180000", "180000 "])(
    "rejects non-canonical or non-positive timeout %s",
    value => {
      expect(() => parseActivityPodsRemoteOriginSettlementOptions({
        ADSP_REMOTE_SETTLEMENT_TIMEOUT_MS: value,
      })).toThrow(/canonical positive integer/u);
    },
  );

  it("rejects values above Number.MAX_SAFE_INTEGER", () => {
    expect(() => parseActivityPodsRemoteOriginSettlementOptions({
      ADSP_REMOTE_SETTLEMENT_TIMEOUT_MS: "9007199254740992",
    })).toThrow(/positive safe integer/u);
  });
});
