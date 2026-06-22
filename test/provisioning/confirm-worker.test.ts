import { describe, it, expect, vi, afterEach } from 'vitest';
import { startConfirmationWorker } from '../../src/engines/provisioning/confirm-worker.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('startConfirmationWorker', () => {
  it('sweeps on each interval and stops cleanly', async () => {
    vi.useFakeTimers();
    const sweep = vi.fn().mockResolvedValue({ scanned: 0, confirmed: 0, pending: 0, noop: 0 });
    const handle = startConfirmationWorker({ now: () => 1000 }, { intervalMs: 1000, sweep });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sweep).toHaveBeenCalledTimes(2);
    handle.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it('routes sweep errors to onError and keeps ticking', async () => {
    vi.useFakeTimers();
    const error = new Error('store unavailable');
    const sweep = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue({ scanned: 0, confirmed: 0, pending: 0, noop: 0 });
    const onError = vi.fn();
    const handle = startConfirmationWorker(
      { now: () => 1000 },
      { intervalMs: 1000, sweep, onError },
    );
    // First tick: rejects → onError called, worker survives
    await vi.advanceTimersByTimeAsync(1000);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error);
    // Second tick: resolves normally
    await vi.advanceTimersByTimeAsync(1000);
    expect(sweep).toHaveBeenCalledTimes(2);
    handle.stop();
  });
});
