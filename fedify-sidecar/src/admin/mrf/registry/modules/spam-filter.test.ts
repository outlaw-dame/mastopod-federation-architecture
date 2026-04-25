import { describe, expect, it } from "vitest";
import { spamFilterRegistration } from "./spam-filter.js";

describe("spamFilterRegistration", () => {
  it("dedupes keyword rules", () => {
    const existing = spamFilterRegistration.getDefaultConfig();
    const result = spamFilterRegistration.validateAndNormalizeConfig(
      { keywordRules: ["buy now", "buy now", "free"] },
      { partial: true, existingConfig: existing },
    );

    expect(result.config.keywordRules).toEqual(["buy now", "free"]);
  });

  it("truncates rules to maxKeywordRules", () => {
    const existing = spamFilterRegistration.getDefaultConfig();
    const result = spamFilterRegistration.validateAndNormalizeConfig(
      {
        maxKeywordRules: 2,
        keywordRules: ["a", "b", "c", "d"],
      },
      { partial: true, existingConfig: existing },
    );

    expect(result.config.keywordRules).toEqual(["a", "b"]);
  });

  it("rejects unsafe enforce reject configuration", () => {
    const config = spamFilterRegistration.validateAndNormalizeConfig({
      keywordRules: ["x"],
      maxKeywordRules: 100,
      minConfidence: 0.85,
      action: "reject",
      traceReasons: true,
    }).config;

    expect(() => spamFilterRegistration.validateMode?.("enforce", config)).toThrow(/minConfidence >= 0.9/);
  });

  it("rejects unknown keys", () => {
    expect(() =>
      spamFilterRegistration.validateAndNormalizeConfig(
        { nope: "x" } as unknown as Record<string, unknown>,
        { partial: true, existingConfig: spamFilterRegistration.getDefaultConfig() },
      ),
    ).toThrow(/Unknown config keys/);
  });
});
