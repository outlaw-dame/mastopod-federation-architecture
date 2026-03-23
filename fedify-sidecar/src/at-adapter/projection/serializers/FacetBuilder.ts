import { CanonicalPost } from '../AtProjectionPolicy';

export interface FacetBuilder {
  build(post: CanonicalPost): Promise<unknown[]>;
}

export class DefaultFacetBuilder implements FacetBuilder {
  async build(post: CanonicalPost): Promise<unknown[]> {
    // In Phase 3, we keep it simple. We could parse mentions and links here.
    // For now, return empty array as we are just getting the basic text working.
    return [];
  }
}
