/**
 * The stream behind a service's `watch()` method: the current state, then the state read again after
 * each change, until the caller's signal or the service's lifetime ends. Changes that arrive while a
 * state is being read or consumed fold into one more read, so a slow consumer never falls behind by
 * more than one state.
 * @module @deepseek-ai/dsh-change-stream
 */

/** Where a service keeps the callbacks it runs on every change. */
export interface ChangeListeners {
  add(listener: () => void): unknown
  delete(listener: () => void): unknown
}

/**
 * Stream a state, read again after every change.
 * @param listeners - the service's change callbacks; the stream adds one while it runs and removes it after.
 * @param read - reads the current state.
 * @param signals - the caller's signal and the service's lifetime; the stream ends when either aborts.
 * @returns the states.
 */
export async function* changeStream<T>(
  listeners: ChangeListeners, read: () => T | Promise<T>, ...signals: AbortSignal[]
): AsyncGenerator<T> {
  let dirty = true
  let wake: (() => void) | undefined
  const changed = (): void => { dirty = true; wake?.() }
  listeners.add(changed)
  for (const signal of signals) signal.addEventListener('abort', changed, { once: true })
  try {
    while (!signals.some(signal => signal.aborted)) {
      if (dirty) { dirty = false; yield await read(); continue }
      await new Promise<void>((resolve) => { wake = resolve })
    }
  } finally {
    listeners.delete(changed)
    for (const signal of signals) signal.removeEventListener('abort', changed)
  }
}
