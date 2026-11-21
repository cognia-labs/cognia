import type { ConcurrencyController } from "@cognia/plugin-contract/lib/workflow/runtime/concurrency-controller"
export type { ConcurrencyController } from "@cognia/plugin-contract/lib/workflow/runtime/concurrency-controller"

export function createConcurrencyController(initial: number): ConcurrencyController {
  if (!Number.isInteger(initial)) {
    throw new Error(`createConcurrencyController: initial must be an integer, got ${initial}`)
  }
  if (initial < 0) {
    throw new Error(`createConcurrencyController: initial must be non-negative, got ${initial}`)
  }
  let current = initial
  let gateHolds = 0
  const listeners = new Set<(n: number) => void>()
  const effective = () => (gateHolds > 0 ? 0 : current)
  const notify = (value: number) => {
    for (const fn of listeners) {
      try {
        fn(value)
      } catch (err) {
        console.warn("ConcurrencyController listener threw:", err)
      }
    }
  }
  return {
    get: effective,
    reduceTo: (n: number) => {
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`reduceTo: n must be a non-negative integer, got ${n}`)
      }
      if (n >= current) return
      const prev = effective()
      current = n
      const next = effective()
      if (next !== prev) notify(next)
    },
    holdGate: () => {
      const prev = effective()
      gateHolds += 1
      if (prev !== 0) notify(0)
      let released = false
      return () => {
        if (released) return
        released = true
        gateHolds = Math.max(0, gateHolds - 1)
        if (gateHolds === 0 && current > 0) notify(current)
      }
    },
    isHeld: () => gateHolds > 0,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
  }
}
