import { Kafka } from 'kafkajs';
import { config } from '../config/config';

const kafka = new Kafka({ brokers: config.redpanda.brokers });
const producer = kafka.producer();
let isConnected = false;

export async function publishMediaEvent(topic: string, payload: unknown): Promise<void> {
  if (!config.redpanda.enabled || config.redpanda.brokers.length === 0) return;

  if (!isConnected) {
    await producer.connect();
    isConnected = true;
  }

  await producer.send({
    topic,
    messages: [{ value: JSON.stringify(payload) }]
  });
}
