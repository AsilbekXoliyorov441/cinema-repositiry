/** Fraction of the runtime after which an item counts as watched. */
export const COMPLETION_THRESHOLD = 0.9;
/** Fallback upper bound for client-reported duration when the catalog has no runtime. */
export const MAX_DURATION_SECONDS = 24 * 3600;

export interface ProgressInput {
  positionSeconds: number;
  clientDurationSeconds?: number | undefined;
  catalogDurationSeconds: number | null;
}

export type ProgressDecision =
  | { ok: true; positionSeconds: number; durationSeconds: number; completed: boolean }
  | { ok: false; reason: string };

/**
 * Validates a progress report. The catalog runtime wins over the client value; when the runtime
 * changed (e.g. admin corrected it) positions slightly beyond it are clamped, larger ones rejected.
 */
export function evaluateProgress({ positionSeconds, clientDurationSeconds, catalogDurationSeconds }: ProgressInput): ProgressDecision {
  const duration = catalogDurationSeconds ?? clientDurationSeconds;
  if (!duration || duration <= 0 || duration > MAX_DURATION_SECONDS) {
    return { ok: false, reason: 'A valid duration is required for this title' };
  }
  if (positionSeconds < 0) return { ok: false, reason: 'Position cannot be negative' };
  const tolerance = Math.max(60, Math.round(duration * 0.05));
  if (positionSeconds > duration + tolerance) return { ok: false, reason: 'Position exceeds the title duration' };
  const position = Math.min(positionSeconds, duration);
  return { ok: true, positionSeconds: position, durationSeconds: duration, completed: position >= duration * COMPLETION_THRESHOLD };
}
