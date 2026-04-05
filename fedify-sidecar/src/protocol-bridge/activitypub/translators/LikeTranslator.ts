import type { CanonicalIntent } from "../../canonical/CanonicalIntent.js";
import type { TranslationContext } from "../../ports/ProtocolBridgePorts.js";
import type { ProtocolTranslator } from "../../registry/TranslatorRegistry.js";
import { supportsSocialActivity, translateLikeActivity } from "./social.js";

export class LikeTranslator implements ProtocolTranslator<unknown> {
  public supports(input: unknown): boolean {
    return supportsSocialActivity(input, "Like");
  }

  public async translate(input: unknown, ctx: TranslationContext): Promise<CanonicalIntent | null> {
    return translateLikeActivity(input, ctx);
  }
}
