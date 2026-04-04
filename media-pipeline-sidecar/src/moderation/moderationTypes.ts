export type ModerationDecision = 'allow' | 'review' | 'block';

export interface ImageModerationSignals {
  googleVision?: {
    adult?: string;
    spoof?: string;
    medical?: string;
    violence?: string;
    racy?: string;
  };
  localModels?: Array<{
    model: string;
    label: string;
    score: number;
  }>;
}

export interface VideoModerationSignals {
  googleVideoIntelligence?: {
    operationName?: string;
    state?: 'queued' | 'running' | 'done';
    frames?: Array<{
      timeOffset?: string;
      pornographyLikelihood?: string;
    }>;
  };
  localModels?: Array<{
    model: string;
    label: string;
    score: number;
    frameTimeMs?: number;
  }>;
}

export interface ModerationOutcome<TSignals> {
  decision: ModerationDecision;
  reasons: string[];
  signals: TSignals;
}
