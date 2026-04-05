import type { CanonicalIntent } from "../../canonical/CanonicalIntent.js";
import type { TranslationContext } from "../../ports/ProtocolBridgePorts.js";
import type { ProtocolTranslator } from "../../registry/TranslatorRegistry.js";
import { supportsProfileUpdateActivity, translateProfileUpdateActivity } from "./shared.js";

export class UpdatePersonTranslator implements ProtocolTranslator<unknown> {
  public supports(input: unknown): boolean {
    return supportsProfileUpdateActivity(input);
  }

  public async translate(input: unknown, ctx: TranslationContext): Promise<CanonicalIntent | null> {
    return translateProfileUpdateActivity(input, ctx);
  }
}
