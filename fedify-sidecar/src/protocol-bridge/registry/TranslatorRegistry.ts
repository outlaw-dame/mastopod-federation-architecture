import type { CanonicalIntent } from "../canonical/CanonicalIntent.js";
import type { TranslationContext } from "../ports/ProtocolBridgePorts.js";

export interface ProtocolTranslator<TInput> {
  supports(input: TInput): boolean;
  translate(input: TInput, ctx: TranslationContext): Promise<CanonicalIntent | null>;
}

export class TranslatorRegistry<TInput> {
  private readonly translators: Array<ProtocolTranslator<TInput>>;

  public constructor(translators: Array<ProtocolTranslator<TInput>> = []) {
    this.translators = [...translators];
  }

  public register(translator: ProtocolTranslator<TInput>): void {
    this.translators.push(translator);
  }

  public async translate(input: TInput, ctx: TranslationContext): Promise<CanonicalIntent | null> {
    for (const translator of this.translators) {
      if (!translator.supports(input)) {
        continue;
      }
      const translated = await translator.translate(input, ctx);
      if (translated) {
        return translated;
      }
    }
    return null;
  }
}
