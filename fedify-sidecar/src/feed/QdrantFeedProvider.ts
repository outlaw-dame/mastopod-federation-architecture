import type { FeedCandidateService } from "../search/queries/FeedCandidateService.js";
import { SearchFeedProvider } from "./SearchFeedProvider.js";
import { QdrantDocumentStore, type QdrantDocumentStoreConfig } from "./QdrantDocumentStore.js";

export class QdrantFeedProvider extends SearchFeedProvider {
  constructor(config: QdrantDocumentStoreConfig, candidateService: FeedCandidateService) {
    super(new QdrantDocumentStore(config), candidateService);
  }
}