import { Kafka } from 'kafkajs';
import { config } from '../config.js';

const kafka = new Kafka({ brokers: config.redpanda.brokers });
const producer = kafka.producer();

export async function initProducer() {
  if (!config.redpanda.enabled) return;
  await producer.connect();
}

export async function publish(topic: string, payload: any) {
  if (!config.redpanda.enabled) return;

  await producer.send({
    topic,
    messages: [{ value: JSON.stringify(payload) }]
  });
}
