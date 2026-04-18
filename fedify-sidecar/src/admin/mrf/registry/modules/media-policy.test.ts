import { describe, expect, it } from "vitest";
import { mediaPolicyRegistration } from "./media-policy.js";

describe("mediaPolicyRegistration", () => {
  it("normalizes and dedupes label/source fields", () => {
    const existing = mediaPolicyRegistration.getDefaultConfig();
    const result = mediaPolicyRegistration.validateAndNormalizeConfig(
      {
        sensitiveLabels: ["NSFW", "nsfw", " Violence "],
        blockedLabels: ["CSAM", "csam"],
        trustedSources: ["Google-Vision", "google-vision"],
      },
      { partial: true, existingConfig: existing },
    );

    expect(result.config.sensitiveLabels).toEqual(["nsfw", "violence"]);
    expect(result.config.blockedLabels).toEqual(["csam"]);
    expect(result.config.trustedSources).toEqual(["google-vision"]);
  });

  it("rejects inverted confidence thresholds", () => {
    expect(() => mediaPolicyRegistration.validateAndNormalizeConfig({
      sensitiveLabels: ["nsfw"],
      blockedLabels: ["csam"],
      trustedSources: [],
      minSensitiveConfidence: 0.9,
      minBlockedConfidence: 0.8,
      blockedAction: "reject",
      applySensitiveFlag: true,
      setContentWarning: true,
      contentWarningText: "Sensitive media",
      traceReasons: true,
    })).toThrow(/minSensitiveConfidence/);
  });
});