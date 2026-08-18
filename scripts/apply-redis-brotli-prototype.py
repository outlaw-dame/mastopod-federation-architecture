from pathlib import Path

path = Path("fedify-sidecar/src/queue/sidecar-redis-queue-core.ts")
text = path.read_text()

replacements = [
    (
        'import { logger } from "../utils/logger.js";\nimport type { OutboundDeliveryMeta } from "../core-domain/contracts/SigningContracts.js";\n',
        'import { logger } from "../utils/logger.js";\nimport type { OutboundDeliveryMeta } from "../core-domain/contracts/SigningContracts.js";\nimport {\n  RedisStreamPayloadCodec,\n  createRedisStreamPayloadCodecFromEnv,\n  type RedisStreamPayloadCodecConfig,\n} from "./redis-stream-payload-codec.js";\n',
    ),
    (
        '  claimBatchCount?: number;\n}\n',
        '  claimBatchCount?: number;\n  /** Optional override used by tests and staged rollouts. Env defaults remain write-disabled. */\n  payloadCompression?: RedisStreamPayloadCodecConfig;\n}\n',
    ),
    (
        '  private readonly claimBatchCount: number;\n\n  private isConnected = false;\n',
        '  private readonly claimBatchCount: number;\n  private readonly payloadCodec: RedisStreamPayloadCodec;\n\n  private isConnected = false;\n',
    ),
    (
        '    const redisUrl = config.redisUrl ?? process.env["REDIS_URL"] ?? "redis://localhost:6379";\n\n    this.redis = createClient({ url: redisUrl });\n',
        '    const redisUrl = config.redisUrl ?? process.env["REDIS_URL"] ?? "redis://localhost:6379";\n    this.payloadCodec = config.payloadCompression\n      ? new RedisStreamPayloadCodec(config.payloadCompression)\n      : createRedisStreamPayloadCodecFromEnv();\n\n    this.redis = createClient({ url: redisUrl });\n',
    ),
    (
        '      for (const job of chunk) {\n        multi.xAdd(\n          this.outboundStreamKey,\n          "*",\n          this.serializeOutboundJob(job),\n',
        '      const encodedActivityCache = new Map<string, string>();\n      for (const job of chunk) {\n        multi.xAdd(\n          this.outboundStreamKey,\n          "*",\n          this.serializeOutboundJob(job, this.encodeActivityCached(job.activity, encodedActivityCache)),\n',
    ),
    (
        '  private deserializeOutboxIntent(messageId: string, fields: Record<string, string>): OutboxIntent {\n    const rawTargets = this.requireField(fields, "targets", messageId);\n',
        '  private deserializeOutboxIntent(messageId: string, fields: Record<string, string>): OutboxIntent {\n    const rawTargets = this.payloadCodec.decode(this.requireField(fields, "targets", messageId));\n',
    ),
    (
        '      activity: this.requireField(fields, "activity", messageId),\n      targets: parsedTargets as OutboxIntentTarget[],\n',
        '      activity: this.payloadCodec.decode(this.requireField(fields, "activity", messageId)),\n      targets: parsedTargets as OutboxIntentTarget[],\n',
    ),
    (
        '      actorUri: this.requireField(fields, "actorUri", messageId),\n      activity: this.requireField(fields, "activity", messageId),\n      targetInbox: this.requireField(fields, "targetInbox", messageId),\n',
        '      actorUri: this.requireField(fields, "actorUri", messageId),\n      activity: this.payloadCodec.decode(this.requireField(fields, "activity", messageId)),\n      targetInbox: this.requireField(fields, "targetInbox", messageId),\n',
    ),
    (
        '  private serializeOutboundJob(job: OutboundJob): Record<string, string> {\n    return {\n      jobId: job.jobId,\n      activityId: job.activityId,\n      actorUri: job.actorUri,\n      activity: job.activity,\n',
        '  private serializeOutboundJob(job: OutboundJob, encodedActivity?: string): Record<string, string> {\n    return {\n      jobId: job.jobId,\n      activityId: job.activityId,\n      actorUri: job.actorUri,\n      activity: encodedActivity ?? this.payloadCodec.encode(job.activity).value,\n',
    ),
    (
        '  private serializeOutboxIntent(intent: OutboxIntent): Record<string, string> {\n    return {\n      intentId: intent.intentId,\n      activityId: intent.activityId,\n      actorUri: intent.actorUri,\n      activity: intent.activity,\n      targets: JSON.stringify(intent.targets),\n',
        '  private serializeOutboxIntent(intent: OutboxIntent): Record<string, string> {\n    const targets = JSON.stringify(intent.targets);\n    return {\n      intentId: intent.intentId,\n      activityId: intent.activityId,\n      actorUri: intent.actorUri,\n      activity: this.payloadCodec.encode(intent.activity).value,\n      targets: this.payloadCodec.encode(targets).value,\n',
    ),
    (
        '  private serializeOriginReconciliationJob(job: OriginReconciliationJob): Record<string, string> {\n',
        '  private encodeActivityCached(activity: string, cache: Map<string, string>): string {\n    const existing = cache.get(activity);\n    if (existing !== undefined) return existing;\n    const encoded = this.payloadCodec.encode(activity).value;\n    cache.set(activity, encoded);\n    return encoded;\n  }\n\n  private serializeOriginReconciliationJob(job: OriginReconciliationJob): Record<string, string> {\n',
    ),
    (
        '    const args = [\n      this.maxStreamLength.toString(),\n      Date.now().toString(),\n      jobs.length.toString(),\n      ...jobs.flatMap((job) => {\n        const serialized = this.serializeOutboundJob(job);\n',
        '    const encodedActivityCache = new Map<string, string>();\n    const args = [\n      this.maxStreamLength.toString(),\n      Date.now().toString(),\n      jobs.length.toString(),\n      ...jobs.flatMap((job) => {\n        const serialized = this.serializeOutboundJob(\n          job,\n          this.encodeActivityCached(job.activity, encodedActivityCache),\n        );\n',
    ),
]

for old, new in replacements:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected exactly one match, got {count}: {old[:100]!r}")
    text = text.replace(old, new)

path.write_text(text)
print("patched", path)
