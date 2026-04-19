import type { CanonicalIntent } from "../../canonical/CanonicalIntent.js";
import type { TranslationContext } from "../../ports/ProtocolBridgePorts.js";
import type { ProtocolTranslator } from "../../registry/TranslatorRegistry.js";
import { supportsCreateQuestion, translateCreateQuestion } from "./question-shared.js";

export class CreateQuestionTranslator implements ProtocolTranslator<unknown> {
  public supports(input: unknown): boolean {
    return supportsCreateQuestion(input);
  }

  public async translate(input: unknown, ctx: TranslationContext): Promise<CanonicalIntent | null> {
    return translateCreateQuestion(input, ctx);
  }
}
