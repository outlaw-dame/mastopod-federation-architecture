import { describe, expect, it } from "vitest";
import { buildRegistryDescriptor } from "./descriptor.js";
import { listRegistrations } from "./index.js";

describe("buildRegistryDescriptor", () => {
  it("builds a descriptor for every module with defaults", () => {
    const descriptors = listRegistrations().map((registration) =>
      buildRegistryDescriptor(registration),
    );

    expect(descriptors.length).toBeGreaterThan(0);
    for (const descriptor of descriptors) {
      expect(descriptor.manifest.id.length).toBeGreaterThan(0);
      expect(Array.isArray(descriptor.config.fields)).toBe(true);
      expect(descriptor.config.defaults).toBeTypeOf("object");
      expect(Array.isArray(descriptor.config.invariants)).toBe(true);
      expect(Array.isArray(descriptor.ui.warnings)).toBe(true);
      expect(Array.isArray(descriptor.safety.enforceGuardrails)).toBe(true);
    }
  });

  it("does not emit undefined noise in field constraints", () => {
    const registration = listRegistrations()[0];
    expect(registration).toBeDefined();
    if (!registration) return;
    const descriptor = buildRegistryDescriptor(registration);
    const fieldWithConstraints = descriptor.config.fields.find((field) => field.constraints !== undefined);

    expect(fieldWithConstraints).toBeDefined();
    if (!fieldWithConstraints?.constraints) return;

    for (const [key, value] of Object.entries(fieldWithConstraints.constraints)) {
      expect(value, `constraint ${key} should not be undefined`).not.toBeUndefined();
    }
  });

  it("preserves invariants and warnings", () => {
    const trustEval = listRegistrations().find((registration) => registration.manifest.id === "trust-eval");
    expect(trustEval).toBeDefined();
    if (!trustEval) return;

    const descriptor = buildRegistryDescriptor(trustEval);
    expect(descriptor.config.invariants.some((it) => it.code === "threshold-ordering")).toBe(true);
    expect((descriptor.ui.warnings || []).length).toBeGreaterThan(0);
  });
});
