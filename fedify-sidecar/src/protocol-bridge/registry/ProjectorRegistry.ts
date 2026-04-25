import type { CanonicalIntent } from "../canonical/CanonicalIntent.js";
import type { ProjectionContext, ProjectionResult } from "../ports/ProtocolBridgePorts.js";

export interface CanonicalProjector<TCommand> {
  supports(intent: CanonicalIntent): boolean;
  project(intent: CanonicalIntent, ctx: ProjectionContext): Promise<ProjectionResult<TCommand>>;
}

export class ProjectorRegistry<TCommand> {
  private readonly projectors: Array<CanonicalProjector<TCommand>>;

  public constructor(projectors: Array<CanonicalProjector<TCommand>> = []) {
    this.projectors = [...projectors];
  }

  public register(projector: CanonicalProjector<TCommand>): void {
    this.projectors.push(projector);
  }

  public async project(
    intent: CanonicalIntent,
    ctx: ProjectionContext,
  ): Promise<ProjectionResult<TCommand>> {
    for (const projector of this.projectors) {
      if (!projector.supports(intent)) {
        continue;
      }
      return projector.project(intent, ctx);
    }

    return {
      kind: "unsupported",
      reason: `No canonical projector registered for intent kind ${intent.kind}`,
    };
  }
}
