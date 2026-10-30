import { describe, expect, test } from 'bun:test';
import {
  createRestoreRetry,
  retryDelayMs,
  RETRY_WINDOW_MS,
  toRestoreFailureHandoff,
  type RestoreUpdate,
} from '../src/features/auth/restoreRetry';
import type { RestoreOutcome } from '../src/types';

const unreachable: RestoreOutcome = {
  status: 'failed',
  retryable: true,
  error: { code: 'ERR_NETWORK' },
};
const rejected: RestoreOutcome = { status: 'failed', retryable: false, error: { status: 401 } };

/** A controller on a hand-cranked clock, with a restore whose answers the test scripts. */
function harness(answers: RestoreOutcome[]) {
  let clock = 0;
  const timers: { at: number; run: () => void }[] = [];
  const updates: RestoreUpdate[] = [];
  let attempts = 0;
  let release: (() => void) | null = null;
  let holdNext = false;
  let cancels = 0;

  const retry = createRestoreRetry({
    restore: () => {
      attempts += 1;
      const outcome = answers.shift() ?? { status: 'restored' };
      if (!holdNext) return Promise.resolve(outcome);
      holdNext = false;
      return new Promise((resolve) => {
        release = () => resolve(outcome);
      });
    },
    cancel: () => {
      cancels += 1;
    },
    onUpdate: (update) => updates.push(update),
    now: () => clock,
    setTimer: (run, ms) => {
      const timer = { at: clock + ms, run };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => timers.splice(timers.indexOf(handle as (typeof timers)[number]), 1),
  });

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    retry,
    updates,
    attempts: () => attempts,
    cancels: () => cancels,
    pendingDelays: () => timers.map((timer) => timer.at - clock),
    holdNextAnswer: () => {
      holdNext = true;
    },
    releaseHeldAnswer: () => release?.(),
    flush,
    async advance(ms: number) {
      clock += ms;
      for (const timer of timers.filter((t) => t.at <= clock)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.run();
      }
      await flush();
    },
  };
}

describe('restoring with retries', () => {
  test('backs off 2s, 4s, 8s, then holds at 15s while the proxy cannot be reached', () => {
    expect([1, 2, 3, 4, 5, 6].map(retryDelayMs)).toEqual([2000, 4000, 8000, 15000, 15000, 15000]);
  });

  test('keeps retrying an unreachable proxy and reports when it gets back in', async () => {
    const h = harness([unreachable, unreachable]);
    h.retry.start();
    await h.flush();
    expect(h.updates.at(-1)).toEqual({ outcome: unreachable, retrying: true });
    expect(h.pendingDelays()).toEqual([2000]);

    await h.advance(2000);
    expect(h.pendingDelays()).toEqual([4000]);

    await h.advance(4000);
    expect(h.attempts()).toBe(3);
    expect(h.updates.at(-1)).toEqual({ outcome: { status: 'restored' }, retrying: false });
    expect(h.pendingDelays()).toEqual([]);
  });

  test('never starts an attempt later than the retry window, then gives up', async () => {
    const h = harness(Array.from({ length: 100 }, () => unreachable));
    const startedAt: number[] = [];
    let clock = 0;
    h.retry.start();
    await h.flush();
    startedAt.push(clock);
    while (h.pendingDelays().length) {
      const delay = h.pendingDelays()[0];
      clock += delay;
      await h.advance(delay);
      startedAt.push(clock);
    }

    expect(h.updates.at(-1)).toEqual({ outcome: unreachable, retrying: false });
    expect(Math.max(...startedAt)).toBeLessThanOrEqual(RETRY_WINDOW_MS);
    // The next 15s retry would have started past the window.
    expect(Math.max(...startedAt) + 15000).toBeGreaterThan(RETRY_WINDOW_MS);
    expect(h.attempts()).toBe(startedAt.length);
  });

  test.each([
    ['exactly at the end of the window', RETRY_WINDOW_MS, 2],
    ['1ms past the window', RETRY_WINDOW_MS + 1, 1],
  ])(
    'a retry whose timer fires late (sleeping device) runs only within the window: %s',
    async (_label, firesAt, attempts) => {
      const h = harness([unreachable]);
      h.retry.start();
      await h.flush();
      expect(h.pendingDelays()).toEqual([2000]);

      await h.advance(firesAt);

      expect(h.attempts()).toBe(attempts);
      expect(h.pendingDelays()).toEqual([]);
      expect(h.updates.at(-1)?.retrying).toBe(false);
    }
  );

  test('starting again cancels the previous run, including its attempt in flight', async () => {
    const h = harness([unreachable, rejected]);
    h.holdNextAnswer();
    h.retry.start();

    h.retry.start();
    expect(h.cancels()).toBe(1);
    h.releaseHeldAnswer();
    await h.flush();
    await h.advance(60_000);

    expect(h.attempts()).toBe(2);
    expect(h.updates).toEqual([{ outcome: rejected, retrying: false }]);
  });

  test('a failure handed over across a redirect keeps only plain, cloneable fields', () => {
    const error = Object.assign(new Error('invalid management key'), {
      status: 401,
      code: 'ERR_BAD_REQUEST',
      details: { nested: true },
    });

    const handoff = toRestoreFailureHandoff({ status: 'failed', retryable: false, error });

    expect(handoff).toEqual({
      retryable: false,
      error: { status: 401, code: 'ERR_BAD_REQUEST', message: 'invalid management key' },
    });
    expect(structuredClone(handoff)).toEqual(handoff);
    expect(toRestoreFailureHandoff({ status: 'none' })).toBeNull();
  });

  test('does not retry a rejected key', async () => {
    const h = harness([rejected]);
    h.retry.start();
    await h.flush();

    expect(h.updates).toEqual([{ outcome: rejected, retrying: false }]);
    expect(h.pendingDelays()).toEqual([]);
  });

  test('a failure handed over from a redirect waits before trying again, instead of resending at once', async () => {
    const h = harness([]);
    h.retry.start({ retryable: true, error: { code: 'ERR_NETWORK', message: 'Network Error' } });

    expect(h.attempts()).toBe(0);
    expect(h.updates.at(-1)?.retrying).toBe(true);
    expect(h.pendingDelays()).toEqual([2000]);
  });

  test('a rejected key handed over from a redirect is reported and never resent', async () => {
    const h = harness([]);
    h.retry.start({ retryable: false, error: { status: 401, message: 'invalid' } });
    await h.advance(60_000);

    expect(h.attempts()).toBe(0);
    expect(h.updates.at(-1)?.retrying).toBe(false);
  });

  test('stop() cancels an attempt already in flight and ignores its answer', async () => {
    const h = harness([unreachable]);
    h.holdNextAnswer();
    h.retry.start();

    h.retry.stop();
    expect(h.cancels()).toBe(1);
    h.releaseHeldAnswer();
    await h.flush();

    expect(h.updates).toEqual([]);
    expect(h.pendingDelays()).toEqual([]);
  });

  test('stop() cancels a scheduled retry', async () => {
    const h = harness([unreachable]);
    h.retry.start();
    await h.flush();
    h.retry.stop();
    await h.advance(60_000);

    expect(h.attempts()).toBe(1);
    expect(h.cancels()).toBe(0);
  });
});
