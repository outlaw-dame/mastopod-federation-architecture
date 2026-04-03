export type CanonicalLossiness = "none" | "minor" | "major";

export interface CanonicalWarning {
  code: string;
  message: string;
  lossiness: CanonicalLossiness;
}

export function maxLossiness(
  warnings: readonly CanonicalWarning[],
  defaultLossiness: CanonicalLossiness = "none",
): CanonicalLossiness {
  if (warnings.some((warning) => warning.lossiness === "major")) {
    return "major";
  }
  if (warnings.some((warning) => warning.lossiness === "minor")) {
    return "minor";
  }
  return defaultLossiness;
}
