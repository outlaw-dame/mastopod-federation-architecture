const MAX_DIAGNOSTIC_FIELD_NAMES = 32;
const MAX_DIAGNOSTIC_REASON_LENGTH = 512;

export interface MalformedStreamDiagnostic {
  streamMessageId: string;
  fieldNames: string[];
  fieldCount: number;
  payloadBytes: number;
}

export function parseNonNegativeSafeInteger(
  raw: string | undefined,
  fieldName: string,
  messageId: string,
  defaultValue?: number,
): number {
  if (raw === undefined) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`Stream message ${messageId} missing required field ${fieldName}`);
  }

  if (!/^(0|[1-9]\d*)$/u.test(raw)) {
    throw new Error(`Stream message ${messageId} has invalid integer field ${fieldName}`);
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Stream message ${messageId} has out-of-range integer field ${fieldName}`);
  }
  return value;
}

export function buildMalformedStreamDiagnostic(
  messageId: string,
  fields: Record<string, string>,
): MalformedStreamDiagnostic {
  const fieldNames = Object.keys(fields).sort();
  let payloadBytes = 0;

  for (const [key, value] of Object.entries(fields)) {
    payloadBytes += Buffer.byteLength(key, "utf8");
    payloadBytes += Buffer.byteLength(typeof value === "string" ? value : "", "utf8");
  }

  return {
    streamMessageId: messageId,
    fieldNames: fieldNames.slice(0, MAX_DIAGNOSTIC_FIELD_NAMES),
    fieldCount: fieldNames.length,
    payloadBytes,
  };
}

export function formatMalformedStreamReason(type: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "unknown deserialization error");
  const compact = raw
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/giu, "Bearer [redacted]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_DIAGNOSTIC_REASON_LENGTH);

  return `Malformed ${type} Redis Stream message: ${compact || "invalid serialized fields"}`;
}
