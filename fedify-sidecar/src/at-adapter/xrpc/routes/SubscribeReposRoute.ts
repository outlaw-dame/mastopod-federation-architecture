/**
 * V6.5 Phase 4: com.atproto.sync.subscribeRepos
 *
 * WebSocket route that streams the shared firehose for all locally hosted
 * accounts.
 *
 * Protocol:
 *   1. Client connects via WebSocket to /xrpc/com.atproto.sync.subscribeRepos.
 *   2. Optional query param: cursor=<seq> for replay from that point.
 *   3. Server replays events after cursor (if supplied), then switches to
 *      live delivery.
 *   4. If cursor is too old, server closes with code 1008 and a message
 *      directing the client to rebootstrap via getRepo.
 *
 * Security:
 *   - cursor is validated to be a non-negative integer before use.
 *   - No authentication is required (public endpoint per ATProto spec).
 *   - Subscriber IDs are generated server-side; callers cannot inject them.
 *
 * Ref: https://atproto.com/lexicon/com-atproto-sync#comatprotosyncsubscriberepos
 */

import { AtFirehoseSubscriptionManager, FirehoseSubscriber } from '../../firehose/AtFirehoseSubscriptionManager';
import { XrpcErrors } from '../middleware/XrpcErrorMapper';

export class SubscribeReposRoute {
  constructor(private readonly subscriptionManager: AtFirehoseSubscriptionManager) {}

  async handleConnection(
    connectionId: string,
    rawCursor: string | undefined,
    sendFn: (data: Uint8Array) => Promise<void>,
    closeFn: (code?: number, reason?: string) => Promise<void>
  ): Promise<void> {
    // Validate and parse cursor.
    let cursor: number | undefined;
    if (rawCursor !== undefined && rawCursor !== '') {
      const parsed = Number(rawCursor);
      if (!Number.isInteger(parsed) || parsed < 0) {
        await closeFn(1008, 'Invalid cursor: must be a non-negative integer');
        return;
      }
      cursor = parsed;
    }

    const subscriber: FirehoseSubscriber = {
      id: connectionId,
      cursor,
      send: sendFn,
      close: closeFn
    };

    await this.subscriptionManager.attach(subscriber);
  }

  async handleDisconnection(connectionId: string): Promise<void> {
    await this.subscriptionManager.detach(connectionId);
  }
}
