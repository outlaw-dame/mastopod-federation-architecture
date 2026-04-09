import type { MRFAction, MRFMode } from "../types.js";

export type UIFieldType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "enum"
  | "multiselect"
  | "string-array"
  | "json";

export interface RegistryFieldOption {
  value: string;
  label: string;
  description?: string;
}

export interface RegistryFieldConstraint {
  min?: number;
  max?: number;
  step?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  required?: boolean;
}

export interface RegistryFieldDescriptor {
  key: string;
  label: string;
  description?: string;
  type: UIFieldType;
  constraints?: RegistryFieldConstraint;
  defaultValue?: unknown;
  options?: RegistryFieldOption[];
  secret?: boolean;
  advanced?: boolean;
  placeholder?: string;
  examples?: unknown[];
}

export interface RegistryModuleDescriptor {
  manifest: {
    id: string;
    name: string;
    version: string;
    kind: "wasm";
    description?: string;
    allowedActions: MRFAction[];
    defaultMode: MRFMode;
    defaultPriority: number;
    configSchemaVersion: number;
  };
  ui: {
    category: "trust" | "spam" | "policy" | "experimental";
    shortDescription?: string;
    docsUrl?: string;
    supportsSimulator: boolean;
    supportsDryRun: boolean;
    supportsEnforce: boolean;
    supportsStopOnMatch: boolean;
    warnings?: string[];
  };
  config: {
    fields: RegistryFieldDescriptor[];
    invariants: Array<{ code: string; message: string }>;
    defaults: Record<string, unknown>;
  };
  safety: {
    disallowModes?: MRFMode[];
    requireSimulatorBeforeEnforce?: boolean;
    enforceGuardrails?: string[];
  };
}

export interface RegistryListResponse {
  data: RegistryModuleDescriptor[];
}

export interface RegistryItemResponse {
  data: RegistryModuleDescriptor;
}
