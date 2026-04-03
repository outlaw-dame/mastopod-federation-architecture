import type { CanonicalIntent } from "../../canonical/CanonicalIntent.js";
import type { TranslationContext } from "../../ports/ProtocolBridgePorts.js";
import type { ProtocolTranslator } from "../../registry/TranslatorRegistry.js";
import { supportsSocialActivity, translateFollowActivity } from "./social.js";

export class FollowTranslator implements ProtocolTranslator<unknown> {
  public supports(input: unknown): boolean {
    return supportsSocialActivity(input, "Follow");
  }

  public async translate(input: unknown, ctx: TranslationContext): Promise<CanonicalIntent | null> {
    return translateFollowActivity(input, ctx);
  }
}
