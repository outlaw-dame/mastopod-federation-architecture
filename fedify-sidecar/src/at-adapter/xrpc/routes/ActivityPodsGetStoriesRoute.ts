/**
 * org.activitypods.story.getStories
 *
 * AppView-style story carousel read. AT repositories remain the source of
 * truth, while this route gives clients the Pixelfed-style grouping they
 * expect: active slides grouped by actor, newest actors first, expired records
 * hidden by default.
 */

import type { AtRecordReader, AtStoredRecord } from '../../repo/AtRecordReader.js';
import {
  ACTIVITYPODS_STORY_COLLECTION,
  isActivityPodsStoryActive,
  normalizeActivityPodsStoryRecord,
  type ActivityPodsStoryRecord,
} from '../../lexicon/ActivityPodsStoryLexicon.js';
import { XrpcErrors } from '../middleware/XrpcErrorMapper.js';

const MAX_ACTORS = 50;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const ACTOR_RE = /^[a-zA-Z0-9:._-]{1,256}$/;

export interface ActivityPodsStoryViewItem {
  uri: string;
  cid: string;
  createdAt: string;
  expiresAt: string;
  expiresInSeconds: number;
  seen: boolean;
  value: ActivityPodsStoryRecord;
}

export interface ActivityPodsStoryGroup {
  did: string;
  repo: string;
  latestAt: string;
  seen: boolean;
  items: ActivityPodsStoryViewItem[];
}

export class ActivityPodsGetStoriesRoute {
  constructor(private readonly recordReader: AtRecordReader) {}

  async handle(
    actors: string | undefined,
    limit?: number,
    includeExpired?: boolean,
    seen?: string,
  ): Promise<{ headers: Record<string, string>; body: any }> {
    const repos = parseActors(actors);
    const safeLimit = normalizeLimit(limit);
    const seenUris = parseSeenUris(seen);
    const now = new Date();
    const groups: ActivityPodsStoryGroup[] = [];

    for (const repo of repos) {
      const listed = await this.recordReader.listRecords({
        repo,
        collection: ACTIVITYPODS_STORY_COLLECTION,
        limit: safeLimit,
        reverse: true,
      });

      const items = listed.records
        .map((record) => toStoryItem(record, now, seenUris))
        .filter((item): item is ActivityPodsStoryViewItem => {
          if (!item) return false;
          return includeExpired === true || item.expiresInSeconds > 0;
        })
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

      if (items.length === 0) {
        continue;
      }

      const latest = items[items.length - 1]!;
      groups.push({
        did: listed.records[0]?.did ?? repo,
        repo,
        latestAt: latest.createdAt,
        seen: items.every((item) => item.seen),
        items,
      });
    }

    groups.sort((a, b) => Date.parse(b.latestAt) - Date.parse(a.latestAt));

    return {
      headers: { 'Content-Type': 'application/json' },
      body: {
        cursor: null,
        generatedAt: now.toISOString(),
        stories: groups,
      },
    };
  }
}

function parseActors(value: string | undefined): string[] {
  if (!value?.trim()) {
    throw XrpcErrors.invalidRequest('actors query parameter is required');
  }

  const actors = value
    .split(',')
    .map((actor) => actor.trim())
    .filter(Boolean);

  if (actors.length === 0) {
    throw XrpcErrors.invalidRequest('actors query parameter is required');
  }
  if (actors.length > MAX_ACTORS) {
    throw XrpcErrors.invalidRequest(`actors is limited to ${MAX_ACTORS} repos`);
  }
  for (const actor of actors) {
    if (!ACTOR_RE.test(actor)) {
      throw XrpcErrors.invalidRequest(`Invalid actor repo: ${actor}`);
    }
  }
  return [...new Set(actors)];
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value)) {
    return DEFAULT_LIMIT;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw XrpcErrors.invalidRequest('limit must be a positive integer');
  }
  return Math.min(value, MAX_LIMIT);
}

function parseSeenUris(value: string | undefined): Set<string> {
  if (!value?.trim()) {
    return new Set();
  }
  return new Set(
    value
      .split(',')
      .map((uri) => uri.trim())
      .filter((uri) => uri.startsWith('at://')),
  );
}

function toStoryItem(
  record: AtStoredRecord,
  now: Date,
  seenUris: Set<string>,
): ActivityPodsStoryViewItem | null {
  const story = normalizeActivityPodsStoryRecord(record.value);
  if (!story || (!isActivityPodsStoryActive(story, now) && Date.parse(story.expiresAt!) <= now.getTime())) {
    return story ? {
      uri: record.uri,
      cid: record.cid,
      createdAt: story.createdAt!,
      expiresAt: story.expiresAt!,
      expiresInSeconds: 0,
      seen: seenUris.has(record.uri),
      value: story,
    } : null;
  }

  const expiresAtMs = Date.parse(story.expiresAt!);
  return {
    uri: record.uri,
    cid: record.cid,
    createdAt: story.createdAt!,
    expiresAt: story.expiresAt!,
    expiresInSeconds: Math.max(0, Math.ceil((expiresAtMs - now.getTime()) / 1000)),
    seen: seenUris.has(record.uri),
    value: story,
  };
}
