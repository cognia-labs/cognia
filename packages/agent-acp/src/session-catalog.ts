import type { AgentSessionCatalog } from "@cognia/agent-contracts/runtime-policy"

/** Kimi acknowledges deletion before its background index has removed the row. */
export function createKimiSessionCatalog(now: () => number = Date.now): AgentSessionCatalog {
  const deleted = new Map<string, { cwd?: string; expiresAt: number }>()
  return {
    deleted(sessionId, cwd) {
      deleted.set(sessionId, { cwd, expiresAt: now() + 120_000 })
      if (deleted.size > 256) deleted.delete(deleted.keys().next().value!)
    },
    listed(sessions, options) {
      const listedIds = new Set(sessions.map((session) => session.sessionId))
      for (const [id, marker] of deleted) {
        if (
          marker.expiresAt <= now() ||
          ((!options?.cwd || options.cwd === marker.cwd) && !listedIds.has(id))
        )
          deleted.delete(id)
      }
      return sessions.filter((session) => !deleted.has(session.sessionId))
    },
    clear: () => deleted.clear(),
  }
}
