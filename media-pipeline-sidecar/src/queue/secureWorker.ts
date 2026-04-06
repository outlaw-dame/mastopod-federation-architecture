import { pushToDlq } from './dlq';
import { redis } from './redisClient';

/**
 * MEDIA PIPELINE RULE:
 * This service MUST NOT make moderation decisions.
 * Only emits raw safety signals.
 * Policy decisions are handled by MRF.
 */
export async function runSecureWorker(params: {
  stream: string;
  group: string;
  consumer: string;
  handler: (message: Record<string, string>) => Promise<void>;
}): Promise<void> {
  try {
    await redis.xGroupCreate(params.stream, params.group, '0', { MKSTREAM: true });
  } catch {
    // group already exists
  }

  while (true) {
    const result = await redis.xReadGroup(
      params.group,
      params.consumer,
      [{ key: params.stream, id: '>' }],
      { COUNT: 10, BLOCK: 5000 }
    );

    if (!result) continue;

    for (const stream of result) {
      for (const message of stream.messages) {
        try {
          await params.handler(message.message);
          await redis.xAck(params.stream, params.group, message.id);
        } catch (err) {
          await pushToDlq({
            stream: params.stream,
            messageId: message.id,
            error: err instanceof Error ? err.message : 'unknown-error',
            payload: JSON.stringify(message.message)
          });
          await redis.xAck(params.stream, params.group, message.id);
        }
      }
    }
  }
}
