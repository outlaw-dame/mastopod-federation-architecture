/**
 * V6.5 Phase 5.25: Unified Public Indexing Addendum
 *
 * AtSearchProjector
 * Consumes: at.commit.v1 (local), at.ingress.v1 (remote verified)
 * Outputs: search.public.upsert.v1, search.public.delete.v1
 */

import { SearchPublicUpsertV1, SearchPublicDeleteV1 } from '../events/SearchEvents.js';
import { IdentityAliasResolver } from '../identity/IdentityAliasResolver.js';
import { SearchDocIdStrategy } from '../identity/SearchDocIdStrategy.js';
import { EventPublisher } from '../../core-domain/events/CoreIdentityEvents.js';
import { AtCommitV1 } from '../../at-adapter/events/AtRepoEvents.js';
import { extractAtprotoTagsFromFacets, extractAtprotoTagsFromRecordTags } from '../../utils/hashtags.js';
import { extractEmojisFromText } from '../../utils/emojis.js';

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
          deleteMode: 'soft',
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

      // ATProto hashtags can come from facets and post.tags.
      const tagsFromFacets = extractAtprotoTagsFromFacets(record.facets);
      const tagsFromRecord = extractAtprotoTagsFromRecordTags(record.tags);
      const tags = Array.from(new Set([...tagsFromFacets, ...tagsFromRecord]));
      const emojis = extractEmojisFromText(record.text || '');
      const replyToStableId = typeof record.reply?.parent?.uri === 'string'
        ? SearchDocIdStrategy.forRemoteAt(record.reply.parent.uri)
        : undefined;
      const quoteUri = extractQuotedAtUri(record.embed);
      const quoteOfStableId = quoteUri ? SearchDocIdStrategy.forRemoteAt(quoteUri) : undefined;
      const relations = replyToStableId || quoteOfStableId
        ? {
            ...(replyToStableId ? { replyToStableId } : {}),
            ...(quoteOfStableId ? { quoteOfStableId } : {}),
          }
        : undefined;

      const upsert: SearchPublicUpsertV1 = {
        upsertKind: 'full',
        stableDocId,
        upsertKind: 'full',
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
          tags: tags.length > 0 ? tags : undefined,
          emojis: emojis.length > 0 ? emojis : undefined
        },
        relations,
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

function extractQuotedAtUri(embed: any): string | undefined {
  if (!embed || typeof embed !== 'object') {
    return undefined;
  }

  if (embed.$type === 'app.bsky.embed.record' && typeof embed.record?.uri === 'string') {
    return embed.record.uri;
  }

  if (embed.$type === 'app.bsky.embed.recordWithMedia' && typeof embed.record?.uri === 'string') {
    return embed.record.uri;
  }

  return undefined;
}
