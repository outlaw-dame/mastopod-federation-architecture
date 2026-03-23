/**
 * V6.5 Phase 5: Reply Ref Resolver
 *
 * Resolves root and parent strong refs for ATProto reply threads.
 */

import { CanonicalPost } from '../AtProjectionPolicy';
import { AtTargetAliasResolver, StrongRef } from '../../repo/AtTargetAliasResolver';

export interface ReplyStrongRefs {
  root: StrongRef;
  parent: StrongRef;
}

export interface ReplyRefResolver {
  resolve(post: CanonicalPost): Promise<ReplyStrongRefs | null>;
}

export class DefaultReplyRefResolver implements ReplyRefResolver {
  constructor(
    private readonly aliasResolver: AtTargetAliasResolver,
    private readonly postRepository: any // Mocked dependency for Phase 5 to walk ancestry
  ) {}

  async resolve(post: CanonicalPost): Promise<ReplyStrongRefs | null> {
    // If it's not a reply, return null
    if (!post.replyToCanonicalPostId) {
      return null;
    }

    // 1. Resolve immediate parent
    const parentRef = await this.aliasResolver.resolvePostStrongRef(post.replyToCanonicalPostId);
    if (!parentRef) {
      // Strict policy: if parent is not resolvable, do not emit reply block
      return null;
    }

    // 2. Walk canonical ancestry to top-most reply ancestor
    let currentId = post.replyToCanonicalPostId;
    let rootId = currentId;
    
    // Safety limit to prevent infinite loops
    let depth = 0;
    const MAX_DEPTH = 50;

    while (depth < MAX_DEPTH) {
      const currentPost = await this.postRepository.getById(currentId);
      if (!currentPost || !currentPost.replyToCanonicalPostId) {
        break;
      }
      currentId = currentPost.replyToCanonicalPostId;
      rootId = currentId;
      depth++;
    }

    // 3. Resolve top-most ancestor AT strong ref
    const rootRef = await this.aliasResolver.resolvePostStrongRef(rootId);

    if (!rootRef) {
      // Pragmatic fallback: if root is unresolvable but parent is, use parent as root
      return {
        root: parentRef,
        parent: parentRef
      };
    }

    return {
      root: rootRef,
      parent: parentRef
    };
  }
}
