import fs from "node:fs";
import path from "node:path";
import { createClient } from "redis";
import {
  REDIS_STREAM_PAYLOAD_ENVELOPE_PREFIX,
  RedisStreamPayloadCodec,
} from "../src/queue/redis-stream-payload-codec.js";

type StreamEvidence = {
  stream: string;
  messageId: string;
  activityId: string;
  activityCompressed: boolean;
  sourceBytes: number;
  storedBytes: number;
  storageReduction: number;
};

const activityId = process.argv[2];
const outputPath = process.argv[3];

if (!activityId) {
  throw new Error("Usage: assert-real-redis-stream-compression.ts <activity-id> [output-path]");
}

const redisUrl = process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379";
const streamKeys = [
  process.env["OUTBOX_INTENT_STREAM_KEY"] ?? "ap:queue:outbox-intent:v1",
  process.env["OUTBOUND_STREAM_KEY"] ?? "ap:queue:outbound:v1",
];
const codec = new RedisStreamPayloadCodec();
const client = createClient({ url: redisUrl });

function activityObjectId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as Record<string, unknown>)["id"];
  if (typeof id === "string") return id;
  if (id && typeof id === "object" && typeof (id as Record<string, unknown>)["id"] === "string") {
    return (id as Record<string, string>)["id"];
  }
  return undefined;
}

await client.connect();
try {
  const matches: StreamEvidence[] = [];

  for (const stream of streamKeys) {
    let start = "-";
    while (true) {
      const rows = await client.xRange(stream, start, "+", { COUNT: 1_000 });
      for (const row of rows) {
        const message = row.message as Record<string, string>;
        if (message["activityId"] !== activityId) continue;

        const storedActivity = message["activity"];
        if (typeof storedActivity !== "string" || !storedActivity.startsWith(REDIS_STREAM_PAYLOAD_ENVELOPE_PREFIX)) {
          throw new Error(`Redis Stream activity ${activityId} was not stored in the Brotli envelope`);
        }

        const decoded = codec.decode(storedActivity);
        const parsed = JSON.parse(decoded) as unknown;
        const decodedId = activityObjectId(parsed);
        if (decodedId !== activityId) {
          throw new Error(
            `Compressed Redis Stream activity decoded to unexpected id ${decodedId ?? "<missing>"}; expected ${activityId}`,
          );
        }

        const sourceBytes = Buffer.byteLength(decoded);
        const storedBytes = Buffer.byteLength(storedActivity);
        if (storedBytes >= sourceBytes) {
          throw new Error("Compressed Redis Stream envelope did not reduce stored bytes");
        }

        matches.push({
          stream,
          messageId: row.id,
          activityId,
          activityCompressed: true,
          sourceBytes,
          storedBytes,
          storageReduction: sourceBytes / storedBytes,
        });
      }

      if (rows.length < 1_000) break;
      start = `(${rows[rows.length - 1]!.id}`;
    }
  }

  if (matches.length === 0) {
    throw new Error(`No compressed Redis Stream activity was found for ${activityId}`);
  }

  const evidence = {
    schema: "activitypods.activitypub.real-sidecar-redis-compression.v1",
    ok: true,
    activityId,
    codecEnvelope: REDIS_STREAM_PAYLOAD_ENVELOPE_PREFIX,
    matches,
  };
  const json = `${JSON.stringify(evidence, null, 2)}\n`;

  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, json);
  }
  process.stdout.write(json);
} finally {
  await client.quit();
}
