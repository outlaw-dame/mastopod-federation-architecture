import { CanonicalPost } from '../AtProjectionPolicy.js';
import { ImageEmbedBuilder } from './ImageEmbedBuilder.js';
import { VideoEmbedBuilder } from './VideoEmbedBuilder.js';

export interface EmbedBuilder {
  build(post: CanonicalPost, did: string): Promise<unknown | undefined>;
}

export class DefaultEmbedBuilder implements EmbedBuilder {
  constructor(
    private readonly imageEmbedBuilder: ImageEmbedBuilder,
    private readonly videoEmbedBuilder: VideoEmbedBuilder,
  ) {}

  async build(post: CanonicalPost, did: string): Promise<unknown | undefined> {
    // Embed priority for AT-native writes:
    // 1. video embed if there are videos
    // 2. image embed if there are images
    // 2. else quote embed if resolvable (deferred)
    // 3. else external embed if you already support it (deferred)
    // 4. else none

    const videoEmbed = await this.videoEmbedBuilder.build(post, did);
    if (videoEmbed) {
      return videoEmbed;
    }

    const imageEmbed = await this.imageEmbedBuilder.build(post, did);
    if (imageEmbed) {
      return imageEmbed;
    }

    return undefined;
  }
}
