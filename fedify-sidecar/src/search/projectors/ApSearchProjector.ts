/**
 * V6.5 Phase 5.25: Unified Public Indexing Addendum
 *
 * ApSearchProjector
 * Consumes: ap.firehose.v1, ap.tombstone.v1
 * Outputs: search.public.upsert.v1, search.public.delete.v1
 */

import { SearchPublicUpsertV1, SearchPublicDeleteV1, SearchAuthorUpsertV1, SearchAuthorDeleteV1 } from '../events/SearchEvents.js';
import { IdentityAliasResolver } from '../identity/IdentityAliasResolver.js';
import { SearchDocIdStrategy } from '../identity/SearchDocIdStrategy.js';
import { EventPublisher } from '../../core-domain/events/CoreIdentityEvents.js';
import { extractHashtagsFromActivityPubTags, extractHashtagsFromText } from '../../utils/hashtags.js';

export class ApSearchProjector {
  constructor(
    private readonly identityResolver: IdentityAliasResolver,
    private readonly eventPublisher: EventPublisher
  ) {}

  /**
   * Process an ActivityPub Create Note event
   */
  async onApFirehoseEvent(event: any): Promise<void> {
    const activity = event.activity;
    if (!activity) return;

    if (activity.type === 'Create' && activity.object?.type === 'Person') {
      await this.projectActor(activity.object, event.origin === 'local');
      return;
    } else if (activity.type === 'Update' && activity.object?.type === 'Person') {
      await this.projectActor(activity.object, event.origin === 'local');
      return;
    }

    if (activity.type !== 'Create') return;

    const object = activity.object;
    if (!object || typeof object !== 'object' || object.type !== 'Note') return;

    // Only index public content
    const isPublic = this.isPublic(activity) || this.isPublic(object);
    if (!isPublic) return;

    const actorUri = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
    if (!actorUri) return;

    const objectUri = typeof object.id === 'string' ? object.id : undefined;
    if (!objectUri) return;

    // Resolve identity
    const identity = await this.identityResolver.resolveByApUri(actorUri);

    // Determine stable ID
    const isLocal = event.origin === 'local';
    const stableDocId = isLocal && identity.canonicalId
      ? SearchDocIdStrategy.forLocal(objectUri) // In a real system, we'd map AP URI to Canonical ID here
      : SearchDocIdStrategy.forRemoteAp(objectUri);

    // Strip HTML from content
    const text = this.stripHtml(object.content || '');

    // Extract media
    const attachments = Array.isArray(object.attachment) ? object.attachment : (object.attachment ? [object.attachment] : []);
    const mediaCount = attachments.length;

    // Extract reply
    const inReplyTo = typeof object.inReplyTo === 'string' ? object.inReplyTo : object.inReplyTo?.id;

    const upsert: SearchPublicUpsertV1 = {
      upsertKind: 'full',
      stableDocId,
      canonicalContentId: isLocal ? objectUri : undefined, // Simplified for Phase 5.25
      protocolSource: 'ap',
      sourceKind: isLocal ? 'local' : 'remote',
      ap: {
        objectUri,
        activityUri: activity.id
      },
      author: {
        canonicalId: identity.canonicalId,
        apUri: actorUri,
        did: identity.atDid,
        handle: identity.atHandle
      },
      content: {
        text,
        createdAt: object.published || activity.published || new Date().toISOString(),
        langs: object.contentMap ? Object.keys(object.contentMap) : undefined,
        tags: this.extractTags(object.tag, object.content)
      },
      relations: inReplyTo ? {
        replyToStableId: SearchDocIdStrategy.forRemoteAp(inReplyTo) // Best effort without full resolution
      } : undefined,
      media: {
        hasMedia: mediaCount > 0,
        mediaCount
      },
      indexedAt: new Date().toISOString()
    };

    await this.eventPublisher.publish('search.public.upsert.v1', upsert as any);
  }

  /**
   * Process an ActivityPub Delete/Tombstone event
   */
  async onApTombstoneEvent(event: any): Promise<void> {
    const objectUri = event.objectId;
    if (!objectUri) return;

    const isLocal = event.origin === 'local';
    
    // We don't know the canonical ID here easily without a lookup,
    // so we emit with the AP-based stable ID. The IndexWriter will need to handle this.
    const stableDocId = SearchDocIdStrategy.forRemoteAp(objectUri);

    const del: SearchPublicDeleteV1 = {
      stableDocId,
      reason: 'ap_tombstone',
      deleteMode: 'soft',
      deletedAt: new Date().toISOString()
    };

    await this.eventPublisher.publish('search.public.delete.v1', del as any);
  }

  private async projectActor(actor: any, isLocal: boolean): Promise<void> {
    const apUri = actor.id;
    if (!apUri) return;

    const stableAuthorId = await SearchDocIdStrategy.forRemoteAp(apUri);
    
    // Try to resolve canonical ID if known
    const identity = await this.identityResolver.resolveByApUri(apUri);

    const upsert: SearchAuthorUpsertV1 = {
      stableAuthorId: identity.canonicalId || stableAuthorId,
      canonicalAccountId: identity.canonicalId,
      protocolSource: 'ap',
      sourceKind: isLocal ? 'local' : 'remote',
      apUri,
      displayName: actor.name,
      summaryText: actor.summary ? this.stripHtml(actor.summary) : undefined,
      handle: actor.preferredUsername,
      updatedAt: new Date().toISOString()
    };

    await this.eventPublisher.publish('search.author.upsert.v1', upsert as any);
  }

  private isPublic(obj: any): boolean {
    const publicUris = [
      'https://www.w3.org/ns/activitystreams#Public',
      'as:Public',
      'Public'
    ];
    
    const to = Array.isArray(obj.to) ? obj.to : (obj.to ? [obj.to] : []);
    const cc = Array.isArray(obj.cc) ? obj.cc : (obj.cc ? [obj.cc] : []);
    
    return to.some((uri: any) => publicUris.includes(uri)) || cc.some((uri: any) => publicUris.includes(uri));
  }

  private stripHtml(html: string): string {
    return html.replace(/<[^>]*>?/gm, '').trim();
  }

  private extractTags(tags: any, content?: string): string[] | undefined {
    const fromTags = extractHashtagsFromActivityPubTags(tags);
    const fromContent = typeof content === 'string'
      ? extractHashtagsFromText(this.stripHtml(content))
      : [];

    const hashtags = Array.from(new Set([...fromTags, ...fromContent]));

    return hashtags.length > 0 ? hashtags : undefined;
  }
}
