/**
 * Step memoization for any durable runtime, not just the visual workflow
 * orchestrator.
 *
 * The rule an Inngest-style durable handler depends on is small: a step that
 * already completed must never run twice, even when the process that ran it
 * died and the handler is re-entered from the top. That needs exactly two
 * things, a `(runId, stepId) -> output` map and a way to rebuild the map from
 * whatever durable log the runtime already writes.
 *
 * The second half is why this module takes the completions as an argument
 * instead of reading a table. The workflow orchestrator's log is
 * `workflowRunEvents`. A Bot run's log is `executionRunEvents`. Both can
 * project onto {@link DurableStepCompletion}, and neither has to know the
 * other exists.
 */

/**
 * One replayed step completion. `loopId` and `iterationIndex` are present only
 * for a step that ran inside a loop container: those hydrate under their
 * per-iteration key ONLY, because a child id that cache-hit at the top level
 * would skip every later iteration of the same body.
 */
export interface DurableStepCompletion extends StepRouting {
  stepId: string
  output: unknown
  loopId?: string
  iterationIndex?: number
  /**
   * The exact memo key the step ran under. A body step of a NESTED loop runs
   * under a key its runtime prefixes with the outer iteration, which the
   * `loopId` / `iterationIndex` pair alone cannot rebuild; when present this
   * key wins over both.
   */
  cacheKey?: string
}

/**
 * The routing a completed step chose, kept beside its output. A resumed run
 * replays a cached step instead of executing it, so without this the replay
 * would know what the step produced but not which way it sent the run — and
 * every branch the original run excluded would execute.
 */
export interface StepRouting {
  /** Branch/switch decision (handle ids or labels the step selected). */
  decision?: string | string[]
  /**
   * A handled failure that routed instead of producing a decision: `"error"`
   * follows only the error edges, `"halt"` follows no outgoing edge at all.
   */
  route?: "error" | "halt"
}

interface MemoEntry {
  output: unknown
  routing?: StepRouting
  /** Order in which the entry was recorded (hydration, then live completion). */
  order: number
}

function routingOf(routing: StepRouting | undefined): StepRouting | undefined {
  if (!routing) return undefined
  const out: StepRouting = {}
  if (routing.decision !== undefined) out.decision = routing.decision
  if (routing.route !== undefined) out.route = routing.route
  return out.decision !== undefined || out.route !== undefined ? out : undefined
}

/**
 * Cache key for a child step executed inside a loop-container iteration.
 * `(runId, stepId)` becomes `(runId, loopId, iterationIndex, stepId)` so a
 * resumed run replays only the iterations that never completed.
 */
export function iterationCacheKey(loopId: string, iterationIndex: number, stepId: string): string {
  return `${loopId}#${iterationIndex}#${stepId}`
}

export class StepMemoCache {
  private cache = new Map<string, MemoEntry>()
  private nextOrder = 0

  has(stepId: string): boolean {
    return this.cache.has(stepId)
  }

  get(stepId: string): unknown {
    return this.cache.get(stepId)?.output
  }

  /** The routing recorded with the step's output, if it chose one. */
  routing(stepId: string): StepRouting | undefined {
    return this.cache.get(stepId)?.routing
  }

  /**
   * Position of the step's completion among everything this cache recorded,
   * or `undefined` when it never completed. A resumed race join uses it to
   * tell which dependency won the original race.
   */
  completionOrder(stepId: string): number | undefined {
    return this.cache.get(stepId)?.order
  }

  /**
   * The key a step running under `key` is stored at in the ROOT cache. Plain
   * caches store keys as given; a view that namespaces keys (a nested loop's
   * per-iteration prefix) reports the full key, so the durable log can record
   * exactly where a completion belongs.
   */
  keyFor(key: string): string {
    return key
  }

  set(stepId: string, output: unknown, routing?: StepRouting): void {
    const kept = routingOf(routing)
    this.cache.set(stepId, { output, ...(kept ? { routing: kept } : {}), order: this.nextOrder++ })
  }

  clear(): void {
    this.cache.clear()
    this.nextOrder = 0
  }

  /**
   * Fill the cache from replayed completions, in log order. Returns `this` so
   * a caller can write `new StepMemoCache().hydrateFrom(...)` in one expression.
   *
   * Writes go through `set`, so a subclass that redirects storage (a prefixed
   * view, say) hydrates into the same place its reads come from.
   */
  hydrateFrom(completions: Iterable<DurableStepCompletion>): this {
    for (const completion of completions) {
      const routing = { decision: completion.decision, route: completion.route }
      if (typeof completion.cacheKey === "string" && completion.cacheKey.length > 0) {
        this.set(completion.cacheKey, completion.output, routing)
      } else if (
        typeof completion.loopId === "string" &&
        typeof completion.iterationIndex === "number"
      ) {
        this.set(
          iterationCacheKey(completion.loopId, completion.iterationIndex, completion.stepId),
          completion.output,
          routing
        )
      } else {
        this.set(completion.stepId, completion.output, routing)
      }
    }
    return this
  }
}
