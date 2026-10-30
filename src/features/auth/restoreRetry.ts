import type { RestoreOutcome } from '@/types';

export const RETRY_BASE_DELAY_MS = 2000;
export const RETRY_MAX_DELAY_MS = 15000;
// Long enough to outlast a proxy restart or rebuild; past it the server is likely just wrong.
// No attempt starts later than this after the first.
export const RETRY_WINDOW_MS = 5 * 60 * 1000;

export type RestoreUpdate = { outcome: RestoreOutcome; retrying: boolean };

/**
 * A failed restore carried across a redirect, so the next page reports it instead of
 * sending the same key again. Plain fields only: router state must be cloneable.
 */
export type RestoreFailureHandoff = {
  retryable: boolean;
  error: { status?: number; code?: string; message: string };
};

export const toRestoreFailureHandoff = (outcome: RestoreOutcome): RestoreFailureHandoff | null => {
  if (outcome.status !== 'failed') return null;
  const { status, code, message } = (outcome.error ?? {}) as {
    status?: unknown;
    code?: unknown;
    message?: unknown;
  };
  return {
    retryable: outcome.retryable,
    error: {
      status: typeof status === 'number' ? status : undefined,
      code: typeof code === 'string' ? code : undefined,
      message: typeof message === 'string' ? message : '',
    },
  };
};

export const retryDelayMs = (failures: number) =>
  Math.min(RETRY_BASE_DELAY_MS * 2 ** (failures - 1), RETRY_MAX_DELAY_MS);

interface RestoreRetryOptions {
  restore: () => Promise<RestoreOutcome>;
  /** Stops a restore already in flight from signing in. */
  cancel: () => void;
  onUpdate: (update: RestoreUpdate) => void;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Restores a saved sign-in, retrying with backoff while the proxy cannot be reached.
 * `stop()` cancels the pending retry and the attempt in flight; a cancelled attempt can
 * neither sign in nor report back, so a manual sign-in can start straight away.
 */
export function createRestoreRetry({
  restore,
  cancel,
  onUpdate,
  now = Date.now,
  setTimer = (run, ms) => setTimeout(run, ms),
  clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}: RestoreRetryOptions) {
  let generation = 0;
  let failures = 0;
  let startedAt = 0;
  let timer: unknown = null;
  let inFlight = false;

  const settle = (current: number, outcome: RestoreOutcome) => {
    if (current !== generation) return;
    const delay = retryDelayMs(failures + 1);
    const retrying =
      outcome.status === 'failed' &&
      outcome.retryable &&
      now() + delay - startedAt <= RETRY_WINDOW_MS;
    if (retrying) {
      failures += 1;
      timer = setTimer(() => {
        timer = null;
        attempt(current);
      }, delay);
    }
    onUpdate({ outcome, retrying });
  };

  const attempt = (current: number) => {
    inFlight = true;
    void restore().then((outcome) => {
      if (current === generation) inFlight = false;
      settle(current, outcome);
    });
  };

  return {
    /** Starts restoring; with a failure handed over from a redirect, waits before retrying it. */
    start(handedOver?: RestoreFailureHandoff | null) {
      generation += 1;
      failures = 0;
      startedAt = now();
      if (handedOver) {
        settle(generation, { status: 'failed', ...handedOver });
      } else {
        attempt(generation);
      }
    },
    stop() {
      generation += 1;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      if (inFlight) {
        inFlight = false;
        cancel();
      }
    },
  };
}
