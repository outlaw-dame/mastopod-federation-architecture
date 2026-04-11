import type { RegistryFieldDescriptor, RegistryModuleDescriptor } from "../registry-metadata/types.js";
import type { ModuleRegistration } from "./types.js";

function omitUndefined<T extends object>(value: T): T {
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  return Object.fromEntries(entries) as T;
}

export function buildRegistryDescriptor<TConfig extends object>(
  registration: ModuleRegistration<TConfig>,
): RegistryModuleDescriptor {
  const ui = registration.getUIHints();
  const fields = registration.getUIFields();
  const defaults = registration.getDefaultConfig() as Record<string, unknown>;

  const fieldDescriptors: RegistryFieldDescriptor[] = fields.map((field) => {
    const constraints = omitUndefined({
      min: field.min,
      max: field.max,
      step: field.step,
      minLength: field.minLength,
      maxLength: field.maxLength,
      pattern: field.pattern,
      required: field.required,
    });

    return omitUndefined({
      key: field.key,
      label: field.label,
      description: field.description,
      type: field.type,
      constraints: Object.keys(constraints).length > 0 ? constraints : undefined,
      defaultValue: field.defaultValue,
      options: field.options,
      secret: field.secret,
      advanced: field.advanced,
      placeholder: field.placeholder,
      examples: field.examples,
    });
  });

  return {
    manifest: registration.manifest,
    ui: {
      category: ui.category,
      shortDescription: ui.shortDescription,
      docsUrl: ui.docsUrl,
      supportsSimulator: ui.supportsSimulator,
      supportsDryRun: ui.supportsDryRun,
      supportsEnforce: ui.supportsEnforce,
      supportsStopOnMatch: ui.supportsStopOnMatch,
      warnings: ui.warnings || [],
    },
    config: {
      fields: fieldDescriptors,
      invariants: ui.invariants || [],
      defaults,
    },
    safety: {
      disallowModes: ui.safety?.disallowModes || [],
      requireSimulatorBeforeEnforce: ui.safety?.requireSimulatorBeforeEnforce || false,
      enforceGuardrails: ui.safety?.enforceGuardrails || [],
    },
  };
}

export function redactSecretFields<T extends Record<string, unknown>>(
  registration: ModuleRegistration<object> | null,
  source: T,
  replacement?: unknown,
): T {
  if (!registration) return source;

  const secretKeys = new Set(
    registration.getUIFields().filter((field) => field.secret).map((field) => field.key),
  );

  if (secretKeys.size === 0) return source;

  const copy: Record<string, unknown> = { ...source };
  for (const key of secretKeys) {
    if (key in copy) {
      if (replacement === undefined) {
        delete copy[key];
      } else {
        copy[key] = replacement;
      }
    }
  }

  return copy as T;
}
