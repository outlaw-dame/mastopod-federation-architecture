import { describe, expect, it } from "vitest";
import { trustEvalRegistration } from "./trust-eval.js";

describe("trustEvalRegistration", () => {
  it("accepts a valid full config", () => {
    const result = trustEvalRegistration.validateAndNormalizeConfig({
      thresholdLabel: 0.2,
      thresholdDownrank: 0.4,
      thresholdFilter: 0.7,
      thresholdReject: 0.95,
      defaultWeight: 0.9,
      maxSourcesPerUser: 150,
      allowedScopes: ["label:content", "filter:content"],
      enabledDecisionActions: ["label", "downrank"],
      traceReasons: true,
    });

    expect(result.config.thresholdReject).toBe(0.95);
    expect(result.warnings).toEqual([]);
  });

  it("merges partial patches with existing config", () => {
    const existing = trustEvalRegistration.getDefaultConfig();
    const result = trustEvalRegistration.validateAndNormalizeConfig(
      { thresholdReject: 0.92 },
      { partial: true, existingConfig: existing },
    );

    expect(result.config.thresholdReject).toBe(0.92);
    expect(result.config.thresholdFilter).toBe(existing.thresholdFilter);
  });

  it("rejects invalid threshold ordering", () => {
    expect(() =>
      trustEvalRegistration.validateAndNormalizeConfig({
        thresholdLabel: 0.9,
        thresholdDownrank: 0.4,
        thresholdFilter: 0.7,
        thresholdReject: 0.95,
        defaultWeight: 0.9,
        maxSourcesPerUser: 150,
        allowedScopes: ["label:content", "filter:content"],
        enabledDecisionActions: ["label", "downrank"],
        traceReasons: true,
      }),
    ).toThrow(/label <= downrank <= filter <= reject/);
  });

  it("rejects enforce mode when reject threshold is too low", () => {
    const config = trustEvalRegistration.validateAndNormalizeConfig({
      thresholdLabel: 0.2,
      thresholdDownrank: 0.4,
      thresholdFilter: 0.7,
      thresholdReject: 0.79,
      defaultWeight: 0.9,
      maxSourcesPerUser: 150,
      allowedScopes: ["label:content", "filter:content"],
      enabledDecisionActions: ["reject"],
      traceReasons: true,
    }).config;

    expect(() => trustEvalRegistration.validateMode?.("enforce", config)).toThrow(/thresholdReject >= 0.8/);
  });

  it("dedupes allowed scopes", () => {
    const existing = trustEvalRegistration.getDefaultConfig();
    const result = trustEvalRegistration.validateAndNormalizeConfig(
      { allowedScopes: ["label:content", "label:content", "filter:content"] },
      { partial: true, existingConfig: existing },
    );

    expect(result.config.allowedScopes).toEqual(["label:content", "filter:content"]);
  });

  it("rejects unknown keys", () => {
    expect(() =>
      trustEvalRegistration.validateAndNormalizeConfig(
        { unknownField: true } as unknown as Record<string, unknown>,
        { partial: true, existingConfig: trustEvalRegistration.getDefaultConfig() },
      ),
    ).toThrow(/Unknown config keys/);
  });
});
