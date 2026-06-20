import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { debounce } from '../../src/lib/dom-observer';

describe('debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should invoke fn only once after waitMs of inactivity (trailing-edge)', () => {
    const fn = vi.fn();
    const debouncedFn = debounce(fn, 100);

    debouncedFn('call1');
    debouncedFn('call2');
    debouncedFn('call3');

    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith('call3');
  });

  it('should reset the timer on each new call (standard debounce)', () => {
    const fn = vi.fn();
    const debouncedFn = debounce(fn, 100);

    debouncedFn('a');
    vi.advanceTimersByTime(50);
    expect(fn).not.toHaveBeenCalled();

    debouncedFn('b');
    vi.advanceTimersByTime(50);
    expect(fn).not.toHaveBeenCalled();

    debouncedFn('c');
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith('c');
  });

  it('should invoke fn immediately if maxWaitMs elapses during a burst', () => {
    const fn = vi.fn();
    const debouncedFn = debounce(fn, 100, { maxWaitMs: 200 });

    debouncedFn('call1');
    expect(fn).not.toHaveBeenCalled();

    // Advance to 50ms (within both waitMs and maxWaitMs)
    vi.advanceTimersByTime(50);
    expect(fn).not.toHaveBeenCalled();

    // Call again at t=50 (resets trailing timer, doesn't reset firstCallTime)
    debouncedFn('call2');

    // Advance another 150ms → total 200ms elapsed since burst start (t=0)
    // This triggers maxWaitMs enforcement even though waitMs timeout hasn't fired
    vi.advanceTimersByTime(150);
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith('call2');
  });

  it('should reset the maxWait window after fn fires', () => {
    const fn = vi.fn();
    const debouncedFn = debounce(fn, 100, { maxWaitMs: 200 });

    // First burst: advance 100ms to fire the trailing timeout
    debouncedFn('call1');
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('call1');

    // Second burst starts fresh, firstCallTime is reset
    debouncedFn('call2');
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(1); // Still only 1

    // Call again at t=150 (relative to burst 2 start at t=100)
    // Total elapsed in burst 2: 50ms, still < maxWaitMs (200ms)
    debouncedFn('call3');
    vi.advanceTimersByTime(100);
    // Now 150ms elapsed in burst 2, still < maxWaitMs but trailing timeout fires
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith('call3');
  });

  it('should handle continuous calls within maxWaitMs (scroll starvation fix)', () => {
    const fn = vi.fn();
    const debouncedFn = debounce(fn, 100, { maxWaitMs: 200 });

    // Simulate rapid calls every 50ms: t=0, 50, 100, 150, 200
    debouncedFn('scroll1');
    vi.advanceTimersByTime(50);
    debouncedFn('scroll2');
    vi.advanceTimersByTime(50);
    debouncedFn('scroll3');
    vi.advanceTimersByTime(50);
    debouncedFn('scroll4');
    vi.advanceTimersByTime(50);
    debouncedFn('scroll5');

    // At t=200, maxWaitMs (200ms from t=0) should have forced invocation
    // The last args ('scroll5') passed at t=200 should be the ones fired
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith('scroll5');
  });

  it('should not invoke fn with maxWaitMs if calls stop before it elapses', () => {
    const fn = vi.fn();
    const debouncedFn = debounce(fn, 100, { maxWaitMs: 300 });

    debouncedFn('call1');
    vi.advanceTimersByTime(50);
    debouncedFn('call2');
    vi.advanceTimersByTime(50);
    debouncedFn('call3');

    // 100ms elapsed, still within maxWaitMs (300ms)
    // But only 100ms elapsed since last call, so trailing timeout hasn't fired
    expect(fn).not.toHaveBeenCalled();

    // Advance another 100ms (total 200ms since last call)
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith('call3');
  });

  it('should work without maxWaitMs (backward compatibility)', () => {
    const fn = vi.fn();
    const debouncedFn = debounce(fn, 100);

    debouncedFn('a');
    debouncedFn('b');
    debouncedFn('c');

    // No maxWaitMs, so fn only fires after 100ms of inactivity
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith('c');
  });
});
