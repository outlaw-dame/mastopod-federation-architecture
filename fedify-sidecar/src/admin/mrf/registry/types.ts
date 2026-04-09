import type { MRFAction, MRFMode } from "../types.js";

export interface ModuleManifest {
  id: string;
  name: string;
  version: string;
  kind: "wasm";
  description?: string;
  allowedActions: MRFAction[];
  defaultMode: MRFMode;
  defaultPriority: number;
  configSchemaVersion: number;
}

export interface ModuleConfigValidationResult<TConfig extends object> {
  config: TConfig;
  warnings?: string[];
}

export interface ModuleUIFieldOption {
  value: string;
  label: string;
  description?: string;
}

export interface ModuleUIField {
  key: string;
  label: string;
  description?: string;
  type: "string" | "number" | "integer" | "boolean" | "enum" | "multiselect" | "string-array" | "json";
  required?: boolean;
  min?: number;
  max?: number;
  step?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  options?: ModuleUIFieldOption[];
  defaultValue?: unknown;
  secret?: boolean;
  advanced?: boolean;
  placeholder?: string;
  examples?: unknown[];
}

export interface ModuleUIHints {
  category: "trust" | "spam" | "policy" | "experimental";
  shortDescription?: string;
  docsUrl?: string;
  supportsSimulator: boolean;
  supportsDryRun: boolean;
  supportsEnforce: boolean;
  supportsStopOnMatch: boolean;
  warnings?: string[];
  invariants?: Array<{
    code: string;
    message: string;
  }>;
  safety?: {
    disallowModes?: MRFMode[];
    requireSimulatorBeforeEnforce?: boolean;
    enforceGuardrails?: string[];
  };
}

export interface ModuleRegistration<TConfig extends object> {
  manifest: ModuleManifest;

  getDefaultConfig(): TConfig;

  validateAndNormalizeConfig(
    raw: Record<string, unknown>,
    opts?: {
      partial?: boolean;
      existingConfig?: TConfig;
    },
  ): ModuleConfigValidationResult<TConfig>;

  validateMode?(mode: MRFMode, config: TConfig): void;

  getUIHints(): ModuleUIHints;
  getUIFields(): ModuleUIField[];
}
