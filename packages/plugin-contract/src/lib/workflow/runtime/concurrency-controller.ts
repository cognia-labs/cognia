/**
 * The plugin contract's share of `lib/workflow/runtime/concurrency-controller.ts`, which re-exports these.
 */
/**
 * Dynamic concurrency limit for the workflow orchestrator's ready-set scheduler.
 *
 * Orchestrator reads `get()` each scheduling tick to decide how many tasks may
 * be in flight. Producers (BudgetGuard onCritical: reduce_concurrency, the team
 * synthesizer when opening an HITL gate) call `reduceTo(n)` to lower the cap.
 *
 * The cap is monotone non-increasing — production callers cannot raise it back
 * up. This avoids a race where a budget-triggered downshift gets immediately
 * undone by another producer.
 */

export interface ConcurrencyController {
  get(): number
  /** Lower the cap to `n`. No-op when `n >= current`. */
  reduceTo(n: number): void
  /**
   * Temporarily freeze scheduling (`get() === 0`) while an HITL gate is open.
   * Releasing the last active hold restores the monotone `current` cap
   * (preserving any permanent `reduceTo` downshift) and wakes subscribers.
   */
  holdGate?(): () => void
  /** True while at least one active `holdGate()` freeze is open. */
  isHeld?(): boolean
  /** Fire `fn(newValue)` on each effective concurrency change. Returns unsubscribe. */
  subscribe(fn: (n: number) => void): () => void
}
