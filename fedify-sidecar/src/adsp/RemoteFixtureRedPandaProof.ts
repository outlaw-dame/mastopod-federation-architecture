import { createClient } from "redis";

const OUTBOX_INTENT_STATE_PREFIX = "ap:outbox-intent:state:";

export interface AdspRemoteRedisHashReadPort {
  hGetAll(key: string): Promise<Record<string, string>>;
}

function exact(name: string, value: unknown): string {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new TypeError(`${name} must be a non-empty exact string`);
  }
  return value;
}

export function parseRedPandaPublishedAt(raw: Record<string, string>): number {
  const value = raw["eventLogPublishedAt"];
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error("ADSP ActivityPods-origin fixture requires a durable RedPanda eventLogPublishedAt marker");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("ADSP RedPanda eventLogPublishedAt marker must be a positive safe integer");
  }
  return parsed;
}

export async function requireActivityPodsOriginRedPandaProof(input: {
  redisUrl: string;
  intentId: string;
}): Promise<number> {
  const redisUrl = exact("redisUrl", input.redisUrl);
  const intentId = exact("intentId", input.intentId);
  const redis = createClient({ url: redisUrl });
  redis.on("error", () => undefined);
  try {
    await redis.connect();
    const raw = await (redis as unknown as AdspRemoteRedisHashReadPort).hGetAll(
      `${OUTBOX_INTENT_STATE_PREFIX}${intentId}`,
    );
    return parseRedPandaPublishedAt(raw);
  } finally {
    if (redis.isOpen) await redis.quit().catch(() => undefined);
  }
}
