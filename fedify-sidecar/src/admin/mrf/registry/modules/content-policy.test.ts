import { describe, expect, it } from "vitest";
import { contentPolicyRegistration } from "./content-policy.js";

describe("contentPolicyRegistration", () => {
  it("dedupes labels", () => {
    const existing = contentPolicyRegistration.getDefaultConfig();
    const result = contentPolicyRegistration.validateAndNormalizeConfig(
      {
        blockedLabels: ["nsfw", "nsfw", "violence"],
        warnLabels: ["sensitive", "sensitive"],
      },
      { partial: true, existingConfig: existing },
    );

    expect(result.config.blockedLabels).toEqual(["nsfw", "violence"]);
    expect(result.config.warnLabels).toEqual(["sensitive"]);
  });

  it("dedupes allowed languages", () => {
    const existing = contentPolicyRegistration.getDefaultConfig();
    const result = contentPolicyRegistration.validateAndNormalizeConfig(
      { allowedLanguages: ["en", "en", "fr"] },
      { partial: true, existingConfig: existing },
    );

    expect(result.config.allowedLanguages).toEqual(["en", "fr"]);
  });

  it("keeps existing values when applying partial updates", () => {
    const existing = contentPolicyRegistration.validateAndNormalizeConfig({
      blockedLabels: ["nsfw"],
      warnLabels: ["sensitive"],
      allowedLanguages: ["en"],
      traceReasons: true,
    }).config;

    const result = contentPolicyRegistration.validateAndNormalizeConfig(
      { warnLabels: ["spoiler"] },
      { partial: true, existingConfig: existing },
    );

    expect(result.config.blockedLabels).toEqual(["nsfw"]);
    expect(result.config.warnLabels).toEqual(["spoiler"]);
    expect(result.config.allowedLanguages).toEqual(["en"]);
  });
});
