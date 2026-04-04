export interface ModerationSignalRecord {
  source: 'google_safe_browsing' | 'google_vision' | 'google_video_intelligence' | 'cloudflare_csam' | 'local_model' | 'human_review';
  label: string;
  score?: number;
  metadata?: Record<string, string | number | boolean | null>;
  observedAt: string;
}

export interface ModerationRecord {
  assetId: string;
  currentDecision: 'allow' | 'review' | 'block';
  labels: string[];
  confidence?: number;
  requiresHumanReview: boolean;
  reasons: string[];
  signals: ModerationSignalRecord[];
  reviewedBy?: string;
  reviewNotes?: string;
  createdAt: string;
  updatedAt: string;
}

export function createModerationRecord(params: {
  assetId: string;
  decision: 'allow' | 'review' | 'block';
  labels?: string[];
  confidence?: number;
  reasons?: string[];
  signals?: ModerationSignalRecord[];
}): ModerationRecord {
  const now = new Date().toISOString();
  return {
    assetId: params.assetId,
    currentDecision: params.decision,
    labels: params.labels || [],
    confidence: params.confidence,
    requiresHumanReview: params.decision === 'review',
    reasons: params.reasons || [],
    signals: params.signals || [],
    createdAt: now,
    updatedAt: now
  };
}
