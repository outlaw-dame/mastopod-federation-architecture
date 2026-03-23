import { AtAliasStore } from './AtAliasStore';
import { StrongRef } from '../projection/serializers/PostRecordSerializer';

export interface AtRecordRefResolver {
  resolvePostStrongRef(canonicalPostId: string): Promise<StrongRef | null>;
}

export class DefaultAtRecordRefResolver implements AtRecordRefResolver {
  constructor(private readonly aliasStore: AtAliasStore) {}

  async resolvePostStrongRef(canonicalPostId: string): Promise<StrongRef | null> {
    const alias = await this.aliasStore.getByCanonicalRefId(canonicalPostId);
    if (!alias || !alias.cid) {
      return null;
    }

    return {
      uri: alias.atUri,
      cid: alias.cid,
    };
  }
}
