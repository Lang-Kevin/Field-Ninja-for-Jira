/**
 * dom-observer.ts
 *
 * Single shared MutationObserver for the whole extension, plus the
 * `markOwnMutation` self-write suppression window that prevents the
 * extension's own DOM writes (made via visibility-engine.ts) from being
 * re-observed as "real" mutations and causing a feedback loop.
 */

export interface DebounceOptions {
  maxWaitMs?: number;
}

/**
 * Trailing-edge debounce with optional `maxWaitMs` cap to prevent starvation
 * under sustained mutation pressure (e.g., scrolling). Without maxWaitMs,
 * rapid calls only invoke fn after inactivity; with it, fn fires at least
 * once per maxWaitMs window even if calls keep coming.
 */
export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  waitMs: number,
  options?: DebounceOptions
): (...args: Args) => void {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let firstCallTime: number | undefined;
  const maxWaitMs = options?.maxWaitMs;

  return (...args: Args): void => {
    const now = Date.now();
    const isFirstCall = firstCallTime === undefined;

    if (isFirstCall) {
      firstCallTime = now;
    }

    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }

    // If maxWaitMs elapsed since burst start, invoke immediately.
    if (maxWaitMs !== undefined && now - (firstCallTime as number) >= maxWaitMs) {
      firstCallTime = undefined;
      fn(...args);
      return;
    }

    // Otherwise schedule trailing-edge timeout.
    timeoutId = setTimeout(() => {
      timeoutId = undefined;
      firstCallTime = undefined;
      fn(...args);
    }, waitMs);
  };
}

export interface ObserveRootOptions {
  debounceMs?: number;
  maxWaitMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 200;

/** Module-level suppression flag — see markOwnMutation for the microtask ordering rationale. */
let suppressed = false;

/** Module-level singleton observer instance — enforces the single-shared-observer rule. */
let activeObserver: MutationObserver | undefined;

/**
 * Wraps a synchronous DOM-writing function so the shared observer ignores
 * the mutations it causes. Suppression is a window, not a permanent switch:
 * it re-arms itself via a queued microtask rather than resetting
 * synchronously.
 *
 * The MutationObserver's own notification microtask is queued synchronously
 * by the browser the moment a mutation happens inside fn() above — i.e.
 * BEFORE the queueMicrotask call below runs. Microtasks execute strictly in
 * FIFO queue order, so the observer's callback is guaranteed to run (and
 * see suppressed === true) before this cleanup microtask flips it back to
 * false. Do NOT reset `suppressed` synchronously here — that would race the
 * observer callback and let the extension's own writes leak through as
 * "real" mutations.
 */
export function markOwnMutation<T>(fn: () => T): T {
  suppressed = true;
  try {
    return fn();
  } finally {
    queueMicrotask(() => {
      suppressed = false;
    });
  }
}

/**
 * Creates (or recreates) the single shared MutationObserver watching `root`.
 * Any previously active observer is disconnected first, so there is never
 * more than one live observer in the extension. Returns a disconnect
 * function for the caller to tear down observation.
 */
export function observeRoot(
  root: Node,
  onMutation: (records: MutationRecord[]) => void,
  options?: ObserveRootOptions
): () => void {
  if (activeObserver) {
    activeObserver.disconnect();
    activeObserver = undefined;
  }

  const debouncedOnMutation = debounce(
    onMutation,
    options?.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    { maxWaitMs: options?.maxWaitMs ?? options?.debounceMs ?? DEFAULT_DEBOUNCE_MS }
  );

  const observer = new MutationObserver((records) => {
    if (suppressed) {
      return;
    }
    debouncedOnMutation(records);
  });

  activeObserver = observer;

  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class'],
  });

  return () => {
    observer.disconnect();
    if (activeObserver === observer) {
      activeObserver = undefined;
    }
  };
}
