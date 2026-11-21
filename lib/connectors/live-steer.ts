import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { LiveSteerHandler, LiveSteerResult } from "./bus"

export interface ActiveConnectorRun {
  conversationKey: string
  sessionId: string
  executionRunId: string
  provider: string
  injectionProtection?: boolean
  /**
   * Re-evaluate whether the active run may still accept live steering for
   * `event` before storing the inbound message onto `run.sessionId`. Used to
   * enforce mid-run policy tightening (`silent` / `draft` / `muted` / narrowed
   * authority / revoked computer-use / switched session or target).
   */
  canSteer?: (event: NormalizedInboundEvent) => Promise<boolean>
}

export interface ConnectorLiveSteerCoordinator {
  activate(run: ActiveConnectorRun): () => void
  handle: LiveSteerHandler
}

export interface ConnectorLiveSteerDependencies {
  admit(event: NormalizedInboundEvent): Promise<boolean>
  steer(sessionId: string, event: NormalizedInboundEvent): Promise<{ accepted: true }>
  storeInbound(event: NormalizedInboundEvent, sessionId: string): Promise<unknown>
  currentInjectionProtection?(adapterId: string): Promise<boolean>
  canSteer?(run: ActiveConnectorRun, event: NormalizedInboundEvent): Promise<boolean>
}

const activeConversationControllers = new Map<string, Set<AbortController>>()

/**
 * Register a live connector capture `AbortController` under its conversation
 * key so mode tightening (`Silent`, `Draft`, `Muted`, human assignment) can
 * halt an in-flight auto-reply immediately regardless of entry surface.
 */
export function registerConversationRunController(
  conversationKey: string,
  controller: AbortController
): () => void {
  let set = activeConversationControllers.get(conversationKey)
  if (!set) {
    set = new Set()
    activeConversationControllers.set(conversationKey, set)
  }
  set.add(controller)
  return () => {
    const current = activeConversationControllers.get(conversationKey)
    if (!current) return
    current.delete(controller)
    if (current.size === 0) activeConversationControllers.delete(conversationKey)
  }
}

export function abortConversationRunControllers(
  conversationKey: string,
  reason = "conversation_mode_tightened"
): number {
  const current = activeConversationControllers.get(conversationKey)
  if (!current || current.size === 0) return 0
  let aborted = 0
  for (const controller of Array.from(current)) {
    if (!controller.signal.aborted) {
      controller.abort(reason)
      aborted += 1
    }
  }
  return aborted
}

export function __resetConversationRunControllersForTesting(): void {
  activeConversationControllers.clear()
}

/**
 * Coordinate live input with the durable connector lane. An inbound message is
 * stored with its real sender before the sidecar acknowledgement can complete;
 * any missing acknowledgement returns `accepted:false`, so the existing job is
 * replayed at the FIFO safe boundary.
 */
export function createConnectorLiveSteerCoordinator(
  deps: ConnectorLiveSteerDependencies
): ConnectorLiveSteerCoordinator {
  const active = new Map<string, ActiveConnectorRun>()

  const handle = async (event: NormalizedInboundEvent): Promise<LiveSteerResult> => {
    const run = active.get(event.conversationKey)
    if (!run) return { activeRun: false, accepted: false }
    const unavailable: LiveSteerResult = {
      activeRun: true,
      accepted: false,
      executionRunId: run.executionRunId,
    }
    if (run.provider !== "anthropic") return unavailable

    try {
      const current = (await deps.currentInjectionProtection?.(event.adapterId)) ?? true
      if (current !== (run.injectionProtection !== false)) return unavailable
      if (run.canSteer && !(await run.canSteer(event))) return unavailable
      if (deps.canSteer && !(await deps.canSteer(run, event))) return unavailable
      await deps.storeInbound(event, run.sessionId)
      if (!(await deps.admit(event))) return unavailable
      const result = await deps.steer(run.sessionId, event)
      return result.accepted
        ? { activeRun: true, accepted: true, executionRunId: run.executionRunId }
        : unavailable
    } catch {
      return unavailable
    }
  }

  return {
    handle,
    activate(run) {
      active.set(run.conversationKey, run)
      return () => {
        if (active.get(run.conversationKey) === run) active.delete(run.conversationKey)
      }
    },
  }
}
