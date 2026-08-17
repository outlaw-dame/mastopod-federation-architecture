import { readFile, stat } from "node:fs/promises";

export const DEFAULT_ADSP_JSON_FILE_MAX_BYTES = 256 * 1024;

function positiveSafeInteger(name: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

export async function loadBoundedAdspJsonFile(
  filePath: string,
  options: {
    label?: string;
    maxBytes?: number;
  } = {},
): Promise<unknown> {
  const label = options.label ?? "ADSP JSON";
  if (!filePath || filePath !== filePath.trim()) {
    throw new TypeError(`${label} path must be a non-empty exact string`);
  }
  const limit = positiveSafeInteger(
    `max ${label} bytes`,
    options.maxBytes ?? DEFAULT_ADSP_JSON_FILE_MAX_BYTES,
  );
  const metadata = await stat(filePath);
  if (!metadata.isFile()) throw new Error(`${label} path must reference a regular file`);
  if (metadata.size > limit) {
    throw new Error(`${label} file exceeds ${limit} bytes`);
  }
  const raw = await readFile(filePath, "utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} file contains malformed JSON`);
  }
}
