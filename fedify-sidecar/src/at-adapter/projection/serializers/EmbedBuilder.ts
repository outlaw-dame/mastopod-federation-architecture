import { CanonicalPost } from '../AtProjectionPolicy';
import { ImageEmbedBuilder } from './ImageEmbedBuilder';

export interface EmbedBuilder {
  build(post: CanonicalPost, did: string): Promise<unknown | undefined>;
}

export class DefaultEmbedBuilder implements EmbedBuilder {
  constructor(private readonly imageEmbedBuilder: ImageEmbedBuilder) {}

  async build(post: CanonicalPost, did: string): Promise<unknown | undefined> {
    // Embed priority for Phase 5:
    // 1. image embed if there are images
    // 2. else quote embed if resolvable (deferred)
    // 3. else external embed if you already support it (deferred)
    // 4. else none

    const imageEmbed = await this.imageEmbedBuilder.build(post, did);
    if (imageEmbed) {
      return imageEmbed;
    }

    return undefined;
  }
}
