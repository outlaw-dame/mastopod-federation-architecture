import { SearchHydrator } from "./OpenSearchHydrator.js";
import { QdrantDocumentStore, type QdrantDocumentStoreConfig } from "./QdrantDocumentStore.js";

export class QdrantHydrator extends SearchHydrator {
  constructor(config: QdrantDocumentStoreConfig) {
    super(new QdrantDocumentStore(config));
  }
}