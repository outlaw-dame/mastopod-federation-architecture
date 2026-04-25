import { ActivityPodsEmojiReactionTranslator } from "./translators/ActivityPodsEmojiReactionTranslator.js";
import { BskyPostDeleteTranslator } from "./translators/BskyPostDeleteTranslator.js";
import { BskyPostgateTranslator } from "./translators/BskyPostgateTranslator.js";
import { BskyProfileTranslator } from "./translators/BskyProfileTranslator.js";
import { BskyFollowTranslator } from "./translators/BskyFollowTranslator.js";
import { BskyLikeTranslator } from "./translators/BskyLikeTranslator.js";
import { BskyPostTranslator } from "./translators/BskyPostTranslator.js";
import { BskyRepostTranslator } from "./translators/BskyRepostTranslator.js";
import { BskyThreadgateTranslator } from "./translators/BskyThreadgateTranslator.js";
import { StandardSiteDocumentTranslator } from "./translators/StandardSiteDocumentTranslator.js";
import { StandardSiteDocumentDeleteTranslator } from "./translators/StandardSiteDocumentDeleteTranslator.js";
import { TranslatorRegistry } from "../registry/TranslatorRegistry.js";

export class AtprotoToCanonicalTranslator extends TranslatorRegistry<unknown> {
  public constructor() {
    super([
      new BskyPostTranslator(),
      new BskyPostDeleteTranslator(),
      new BskyThreadgateTranslator(),
      new BskyPostgateTranslator(),
      new BskyProfileTranslator(),
      new ActivityPodsEmojiReactionTranslator(),
      new BskyLikeTranslator(),
      new BskyRepostTranslator(),
      new BskyFollowTranslator(),
      new StandardSiteDocumentTranslator(),
      new StandardSiteDocumentDeleteTranslator(),
    ]);
  }
}
