import { AnnounceTranslator } from "./translators/AnnounceTranslator.js";
import { CreateArticleTranslator } from "./translators/CreateArticleTranslator.js";
import { CreateNoteTranslator } from "./translators/CreateNoteTranslator.js";
import { DeleteTranslator } from "./translators/DeleteTranslator.js";
import { EmojiReactionTranslator } from "./translators/EmojiReactionTranslator.js";
import { FollowTranslator } from "./translators/FollowTranslator.js";
import { LikeTranslator } from "./translators/LikeTranslator.js";
import { UndoTranslator } from "./translators/UndoTranslator.js";
import { UpdateArticleTranslator } from "./translators/UpdateArticleTranslator.js";
import { UpdateNoteTranslator } from "./translators/UpdateNoteTranslator.js";
import { UpdatePersonTranslator } from "./translators/UpdatePersonTranslator.js";
import { TranslatorRegistry } from "../registry/TranslatorRegistry.js";

export class ActivityPubToCanonicalTranslator extends TranslatorRegistry<unknown> {
  public constructor() {
    super([
      new CreateArticleTranslator(),
      new CreateNoteTranslator(),
      new UpdateArticleTranslator(),
      new UpdateNoteTranslator(),
      new UpdatePersonTranslator(),
      new DeleteTranslator(),
      new EmojiReactionTranslator(),
      new LikeTranslator(),
      new AnnounceTranslator(),
      new FollowTranslator(),
      new UndoTranslator(),
    ]);
  }
}
