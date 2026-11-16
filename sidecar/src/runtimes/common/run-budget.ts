/**
 * The Host's ADR-0243 ledger hold for one turn, as the built-in rails apply
 * it: every model request is capped at what is left, and the turn stops once
 * the hold is spent or its deadline passes.
 */
export interface RunBudgetBounds {
  tokens?: number
  deadlineAt?: number
}

export interface StepUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  inputTokens?: number
  outputTokens?: number
}

export class RunBudgetSpentError extends Error {
  constructor(reason: "budget_exhausted" | "deadline_exceeded") {
    super(
      reason === "budget_exhausted"
        ? "This run's budget is used up."
        : "This run's deadline has passed."
    )
    this.name = "RunBudgetSpentError"
  }
}

export interface RunBudgetGuard {
  /**
   * Count one model request's billed tokens. Frames sharing a `requestId`
   * repeat that request's usage, so the latest one replaces the earlier.
   */
  observe(usage: StepUsage, requestId?: string): void
  /** Throws once nothing is left; otherwise the output cap for the next request. */
  nextOutputCap(configured: number | undefined): number | undefined
  /** True once the hold is spent or its deadline has passed. */
  spent(): boolean
}

export function createRunBudgetGuard(bounds: RunBudgetBounds): RunBudgetGuard {
  let used = 0
  const byRequest = new Map<string, number>()
  const left = () => (bounds.tokens === undefined ? Infinity : bounds.tokens - used)
  const spent = () =>
    left() <= 0 || (bounds.deadlineAt !== undefined && Date.now() >= bounds.deadlineAt)
  return {
    observe(usage, requestId) {
      const tokens =
        (usage.input_tokens ?? usage.inputTokens ?? 0) +
        (usage.output_tokens ?? usage.outputTokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0)
      if (requestId === undefined) return void (used += tokens)
      used += tokens - (byRequest.get(requestId) ?? 0)
      byRequest.set(requestId, tokens)
    },
    nextOutputCap(configured) {
      if (left() <= 0) throw new RunBudgetSpentError("budget_exhausted")
      if (bounds.deadlineAt !== undefined && Date.now() >= bounds.deadlineAt)
        throw new RunBudgetSpentError("deadline_exceeded")
      const cap = Math.min(configured ?? Infinity, Math.floor(left()))
      return Number.isFinite(cap) ? Math.max(1, cap) : configured
    },
    spent,
  }
}

/** Refuse the next model step of a multi-step loop once the hold is spent. */
export function withRunBudgetStep<O extends { prepareStep?: (step: never) => unknown }>(
  guard: RunBudgetGuard | undefined,
  options: O
): O {
  if (!guard) return options
  const prepare = options.prepareStep as ((step: unknown) => unknown) | undefined
  return {
    ...options,
    prepareStep: async (step: unknown) => {
      guard.nextOutputCap(undefined)
      return prepare?.(step)
    },
  } as O
}
