/** Only stable journal semantics cross the host boundary; raw ids stay in the reader. */
export interface LedgerRun {
  id: string
  kind: string
  status: string
  startedAt: number
  events: Array<{ type: string; seq: number; payload: Record<string, unknown> }>
}

export interface LedgerProjection {
  source: string
  kind: string
  status: string
  events: string[]
  toolCalls: Array<{ name: string; status: string }>
}

export function normalizeLedger(runs: readonly LedgerRun[]): LedgerProjection[] {
  return [...runs]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((run) => {
      const events = [...run.events].sort((a, b) => a.seq - b.seq)
      const tools = new Map<string, { name: string; status: string }>()
      for (const event of events) {
        if (!["tool.started", "tool.completed", "tool.failed"].includes(event.type)) continue
        const { toolCallId, toolName } = event.payload
        if (typeof toolCallId !== "string" || typeof toolName !== "string") {
          throw new Error(`Malformed ${event.type} event in execution run ${run.id}`)
        }
        tools.set(toolCallId, {
          name: toolName,
          status:
            event.type === "tool.started"
              ? "running"
              : event.type === "tool.completed"
                ? "completed"
                : "failed",
        })
      }
      const directChat =
        run.kind === "agent-turn" &&
        events.some((event) => event.type === "run.started" && event.payload.surface === "chat")
      return {
        source: directChat ? "direct-chat" : run.kind,
        kind: run.kind,
        // The journal's terminal vocabulary is `completed`; the harness uses `succeeded`.
        status: run.status === "completed" ? "succeeded" : run.status,
        events: events.map((event) => event.type),
        toolCalls: [...tools.values()],
      }
    })
}

export function ledgerDiff(
  expected: readonly LedgerProjection[],
  actual: readonly LedgerProjection[]
): string {
  const before = JSON.stringify(expected, null, 2)
  const after = JSON.stringify(actual, null, 2)
  if (before === after) return "Ledger projections agree"
  return `Ledger projection mismatch\n--- expected\n${before}\n+++ actual\n${after}`
}
