import type { CanonicalIntent } from "../../canonical/CanonicalIntent.js";
import type { TranslationContext } from "../../ports/ProtocolBridgePorts.js";
import type { ProtocolTranslator } from "../../registry/TranslatorRegistry.js";
import { supportsDeleteActivity, translateDeleteActivity } from "./shared.js";

export class DeleteTranslator implements ProtocolTranslator<unknown> {
  public supports(input: unknown): boolean {
    return supportsDeleteActivity(input);
  }

  public async translate(input: unknown, ctx: TranslationContext): Promise<CanonicalIntent | null> {
    return translateDeleteActivity(input, ctx);
  }
}
