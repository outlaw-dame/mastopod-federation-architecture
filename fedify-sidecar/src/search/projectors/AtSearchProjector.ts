/**
 * V6.5 Phase 5.25: Unified Public Indexing Addendum
 *
 * AtSearchProjector
 * Consumes: at.commit.v1 (local), at.ingress.v1 (remote verified)
 * Outputs: search.public.upsert.v1, search.public.delete.v1
 */

import { SearchPublicUpsertV1, SearchPublicDeleteV1 } from '../events/SearchEvents';
import { IdentityAliasResolver } from '../identity/IdentityAliasResolver';
import { SearchDocIdStrategy } from '../identity/SearchDocIdStrategy';
import { EventPublisher } from '../../core-domain/events/CoreIdentityEvents';
import { AtCommitV1 } from '../../at-adapter/events/AtRepoEvents';

export class AtSearchProjector {
  constructor(
    private readonly identityResolver: IdentityAliasResolver,
    private readonly eventPublisher: EventPublisher
  ) {}

  /**
   * Process an ATProto Commit event (local or remote)
   */
  async onAtCommitEvent(event: AtCommitV1, sourceKind: 'local' | 'remote'): Promise<void> {
    const did = event.did;
    
    // Resolve identity
    const identity = await this.identityResolver.resolveByAtDid(did);

    for (const op of event.ops) {
      // Only index app.bsky.feed.post
      if (op.collection !== 'app.bsky.feed.post') continue;

      const atUri = op.uri || `at://${did}/${op.collection}/${op.rkey}`;

      if (op.action === 'delete') {
        const stableDocId = sourceKind === 'local' && identity.canonicalId
          ? SearchDocIdStrategy.forLocal(op.rkey) // Assuming rkey maps to canonical ID or we can resolve it
          : SearchDocIdStrategy.forRemoteAt(atUri);

        const del: SearchPublicDeleteV1 = {
          stableDocId,
          reason: 'at_delete',
          deletedAt: event.emittedAt || new Date().toISOString()
        };

        await this.eventPublisher.publish('search.public.delete.v1', del as any);
        continue;
      }

      // For create/update, we need the record
      // In a real implementation, the record might be in the event or we'd need to fetch it.
      // For Phase 5.25, we assume the record is attached to the op (like in AtRepoOpV1)
      // or we simulate it.
      const record: any = (op as any).record;
      if (!record) continue;

      const stableDocId = sourceKind === 'local' && identity.canonicalId
        ? SearchDocIdStrategy.forLocal((op as any).canonicalRefId || op.rkey)
        : SearchDocIdStrategy.forRemoteAt(atUri);

      // Extract media
      let mediaCount = 0;
      if (record.embed) {
        if (record.embed.$type === 'app.bsky.embed.images' && record.embed.images) {
          mediaCount = record.embed.images.length;
        } else if (record.embed.$type === 'app.bsky.embed.video') {
          mediaCount = 1;
        } else if (record.embed.$type === 'app.bsky.embed.recordWithMedia' && record.embed.media) {
          if (record.embed.media.$type === 'app.bsky.embed.images' && record.embed.media.images) {
            mediaCount = record.embed.media.images.length;
          } else if (record.embed.media.$type === 'app.bsky.embed.video') {
            mediaCount = 1;
          }
        }
      }

      // Extract tags from facets
      const tags: string[] = [];
      if (record.facets) {
        for (const facet of record.facets) {
          for (const feature of facet.features) {
            if (feature.$type === 'app.bsky.richtext.facet#tag') {
              tags.push(feature.tag);
            }
          }
        }
      }

      const upsert: SearchPublicUpsertV1 = {
        stableDocId,
        canonicalContentId: sourceKind === 'local' ? ((op as any).canonicalRefId || op.rkey) : undefined,
        protocolSource: 'at',
        sourceKind,
        at: {
          uri: atUri,
          cid: op.cid,
          did
        },
        author: {
          canonicalId: identity.canonicalId,
          apUri: identity.apUri,
          did,
          handle: identity.atHandle
        },
        content: {
          text: record.text || '',
          createdAt: record.createdAt || event.emittedAt || new Date().toISOString(),
          langs: record.langs,
          tags: tags.length > 0 ? tags : undefined
        },
        relations: record.reply ? {
          replyToStableId: SearchDocIdStrategy.forRemoteAt(record.reply.parent.uri),
          quoteOfStableId: record.embed?.$type === 'app.bsky.embed.record' ? SearchDocIdStrategy.forRemoteAt(record.embed.record.uri) : undefined
        } : undefined,
        media: {
          hasMedia: mediaCount > 0,
          mediaCount
        },
        indexedAt: new Date().toISOString()
      };

      await this.eventPublisher.publish('search.public.upsert.v1', upsert as any);
    }
  }
}
