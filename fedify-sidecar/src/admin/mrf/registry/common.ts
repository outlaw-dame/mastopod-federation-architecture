import { z } from "zod";
import type { MRFMode } from "../types.js";

export const modeSchema = z.enum(["disabled", "dry-run", "enforce"]);

export function dedupeStrings(values: string[] | undefined): string[] {
  if (!values) return [];
  return [...new Set(values.map(v => v.trim()).filter(Boolean))];
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function assertModeAllowed(mode: MRFMode, disallowed: MRFMode[] = []): void {
  if (disallowed.includes(mode)) {
    throw new Error(`Mode ${mode} is not allowed for this module`);
  }
}

export function rejectUnknownKeys(raw: Record<string, unknown>, allowedKeys: string[]): void {
  const unknown = Object.keys(raw).filter(k => !allowedKeys.includes(k));
  if (unknown.length > 0) {
    throw new Error(`Unknown config keys: ${unknown.join(", ")}`);
  }
}
