import { request } from "undici";
import {
  HttpControlledTargetSnapshotClient,
  normalizeControlledTargetStatsUrl,
} from "./ControlledTargetSnapshotClient.js";
import type { ControlledTargetSnapshot } from "./ControlledActivityPubTarget.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

type DestroyableBody = AsyncIterable<Uint8Array> & { destroy?: () => void };

function positiveSafeInteger(name: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

async function readBoundedText(body: DestroyableBody, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const bytes = Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) {
      body.destroy?.();
      throw new Error(`controlled target reset response exceeded ${maxBytes} bytes`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export interface AdspControlledTargetFixturePort {
  reset(): Promise<void>;
  readSnapshot(): Promise<ControlledTargetSnapshot>;
}

export class HttpControlledTargetFixtureClient implements AdspControlledTargetFixturePort {
  private readonly resetUrl: URL;
  private readonly snapshotClient: HttpControlledTargetSnapshotClient;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(
    statsUrl: string,
    options: {
      timeoutMs?: number;
      maxSnapshotBytes?: number;
      maxResetResponseBytes?: number;
    } = {},
  ) {
    const normalizedStatsUrl = normalizeControlledTargetStatsUrl(statsUrl);
    this.resetUrl = new URL("/reset", normalizedStatsUrl.origin);
    this.timeoutMs = positiveSafeInteger("timeoutMs", options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.maxResponseBytes = positiveSafeInteger(
      "maxResetResponseBytes",
      options.maxResetResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    );
    this.snapshotClient = new HttpControlledTargetSnapshotClient(normalizedStatsUrl.href, {
      timeoutMs: this.timeoutMs,
      ...(options.maxSnapshotBytes !== undefined
        ? { maxBodyBytes: options.maxSnapshotBytes }
        : {}),
    });
  }

  async reset(): Promise<void> {
    const response = await request(this.resetUrl, {
      method: "POST",
      headersTimeout: this.timeoutMs,
      bodyTimeout: this.timeoutMs,
      maxRedirections: 0,
    });
    if (response.statusCode !== 200) {
      response.body.destroy();
      throw new Error(`controlled target reset returned HTTP ${response.statusCode}`);
    }
    const text = await readBoundedText(response.body, this.maxResponseBytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("controlled target reset returned malformed JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed as Record<string, unknown>)["ok"] !== true) {
      throw new Error("controlled target reset did not confirm ok=true");
    }
  }

  readSnapshot(): Promise<ControlledTargetSnapshot> {
    return this.snapshotClient.readSnapshot();
  }
}

export function assertEmptyControlledTargetSnapshot(snapshot: ControlledTargetSnapshot): void {
  if (
    snapshot.totalRequests !== 0
    || snapshot.droppedObservations !== 0
    || snapshot.observations.length !== 0
    || snapshot.counts.success !== 0
    || snapshot.counts.transient !== 0
    || snapshot.counts.permanent !== 0
  ) {
    throw new Error("controlled target did not reset to an empty evidence ledger");
  }
}
