import { randomUUID } from "node:crypto"
import { awaitPending } from "../../shared/pending.ts"
import type { PendingEntry } from "../../shared/pending.ts"
/** PostToolUse rewrite runs before the tool result reaches the model. */
export function createOutputReviewer(options: {
  pending: Map<string, PendingEntry<unknown>>
  sessionId: string
  emit(event: Record<string, unknown>): void
  isStopped(): boolean
  remoteExecutionContext?: unknown
}) {
  const { pending, sessionId, emit, isStopped } = options
  return async (
    toolName: string,
    toolUseId: string | undefined,
    current: unknown,
    isError: boolean
  ) => {
    if (isStopped()) return undefined
    const remoteExecutionContext = options.remoteExecutionContext
    const reviewId = randomUUID()
    const promise = awaitPending(pending, reviewId, {
      timeoutMs: 30_000,
      onTimeout: () => undefined,
    })
    emit({
      type: "tool_result_review",
      sessionId,
      reviewId,
      toolUseId: toolUseId ?? "",
      toolName: toolName ?? "",
      result: current,
      isError: isError === true,
      ...(remoteExecutionContext ? { remoteExecutionContext: remoteExecutionContext } : {}),
    })
    return promise
  }
}
