import { Kafka } from 'kafkajs';
import { config } from '../config/config';
import { retryAsync } from '../utils/retry';

const kafka = new Kafka({ brokers: config.redpanda.brokers });
const producer = kafka.producer();
let isConnected = false;

export async function publishMediaEvent(topic: string, payload: unknown): Promise<void> {
  if (!config.redpanda.enabled || config.redpanda.brokers.length === 0) return;

  await retryAsync(async () => {
    if (!isConnected) {
      await producer.connect();
      isConnected = true;
    }

    await producer.send({
      topic,
      messages: [{ value: JSON.stringify(payload) }]
    });
  }, {
    retries: 3,
    baseDelayMs: 400,
    maxDelayMs: 4000
  });
}
