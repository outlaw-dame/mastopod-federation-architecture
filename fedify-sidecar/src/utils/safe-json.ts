export type SafeJsonPrimitive = string | number | boolean | null;

export type SafeJsonValue =
  | SafeJsonPrimitive
  | SafeJsonValue[]
  | { [key: string]: SafeJsonValue };

export interface SafeJsonOptions {
  maxDepth?: number;
  maxNodes?: number;
  maxBytes?: number;
  maxArrayLength?: number;
  maxObjectKeys?: number;
}

export class SafeJsonError extends Error {
  public readonly transient = false;

  public constructor(
    public readonly code:
      | "SAFE_JSON_INVALID_TYPE"
      | "SAFE_JSON_UNSUPPORTED_OBJECT"
      | "SAFE_JSON_TOO_DEEP"
      | "SAFE_JSON_TOO_LARGE"
      | "SAFE_JSON_TOO_MANY_NODES"
      | "SAFE_JSON_TOO_MANY_KEYS"
      | "SAFE_JSON_ARRAY_TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "SafeJsonError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function sanitizeJsonValue(
  value: unknown,
  options: SafeJsonOptions = {},
): SafeJsonValue {
  const maxDepth = options.maxDepth ?? 12;
  const maxNodes = options.maxNodes ?? 10_000;
  const maxArrayLength = options.maxArrayLength ?? 1_000;
  const maxObjectKeys = options.maxObjectKeys ?? 1_000;
  const seen = new WeakSet<object>();
  let visited = 0;

  const sanitized = walk(value, 0);

  if (typeof options.maxBytes === "number") {
    const serialized = JSON.stringify(sanitized);
    const size = Buffer.byteLength(serialized, "utf8");
    if (size > options.maxBytes) {
      throw new SafeJsonError(
        "SAFE_JSON_TOO_LARGE",
        `Serialized JSON payload exceeds ${options.maxBytes} bytes.`,
      );
    }
  }

  return sanitized;

  function walk(input: unknown, depth: number): SafeJsonValue {
    visited += 1;
    if (visited > maxNodes) {
      throw new SafeJsonError(
        "SAFE_JSON_TOO_MANY_NODES",
        `JSON payload exceeded ${maxNodes} traversed nodes.`,
      );
    }

    if (depth > maxDepth) {
      throw new SafeJsonError(
        "SAFE_JSON_TOO_DEEP",
        `JSON payload exceeded maximum depth ${maxDepth}.`,
      );
    }

    if (input === null) {
      return null;
    }

    if (input instanceof Date) {
      return input.toISOString();
    }

    if (input instanceof URL) {
      return input.toString();
    }

    switch (typeof input) {
      case "string":
        return input;
      case "number":
        if (!Number.isFinite(input)) {
          throw new SafeJsonError(
            "SAFE_JSON_INVALID_TYPE",
            "JSON payload contains a non-finite number.",
          );
        }
        return input;
      case "boolean":
        return input;
      case "undefined":
      case "function":
      case "symbol":
      case "bigint":
        throw new SafeJsonError(
          "SAFE_JSON_INVALID_TYPE",
          `Unsupported JSON value type: ${typeof input}.`,
        );
      case "object":
        break;
      default:
        throw new SafeJsonError(
          "SAFE_JSON_INVALID_TYPE",
          "Unsupported JSON value.",
        );
    }

    if (ArrayBuffer.isView(input) || input instanceof ArrayBuffer) {
      throw new SafeJsonError(
        "SAFE_JSON_UNSUPPORTED_OBJECT",
        "Binary values are not allowed in JSON bridge payloads.",
      );
    }

    if (Array.isArray(input)) {
      if (input.length > maxArrayLength) {
        throw new SafeJsonError(
          "SAFE_JSON_ARRAY_TOO_LARGE",
          `JSON array exceeded maximum length ${maxArrayLength}.`,
        );
      }
      return input.map((item) => walk(item, depth + 1));
    }

    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new SafeJsonError(
        "SAFE_JSON_UNSUPPORTED_OBJECT",
        "Only plain-object JSON payloads are allowed.",
      );
    }

    if (seen.has(input)) {
      throw new SafeJsonError(
        "SAFE_JSON_UNSUPPORTED_OBJECT",
        "Circular JSON payloads are not allowed.",
      );
    }

    seen.add(input);
    const entries = Object.entries(input);
    if (entries.length > maxObjectKeys) {
      throw new SafeJsonError(
        "SAFE_JSON_TOO_MANY_KEYS",
        `JSON object exceeded maximum key count ${maxObjectKeys}.`,
      );
    }

    const output: Record<string, SafeJsonValue> = {};
    for (const [key, entryValue] of entries) {
      if (DANGEROUS_KEYS.has(key)) {
        continue;
      }
      output[key] = walk(entryValue, depth + 1);
    }
    return output;
  }
}

export function sanitizeJsonObject(
  value: unknown,
  options: SafeJsonOptions = {},
): Record<string, SafeJsonValue> {
  const sanitized = sanitizeJsonValue(value, options);
  if (
    Array.isArray(sanitized) ||
    sanitized === null ||
    typeof sanitized !== "object"
  ) {
    throw new SafeJsonError(
      "SAFE_JSON_INVALID_TYPE",
      "Expected a JSON object payload.",
    );
  }
  return sanitized;
}
