import type { FeedCandidateService } from "../search/queries/FeedCandidateService.js";
import { SearchFeedProvider } from "./SearchFeedProvider.js";
import { OpenSearchDocumentStore, type OpenSearchSearchClient } from "./OpenSearchDocumentStore.js";
import type { SearchReadRetryPolicy } from "./OpenSearchRetry.js";

export class OpenSearchFeedProvider extends SearchFeedProvider {

  constructor(
    osClient: OpenSearchSearchClient,
    candidateService: FeedCandidateService,
    options: { indexName?: string; retryPolicy?: Partial<SearchReadRetryPolicy>; requestTimeoutMs?: number } = {},
  ) {
    super(new OpenSearchDocumentStore(osClient, options), candidateService);
  }
}
