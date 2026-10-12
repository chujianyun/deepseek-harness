import { describe, expect, it } from 'vitest'
import { changeStream } from '../src/index.ts'

/** A service's listener set and state, as the services that watch keep them. */
function service() {
  const listeners = new Set<() => void>()
  let state = 0
  return {
    listeners,
    read: async () => state,
    set: (next: number) => { state = next; for (const listener of listeners) listener() },
  }
}

describe('changeStream', () => {
  it('yields the current state, then the state again after each change', async () => {
    const s = service()
    const stop = new AbortController()
    const stream = changeStream(s.listeners, s.read, stop.signal)
    expect(await stream.next()).toEqual({ done: false, value: 0 })
    const next = stream.next()
    s.set(1)
    expect(await next).toEqual({ done: false, value: 1 })
    stop.abort()
    expect(await stream.next()).toEqual({ done: true, value: undefined })
    expect(s.listeners.size).toBe(0)
  })

  it('folds changes that arrive while a state is consumed into one more read', async () => {
    const s = service()
    const stream = changeStream(s.listeners, s.read, new AbortController().signal)
    await stream.next()
    s.set(1)
    s.set(2)
    expect(await stream.next()).toEqual({ done: false, value: 2 })
    await stream.return(undefined)
    expect(s.listeners.size).toBe(0)
  })

  it('ends when any signal aborts, also while waiting, and reads a synchronous state', async () => {
    const listeners = new Set<() => void>()
    const caller = new AbortController()
    const lifetime = new AbortController()
    const stream = changeStream(listeners, () => 'ready', caller.signal, lifetime.signal)
    expect(await stream.next()).toEqual({ done: false, value: 'ready' })
    const waiting = stream.next()
    lifetime.abort()
    expect(await waiting).toEqual({ done: true, value: undefined })
    expect(listeners.size).toBe(0)
    const ended = new AbortController()
    ended.abort()
    expect(await changeStream(listeners, () => 'never', ended.signal).next()).toEqual({ done: true, value: undefined })
  })
})
