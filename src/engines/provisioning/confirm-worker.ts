import type { SweepResult } from './confirm-sweep.js';

export interface WorkerClock { now(): number; }
export interface WorkerOpts {
  intervalMs: number;
  sweep: (clock: { now: number }) => Promise<SweepResult>;
  onError?: (err: unknown) => void;
}
export interface WorkerHandle { stop(): void; }

/**
 * Thin lifecycle shell around sweepPendingConfirmations. Lives in server.ts ONLY (never buildApp), so unit
 * tests and the HTTP harness do not spin a loop. Overlap-safe: never starts a tick while the prior is in
 * flight. Errors are isolated per tick (a transient store/gateway error must not kill the worker).
 */
export function startConfirmationWorker(clock: WorkerClock, opts: WorkerOpts): WorkerHandle {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await opts.sweep({ now: clock.now() });
    } catch (err) {
      opts.onError?.(err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), opts.intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => clearInterval(timer) };
}
