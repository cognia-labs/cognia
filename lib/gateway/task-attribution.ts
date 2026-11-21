/**
 * Which conversation a Cognia gateway task works for, so the gateway's
 * per-request usage rows can carry that conversation's workspace.
 *
 * An external agent on a Cognia model spends through a task-private route
 * ticket. The gateway books each request under the ticket's session id, which
 * names the task and nothing else, so a workspace's spending limit never saw
 * that money (F02). The external-agent manager registers each task's
 * conversation when it mints the lease, and the outcome forwarder reads it
 * back here.
 *
 * In memory on purpose: an outcome arrives while its task is live or shortly
 * after it ends. The entry outlives the task by a grace window so the last
 * request's outcome, delivered after the turn settled, still finds it.
 */

/** How long a released task stays attributable. */
export const GATEWAY_TASK_ATTRIBUTION_GRACE_MS = 10 * 60_000

/** Tasks kept at once; the oldest goes first. */
export const GATEWAY_TASK_ATTRIBUTION_LIMIT = 1024

interface Attribution {
  chatSessionId: string
  timer?: ReturnType<typeof setTimeout>
}

const tasks = new Map<string, Attribution>()

/**
 * The task a gateway outcome's session id names. A desktop ticket's session is
 * the task id itself; a Host or remote lease scopes it as
 * `["host-task", origin, task]` or `["remote-task", tenant, device, task]`.
 */
export function gatewayTaskIdOfSession(sessionId: string | null | undefined): string | undefined {
  if (!sessionId) return undefined
  if (!sessionId.startsWith("[")) return sessionId
  try {
    const scope: unknown = JSON.parse(sessionId)
    if (!Array.isArray(scope) || !scope.every((part) => typeof part === "string")) return undefined
    if (scope[0] === "host-task" && scope.length === 3) return scope[2] || undefined
    if (scope[0] === "remote-task" && scope.length === 4) return scope[3] || undefined
  } catch {
    // Not a lease scope; nothing this module registered.
  }
  return undefined
}

/**
 * Attribute a gateway task to the conversation it runs for. Returns the
 * release, which keeps the entry for {@link GATEWAY_TASK_ATTRIBUTION_GRACE_MS}
 * before dropping it.
 */
export function registerGatewayTaskAttribution(
  taskId: string,
  attribution: { chatSessionId: string }
): () => void {
  const previous = tasks.get(taskId)
  if (previous?.timer) clearTimeout(previous.timer)
  tasks.delete(taskId)
  const entry: Attribution = { chatSessionId: attribution.chatSessionId }
  tasks.set(taskId, entry)
  while (tasks.size > GATEWAY_TASK_ATTRIBUTION_LIMIT) {
    const oldest = tasks.keys().next().value as string
    const evicted = tasks.get(oldest)
    if (evicted?.timer) clearTimeout(evicted.timer)
    tasks.delete(oldest)
  }
  return () => {
    if (tasks.get(taskId) !== entry || entry.timer) return
    entry.timer = setTimeout(() => {
      if (tasks.get(taskId) === entry) tasks.delete(taskId)
    }, GATEWAY_TASK_ATTRIBUTION_GRACE_MS)
    // A grace timer must never keep a headless process alive.
    ;(entry.timer as { unref?: () => void }).unref?.()
  }
}

/** The conversation a gateway outcome's task runs for, if one registered it. */
export function gatewayTaskConversation(sessionId: string | null | undefined): string | undefined {
  const taskId = gatewayTaskIdOfSession(sessionId)
  return taskId ? tasks.get(taskId)?.chatSessionId : undefined
}

/**
 * The workspace a gateway outcome's spend belongs to: its task's conversation's
 * project, or `undefined` when the task is unknown, the conversation has none,
 * or it cannot be read.
 */
export async function gatewayTaskProjectId(
  sessionId: string | null | undefined
): Promise<string | undefined> {
  const chatSessionId = gatewayTaskConversation(sessionId)
  if (!chatSessionId) return undefined
  try {
    // Lazily, so the manager that registers tasks takes no Dexie edge from here.
    const { getSession } = await import("@/lib/db/sessions")
    return (await getSession(chatSessionId))?.projectId || undefined
  } catch {
    return undefined
  }
}

/** Test seam: forget every registered task. */
export function resetGatewayTaskAttributions(): void {
  for (const entry of tasks.values()) if (entry.timer) clearTimeout(entry.timer)
  tasks.clear()
}
