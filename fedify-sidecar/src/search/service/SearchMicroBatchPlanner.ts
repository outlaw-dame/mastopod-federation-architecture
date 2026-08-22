import type { KafkaMessage } from 'kafkajs';

export interface SearchMicroBatchPlan {
  messages: KafkaMessage[];
  concurrent: boolean;
}

/**
 * Build bounded concurrency groups without weakening projection ordering.
 *
 * Only ordinary ActivityPub Create/Note events are eligible for concurrent
 * processing. Actor mutations and tombstones are barriers because actor consent
 * changes can delete content by author. Within a note group, object IDs must be
 * unique so two mutations of the same search document can never race.
 */
export function planSearchMicroBatches(
  messages: KafkaMessage[],
  topic: string,
  firehoseTopic: string,
  maxParallel: number,
): SearchMicroBatchPlan[] {
  const limit = Math.max(1, Math.floor(maxParallel));
  if (limit === 1 || topic !== firehoseTopic) {
    return messages.map((message) => ({ messages: [message], concurrent: false }));
  }

  const plans: SearchMicroBatchPlan[] = [];
  let cursor = 0;

  while (cursor < messages.length) {
    const first = inspectConcurrentCandidate(messages[cursor]!);
    if (!first) {
      plans.push({ messages: [messages[cursor]!], concurrent: false });
      cursor += 1;
      continue;
    }

    const group: KafkaMessage[] = [];
    const conflictKeys = new Set<string>();

    while (cursor < messages.length && group.length < limit) {
      const message = messages[cursor]!;
      const candidate = inspectConcurrentCandidate(message);
      if (!candidate) break;
      if (conflictKeys.has(candidate.conflictKey)) break;

      conflictKeys.add(candidate.conflictKey);
      group.push(message);
      cursor += 1;
    }

    plans.push({ messages: group, concurrent: group.length > 1 });
  }

  return plans;
}

export function inspectConcurrentCandidate(
  message: KafkaMessage,
): { conflictKey: string } | null {
  const raw = message.value?.toString();
  if (!raw) return null;

  let event: any;
  try {
    event = JSON.parse(raw);
  } catch {
    return null;
  }

  const activity = event?.activity;
  if (!activity || activity.type !== 'Create') return null;

  const object = activity.object;
  if (!object || typeof object !== 'object' || object.type !== 'Note') return null;
  if (typeof object.id !== 'string' || object.id.length === 0) return null;

  return { conflictKey: `ap-object:${object.id}` };
}
