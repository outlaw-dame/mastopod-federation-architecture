import { describe, expect, it } from "vitest";
import { mediaPolicyRegistration } from "./media-policy.js";

describe("mediaPolicyRegistration", () => {
  it("normalizes and dedupes label/source fields", () => {
    const existing = mediaPolicyRegistration.getDefaultConfig();
    const binaryHash = `${"1".repeat(80)}${"00001111".repeat(22)}`;
    const result = mediaPolicyRegistration.validateAndNormalizeConfig(
      {
        sensitiveLabels: ["NSFW", "nsfw", " Violence "],
        blockedLabels: ["CSAM", "csam"],
        blockedPdqHashes: [
          "f".repeat(64),
          binaryHash,
        ],
        trustedSources: ["Google-Vision", "google-vision"],
      },
      { partial: true, existingConfig: existing },
    );

    expect(result.config.sensitiveLabels).toEqual(["nsfw", "violence"]);
    expect(result.config.blockedLabels).toEqual(["csam"]);
    expect(result.config.blockedPdqHashes).toEqual([
      "1".repeat(256),
      binaryHash,
    ]);
    expect(result.config.trustedSources).toEqual(["google-vision"]);
  });

  it("rejects inverted confidence thresholds", () => {
    expect(() => mediaPolicyRegistration.validateAndNormalizeConfig({
      sensitiveLabels: ["nsfw"],
      blockedLabels: ["csam"],
      blockedPdqHashes: [],
      trustedSources: [],
      minSensitiveConfidence: 0.9,
      minBlockedConfidence: 0.8,
      minPdqQuality: 70,
      pdqHammingThreshold: 15,
      blockedAction: "reject",
      applySensitiveFlag: true,
      setContentWarning: true,
      contentWarningText: "Sensitive media",
      traceReasons: true,
    })).toThrow(/minSensitiveConfidence/);
  });

  it("rejects invalid PDQ hashes", () => {
    const existing = mediaPolicyRegistration.getDefaultConfig();
    expect(() => mediaPolicyRegistration.validateAndNormalizeConfig({
      blockedPdqHashes: ["not-a-real-hash"],
    }, { partial: true, existingConfig: existing })).toThrow(/blockedPdqHashes/);
  });
});
