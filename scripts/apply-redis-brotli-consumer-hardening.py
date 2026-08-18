from pathlib import Path

path = Path("fedify-sidecar/src/queue/sidecar-redis-queue-core.ts")
text = path.read_text()

replacements = [
    (
        '    const messageIds: string[] = [];\n    const chunkSize = 250;\n\n    for (let index = 0; index < jobs.length; index += chunkSize) {\n      const chunk = jobs.slice(index, index + chunkSize);\n      const multi = this.redis.multi();\n\n      const encodedActivityCache = new Map<string, string>();\n',
        '    const messageIds: string[] = [];\n    const chunkSize = 250;\n    const encodedActivityCache = new Map<string, string>();\n\n    for (let index = 0; index < jobs.length; index += chunkSize) {\n      const chunk = jobs.slice(index, index + chunkSize);\n      const multi = this.redis.multi();\n\n',
    ),
    (
        '        for (const [messageId, fields] of this.normalizeClaimedMessages(pending?.messages)) {\n          const job = this.deserializeOutboundJob(messageId, fields);\n          yield { messageId, job };\n        }\n',
        '        for (const [messageId, fields] of this.normalizeClaimedMessages(pending?.messages)) {\n          try {\n            const job = this.deserializeOutboundJob(messageId, fields);\n            yield { messageId, job };\n          } catch (error) {\n            this.logRejectedStreamMessage("outbound", messageId, error);\n          }\n        }\n',
    ),
    (
        '        for (const [, streamMessages] of this.normalizeStreamRead(messages)) {\n          for (const [messageId, fields] of streamMessages) {\n            const job = this.deserializeOutboundJob(messageId, fields);\n            yield { messageId, job };\n          }\n        }\n',
        '        for (const [, streamMessages] of this.normalizeStreamRead(messages)) {\n          for (const [messageId, fields] of streamMessages) {\n            try {\n              const job = this.deserializeOutboundJob(messageId, fields);\n              yield { messageId, job };\n            } catch (error) {\n              this.logRejectedStreamMessage("outbound", messageId, error);\n            }\n          }\n        }\n',
    ),
    (
        '        for (const [messageId, fields] of this.normalizeClaimedMessages(pending?.messages)) {\n          const intent = this.deserializeOutboxIntent(messageId, fields);\n          yield { messageId, intent };\n        }\n',
        '        for (const [messageId, fields] of this.normalizeClaimedMessages(pending?.messages)) {\n          try {\n            const intent = this.deserializeOutboxIntent(messageId, fields);\n            yield { messageId, intent };\n          } catch (error) {\n            this.logRejectedStreamMessage("outbox_intent", messageId, error);\n          }\n        }\n',
    ),
    (
        '        for (const [, streamMessages] of this.normalizeStreamRead(messages)) {\n          for (const [messageId, fields] of streamMessages) {\n            const intent = this.deserializeOutboxIntent(messageId, fields);\n            yield { messageId, intent };\n          }\n        }\n',
        '        for (const [, streamMessages] of this.normalizeStreamRead(messages)) {\n          for (const [messageId, fields] of streamMessages) {\n            try {\n              const intent = this.deserializeOutboxIntent(messageId, fields);\n              yield { messageId, intent };\n            } catch (error) {\n              this.logRejectedStreamMessage("outbox_intent", messageId, error);\n            }\n          }\n        }\n',
    ),
    (
        '  private deserializeOutboxIntent(messageId: string, fields: Record<string, string>): OutboxIntent {\n',
        '  private logRejectedStreamMessage(\n    type: "outbound" | "outbox_intent",\n    messageId: string,\n    error: unknown,\n  ): void {\n    logger.error(\n      {\n        type,\n        messageId,\n        error: error instanceof Error ? error.message : String(error),\n      },\n      "Rejected malformed Redis Stream message; source remains pending",\n    );\n  }\n\n  private deserializeOutboxIntent(messageId: string, fields: Record<string, string>): OutboxIntent {\n',
    ),
]

for old, new in replacements:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected exactly one match, got {count}: {old[:120]!r}")
    text = text.replace(old, new)

path.write_text(text)
print("patched", path)
