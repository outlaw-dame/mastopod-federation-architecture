import { CanonicalPost } from '../AtProjectionPolicy';

export interface EmbedBuilder {
  build(post: CanonicalPost): Promise<unknown | undefined>;
}

export class DefaultEmbedBuilder implements EmbedBuilder {
  async build(post: CanonicalPost): Promise<unknown | undefined> {
    // In Phase 3, image embeds are deferred unless blob pipeline is ready.
    // "image embeds unless blob pipeline is ready" -> deferred
    return undefined;
  }
}
