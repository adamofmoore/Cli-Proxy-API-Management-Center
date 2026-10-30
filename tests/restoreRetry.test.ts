import { describe, expect, test } from 'bun:test';
import {
  createRestoreRetry,
  retryDelayMs,
  RETRY_WINDOW_MS,
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

  test('gives up once the proxy has been unreachable for the whole retry window', async () => {
    const h = harness(Array.from({ length: 100 }, () => unreachable));
    h.retry.start();
    await h.flush();
    while (h.pendingDelays().length) await h.advance(h.pendingDelays()[0]);

    expect(h.updates.at(-1)).toEqual({ outcome: unreachable, retrying: false });
    expect(h.attempts()).toBeLessThan(30);
    expect(h.updates.filter((u) => u.retrying).length).toBe(h.attempts() - 1);
    expect(RETRY_WINDOW_MS).toBe(5 * 60 * 1000);
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

  test('stop() silences an attempt already in flight and waits for it to settle', async () => {
    const h = harness([unreachable]);
    h.holdNextAnswer();
    h.retry.start();

    let stopped = false;
    const stopping = h.retry.stop().then(() => {
      stopped = true;
    });
    await h.flush();
    expect(stopped).toBe(false);

    expect(h.cancels()).toBe(1);
    h.releaseHeldAnswer();
    await stopping;
    expect(h.updates).toEqual([]);
    expect(h.pendingDelays()).toEqual([]);
  });

  test('stop() cancels a scheduled retry', async () => {
    const h = harness([unreachable]);
    h.retry.start();
    await h.flush();
    await h.retry.stop();
    await h.advance(60_000);

    expect(h.attempts()).toBe(1);
    expect(h.cancels()).toBe(0);
  });
});
