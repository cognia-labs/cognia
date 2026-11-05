/**
 * The online-evaluation drain as a module runtime on the renderer hosts
 * (ADR-0250 §14 M2). It drains the queue the `eval-online` log transport
 * fills when a production trace finishes, so enqueued work gets scored and
 * settles into a terminal state the retention sweep can prune; without it the
 * queue only grows.
 *
 * Self-gating: with no enabled policy (the default, and the state whenever the
 * Eval Lab flag is down) the scheduler refreshes an empty cache and drains
 * nothing. The manifest says why the brain has no adapter.
 */

export async function start(): Promise<() => void> {
  const { startOnlineEvalScheduler } = await import("@/lib/ai/eval/online/scheduler")
  return startOnlineEvalScheduler()
}
