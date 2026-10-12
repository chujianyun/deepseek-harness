---
description: "Stream of a service's state for its watch method: the current state, then the state read again after each change."
kind: "package-library"
---

# @deepseek-ai/dsh-change-stream

English | [中文](README.zh.md)

## Summary

`dsh-change-stream` gives a service's `watch()` method its body. A service that keeps a set of change callbacks streams its state through `changeStream()`: the current state first, then the state read again after each change, until the caller's signal or the service's lifetime ends. The service still owns what its state is and when it changes.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### When to use it

Use `changeStream()` for a `@Remote({ mode: 'stream' })` method that pushes a whole state view after every change. A stream of individual events, where each one must arrive, needs a queue instead.

### Entry point

```ts
import { changeStream } from '@deepseek-ai/dsh-change-stream'

interface State { readonly count: number }

class Counter {
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()
  private state: State = { count: 0 }

  increment(): void {
    this.state = { count: this.state.count + 1 }
    for (const listener of this.listeners) listener()
  }

  // In a service, this method carries @Remote({ mode: 'stream' }).
  watch(signal: AbortSignal): AsyncIterable<State> {
    return changeStream(this.listeners, () => this.state, signal, this.lifetime.signal)
  }
}

export { Counter }
```

`listeners` is the service's set of change callbacks, which it runs on every change. See [`src/index.ts`](src/index.ts) for the exact TypeScript contract.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The stream adds one callback to the service's set while it runs and removes it when it ends. The callback only marks the state dirty and wakes the stream, so changes that arrive while a state is being read or consumed fold into one more read: a slow consumer never falls more than one state behind.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The stream and its listener and signal lifecycle |
| [`tests/change-stream.spec.ts`](tests/change-stream.spec.ts) | First state, re-read after a change, folding, ending on either signal, cleanup |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Utility package map](../README.md) — the other zero-dependency primitives shared across package groups.

-----

<a id="model-experience"></a>
## Model Experience

None, as this in-process helper registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Whole states only** — intermediate states between two reads are not delivered; a consumer that needs every change needs a queue of events instead.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
