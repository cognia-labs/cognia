/**
 * How the durable coordinator controls a running teammate, one builder per
 * backend (ADR-0217). Each turns a backend's session handle into the
 * coordinator's `DurableChildControl` and is honest about what that backend's
 * stop actually reaches: a pause that ends the whole session is reported to
 * the checkpoint, never as a clean pause of a session that no longer exists.
 */

import type { DurableChildControl } from "@cognia/agent-orchestration/coordinator"

/** What a control needs from the durable dispatch of its child. */
export interface ChildControlDispatch {
  /** Forget a provider session that ended under the child. */
  releaseSession(sessionId: string): Promise<void>
  /** Checkpoint the paused child; `false` when it is not safe to replay. */
  checkpointPause(): Promise<boolean>
  recordRemoteDisposal?(proof: import("@cognia/agent-orchestration").StopProof): Promise<void>
}

/** The external-agent manager surface a control drives. */
export interface ExternalSessionControls {
  steerSession(agentId: string, sessionId: string, text: string): Promise<void>
  cancel(agentId: string, sessionId: string): Promise<void>
  cancelRetiresSession(agentId: string, sessionId: string): boolean
}

/**
 * An external agent's session. Pause interrupts the turn through `cancel`;
 * where that cancel retires the whole session (a process-scoped cancel, a
 * released gateway task) the session is released and the pause answers to
 * the checkpoint, so the child is parked as paused only when replay is safe.
 */
export function externalSessionControl(
  manager: ExternalSessionControls,
  agentId: string,
  sessionId: string,
  dispatch: ChildControlDispatch
): DurableChildControl {
  return {
    steer: (message) => manager.steerSession(agentId, sessionId, message),
    pause: async () => {
      const retires = manager.cancelRetiresSession(agentId, sessionId)
      await manager.cancel(agentId, sessionId)
      if (!retires) return undefined
      await dispatch.releaseSession(sessionId)
      return dispatch.checkpointPause()
    },
    terminate: () => manager.cancel(agentId, sessionId),
  }
}

/** The sidecar session surface (`lib/ai/agent/execution/sidecar-client`). */
export interface SidecarSessionControls {
  steerSession(sessionId: string, message: string, sourceMessageId?: string): Promise<unknown>
  interruptSession(sessionId: string): Promise<void>
  closeSession(sessionId: string): Promise<void>
}

/**
 * A built-in engine session in the sidecar. Its interrupt ends the turn and
 * keeps the session. Termination closes it to reap background processes.
 */
export function sidecarSessionControl(
  ipc: SidecarSessionControls,
  sessionId: string
): DurableChildControl {
  return {
    steer: async (message, sourceMessageId) => {
      await ipc.steerSession(sessionId, message, sourceMessageId)
    },
    pause: () => ipc.interruptSession(sessionId),
    terminate: () => ipc.closeSession(sessionId),
  }
}

/** The control a remote worker hands back for its running turn. */
export interface RemoteTurnControls {
  steer(message: string, commandId: string): Promise<void>
  pause(
    commandId: string
  ): Promise<import("../workers/remote-worker-runtime").RemoteWorkerPauseResult>
  terminate(commandId: string): Promise<void | import("@cognia/agent-orchestration").StopProof>
}

/**
 * A turn on a remote worker. Pausing ends the remote turn, so the pause
 * answers to the checkpoint; commands carry ids derived from the dispatch
 * lease so a replayed command is recognised.
 */
export function remoteTurnControl(
  control: RemoteTurnControls,
  leaseId: string,
  dispatch: Pick<ChildControlDispatch, "checkpointPause" | "recordRemoteDisposal">
): DurableChildControl {
  return {
    steer: (message, sourceMessageId) => control.steer(message, sourceMessageId),
    pause: async () => {
      try {
        const stopped = await control.pause(`${leaseId}:pause`)
        if (!stopped) return false
        if (typeof stopped === "object" && "proof" in stopped) {
          // The stop is proven; the turn's event tail is not, so no checkpoint.
          await dispatch.recordRemoteDisposal?.(stopped.proof)
          return false
        }
        if (typeof stopped === "object") await dispatch.recordRemoteDisposal?.(stopped)
        return await dispatch.checkpointPause()
      } catch {
        return false
      }
    },
    terminate: () => control.terminate(`${leaseId}:terminate`),
  }
}
