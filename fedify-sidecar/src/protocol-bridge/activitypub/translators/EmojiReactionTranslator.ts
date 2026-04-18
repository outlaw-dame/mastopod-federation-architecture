import type { CanonicalIntent } from "../../canonical/CanonicalIntent.js";
import type { TranslationContext } from "../../ports/ProtocolBridgePorts.js";
import type { ProtocolTranslator } from "../../registry/TranslatorRegistry.js";
import { isApEmojiReactionActivity } from "../../../utils/apEmojiReactions.js";
import { translateEmojiReactionActivity } from "./social.js";

export class EmojiReactionTranslator implements ProtocolTranslator<unknown> {
  public supports(input: unknown): boolean {
    return isApEmojiReactionActivity(input);
  }

  public async translate(input: unknown, ctx: TranslationContext): Promise<CanonicalIntent | null> {
    return translateEmojiReactionActivity(input, ctx);
  }
}
