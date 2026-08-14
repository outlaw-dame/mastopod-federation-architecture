from pathlib import Path

path = Path('fedify-sidecar/src/index.ts')
text = path.read_text()

def replace_once(old: str, new: str, label: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    text = text.replace(old, new, 1)

replace_once(
'''  evaluateOutboundWebhookBackpressure,\n  normalizeAndDedupeOutboundTargets,\n  OutboundWebhookValidationError,\n  resolveOutboundWebhookBackpressureConfigFromEnv,\n''',
'''  evaluateOutboundWebhookBackpressure,\n  normalizeAndDedupeOutboundTargets,\n  OutboundWebhookValidationError,\n  resolveOutboundWebhookBackpressureConfigFromEnv,\n  validateApdmWebhookIdentity,\n''',
'import APDM identity validator',
)

replace_once(
'''        const normalizedTargets = normalizeAndDedupeOutboundTargets(\n          remoteTargets,\n          outboundWebhookBackpressureConfig,\n        );\n        promMetrics.outboundWebhookTargetCount.observe(normalizedTargets.inputTargetCount);\n''',
'''        const normalizedTargets = normalizeAndDedupeOutboundTargets(\n          remoteTargets,\n          outboundWebhookBackpressureConfig,\n        );\n        const authoritativeIntentId = validateApdmWebhookIdentity({\n          normalizedTargets,\n          headerIntentId: request.headers["x-apdm-intent-id"],\n          meta: normalizedMeta,\n        });\n        promMetrics.outboundWebhookTargetCount.observe(normalizedTargets.inputTargetCount);\n''',
'bind APDM marker/header/meta identity',
)

replace_once(
'''        const intent = createOutboxIntent({\n          activityId,\n          actorUri,\n          activity: JSON.stringify(activityRecord),\n          targets: normalizedTargets.targets,\n''',
'''        const intent = createOutboxIntent({\n          ...(authoritativeIntentId ? { intentId: authoritativeIntentId } : {}),\n          activityId,\n          actorUri,\n          activity: JSON.stringify(activityRecord),\n          targets: normalizedTargets.targets,\n''',
'preserve Delivery Plan intent identity in durable queue',
)

observation_route = r'''    // Native rollback observation webhook — durable indexing/event-log only.\n    // It accepts no delivery targets and marks the resulting durable intent so\n    // OutboxIntentWorker returns before any recipient normalization or fan-out.\n    app.post("/webhook/outbox-observation", async (request, reply) => {\n      const authHeader = (request.headers["authorization"] as string) || "";\n      const [scheme, token] = authHeader.split(" ");\n      if (scheme !== "Bearer" || token !== config.sidecarToken) {\n        reply.status(401).send({ error: "Unauthorized" });\n        return;\n      }\n\n      let body: Record<string, unknown> | null = null;\n      if (typeof request.body === "string") {\n        try {\n          const parsed = JSON.parse(request.body) as unknown;\n          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {\n            body = parsed as Record<string, unknown>;\n          }\n        } catch {\n          body = null;\n        }\n      } else if (request.body && typeof request.body === "object" && !Array.isArray(request.body)) {\n        body = request.body as Record<string, unknown>;\n      }\n\n      const actorUri = body?.["actorUri"];\n      const activity = body?.["activity"];\n      if (\n        typeof actorUri !== "string"\n        || actorUri.trim().length === 0\n        || actorUri !== actorUri.trim()\n        || !activity\n        || typeof activity !== "object"\n        || Array.isArray(activity)\n        || (body && (Object.hasOwn(body, "remoteTargets") || Object.hasOwn(body, "deliveryTargets")))\n      ) {\n        reply.status(400).send({ error: "Bad Request" });\n        return;\n      }\n\n      const eventIdHeader = request.headers["x-event-id"];\n      const eventSchemaHeader = request.headers["x-event-schema"];\n      if (\n        typeof eventIdHeader !== "string"\n        || eventIdHeader.trim().length === 0\n        || eventIdHeader !== eventIdHeader.trim()\n        || eventIdHeader.length > 256\n        || eventSchemaHeader !== "ap.outbox.committed.v1"\n      ) {\n        reply.status(400).send({\n          error: "Observation identity is missing or invalid",\n          code: "OUTBOX_OBSERVATION_IDENTITY_INVALID",\n        });\n        return;\n      }\n\n      if (!queue || !config.enableOutboxIntentWorker) {\n        reply.status(503).send({ error: "Service unavailable" });\n        return;\n      }\n\n      const bodyRecord = body as Record<string, unknown>;\n      const activityRecord = activity as Record<string, unknown>;\n      const activityIdValue = bodyRecord["activityId"];\n      const activityId = typeof activityIdValue === "string" && activityIdValue.trim().length > 0\n        ? activityIdValue\n        : typeof activityRecord["id"] === "string" && activityRecord["id"].trim().length > 0\n          ? activityRecord["id"]\n          : null;\n      if (!activityId) {\n        reply.status(400).send({\n          error: "activityId is required when activity.id is not present.",\n          code: "OUTBOX_OBSERVATION_ACTIVITY_ID_MISSING",\n        });\n        return;\n      }\n\n      const metaValue = bodyRecord["meta"];\n      const normalizedMeta = metaValue && typeof metaValue === "object" && !Array.isArray(metaValue)\n        ? metaValue\n        : undefined;\n\n      const outboxIntentPending = await queue.getPendingCount("outbox_intent");\n      const outboxIntentLength = await queue.getStreamLength("outbox_intent");\n      const backpressure = evaluateOutboundWebhookBackpressure(\n        { pendingCount: outboxIntentPending, streamLength: outboxIntentLength },\n        outboundWebhookBackpressureConfig,\n      );\n      if (backpressure.reject) {\n        if (backpressure.retryAfterSeconds) {\n          reply.header("retry-after", backpressure.retryAfterSeconds.toString());\n        }\n        reply.status(503).send({\n          error: "Outbox observation queue is under backpressure",\n          reason: backpressure.reason,\n          retryAfterSeconds: backpressure.retryAfterSeconds,\n        });\n        return;\n      }\n\n      const intent = createOutboxIntent({\n        intentId: `apdm-observation:${eventIdHeader}`,\n        activityId,\n        actorUri,\n        activity: JSON.stringify(activityRecord),\n        targets: [],\n        ...(normalizedMeta ? { meta: normalizedMeta } : {}),\n        bridgeHints: { observationOnly: true },\n      });\n      await queue.enqueueOutboxIntent(intent);\n      reply.status(202).send({\n        accepted: true,\n        intentId: intent.intentId,\n        jobCount: 0,\n        observationOnly: true,\n      });\n    });\n\n'''.replace('\\n', '\n')

replace_once(
'''    // Outbound webhook — receives delivery work from ActivityPods\n    app.post("/webhook/outbox", async (request, reply) => {\n''',
observation_route + '''    // Outbound webhook — receives delivery work from ActivityPods\n    app.post("/webhook/outbox", async (request, reply) => {\n''',
'add native observation-only webhook',
)

path.write_text(text)
print('patched', path)
