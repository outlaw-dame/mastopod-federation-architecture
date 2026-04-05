import { DpopVerifier } from './DpopVerifier.js';

export class DPoPValidator {
  constructor(private readonly verifier: DpopVerifier) {}

  async validate(input: {
    proofJwt: string;
    htm: string;
    htu: string;
    nonce?: string;
    accessToken?: string;
  }) {
    return this.verifier.verify(input);
  }
}
