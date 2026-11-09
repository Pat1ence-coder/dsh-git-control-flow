/** Node 18-compatible linked cancellation with an explicit, disposable deadline. */
export function cancellation({ signal, timeoutMs, timeoutReason } = {}) {
  if (timeoutMs != null && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)) {
    throw new Error('timeoutMs must be a positive bounded integer');
  }
  const controller = new AbortController();
  const deadline = timeoutMs == null ? null : Date.now() + timeoutMs;
  const expire = () => controller.abort(timeoutReason ?? new DOMException('Operation timed out', 'TimeoutError'));
  const forward = () => controller.abort(signal.reason ?? new DOMException('Operation cancelled', 'AbortError'));
  if (signal?.aborted) forward();
  else signal?.addEventListener('abort', forward, { once: true });
  const timer = timeoutMs == null ? null : setTimeout(expire, timeoutMs);
  return {
    signal: controller.signal,
    abort: (reason) => controller.abort(reason),
    check() {
      // Synchronous provider probes can delay the timer callback. Check elapsed
      // time at boundaries too, before accepting approval or spawning Git.
      if (deadline !== null && Date.now() >= deadline) expire();
      throwIfAborted(controller.signal);
    },
    dispose() {
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener('abort', forward);
    },
  };
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Operation cancelled', 'AbortError');
}

/** Bound an await even when an external service does not honor its signal. */
export function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Operation cancelled', 'AbortError'));
    const cleanup = () => signal?.removeEventListener('abort', abort);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}
