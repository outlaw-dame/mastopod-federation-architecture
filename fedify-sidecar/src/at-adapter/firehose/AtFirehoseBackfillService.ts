/**
 * V6.5 Phase 4: AT Firehose Backfill Service
 *
 * Handles backfill for subscribers that reconnect with a cursor.
 * Wraps the cursor store's readFrom with structured error handling and
 * provides a higher-level interface for the SubscribeReposRoute.
 *
 * If the requested cursor is older than the available replay window, the
 * service returns a BackfillResult with tooOld=true so the caller can
 * direct the client to rebootstrap via getRepo.
 */

import { AtFirehoseCursorStore, FirehoseEventEnvelope } from './AtFirehoseCursorStore.js';

export interface BackfillResult {
  events: FirehoseEventEnvelope[];
  tooOld: boolean;
  latestSeq: number;
}

export interface AtFirehoseBackfillService {
  backfill(cursorExclusive: number, limit: number): Promise<BackfillResult>;
}

export class DefaultAtFirehoseBackfillService implements AtFirehoseBackfillService {
  constructor(private readonly cursorStore: AtFirehoseCursorStore) {}

  async backfill(cursorExclusive: number, limit: number): Promise<BackfillResult> {
    if (!Number.isInteger(cursorExclusive) || cursorExclusive < 0) {
      throw new Error(`Invalid cursor: ${cursorExclusive}`);
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error(`Invalid limit: ${limit}`);
    }

    const latestSeq = await this.cursorStore.latestSeq();
    const events = await this.cursorStore.readFrom(cursorExclusive, limit);

    // If the cursor is in the past but we have no events, the replay window
    // may have been trimmed — signal tooOld so the client can rebootstrap.
    const tooOld = events.length === 0 && cursorExclusive < latestSeq;

    return { events, tooOld, latestSeq };
  }
}
