/**
 * The one builder of `startSquadRun`'s input (ADR-0252 §5).
 *
 * Every caller that starts a Squad run describes where the request came from
 * as a surface, and this module turns it into the launch input. What follows
 * from the surface is decided here once:
 *
 *   - `origin`: the gate policy (`interactive` blocks on a person, anything
 *     else is headless) and the word the run's journal records.
 *   - `triggeredFrom`: who receives the run's progress and who the requesters
 *     are (`requestersFromRunOrigin`).
 *   - The person's authority (`LOCAL_PERSON_RUN`): only a gesture a person
 *     made on this device carries it. Automation, a plugin, a schedule and a
 *     run another run launched never do.
 *   - The conversation: a full session when the caller holds one, the id
 *     alone when it only knows which thread the run belongs to.
 *
 * Callers add only what is theirs to decide (the run id they key retries on,
 * an ultracode override, a goal).
 */

import type { ChatSession } from "@cognia/agent-config-types"
import type { KnowledgeReadingAccess } from "@cognia/plugin-contract/lib/knowledge-base/runtime/progressive-reading"

import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
import type { AgentPermissionCeiling } from "@/types/agent/permission-ceiling"
import type { AgentTeamExecutionConstraints } from "@/types/agent/agent-team-runtime"
import type { WorkflowTriggeredFrom } from "@/types/workflow/visual"
import type { SquadPlanApprovalDelegate, StartSquadRunInput } from "./start-squad-run"

/** An IM conversation a run fans its progress back to. */
export interface SquadImConversation {
  adapterId: string
  conversationKey: string
  sessionId?: string
}

/** Where a Squad run was asked for. */
export type SquadStartSurface =
  /**
   * A conversation's turn or its `/squad` command. `person` is true only when
   * a person sent it from this device; an automated turn is not a gesture.
   */
  | {
      kind: "chat"
      person: boolean
      session?: ChatSession
      /** The conversation's id, when the caller could not load the session itself. */
      sessionId?: string
      /** The persona the conversation is bound to, when it enters as one. */
      characterId?: string
    }
  /** A person's Start in a console on this device: the board, the inspector, ⌘K. */
  | { kind: "console" }
  /** A person's Start on a paired device, which the Host runs on its behalf. */
  | { kind: "companion"; deviceId?: string }
  /**
   * An IM conversation: a connector's routing, or an issue started from one.
   * A session binds the run to the conversation so its card projects there.
   */
  | {
      kind: "im"
      triggeredFrom: WorkflowTriggeredFrom
      session?: ChatSession
      characterId?: string
      permissionCeiling?: AgentPermissionCeiling
      requirePlanApprovalFloor?: boolean
      planApprovalDelegate?: SquadPlanApprovalDelegate
    }
  /** A Bot's step. Its policy narrows the run and may raise the plan gate. */
  | {
      kind: "bot"
      triggeredFrom: WorkflowTriggeredFrom
      permissionCeiling: AgentPermissionCeiling
      requirePlanApprovalFloor?: boolean
      characterId?: string
      planApprovalDelegate?: SquadPlanApprovalDelegate
    }
  /** A scheduled task, or an issue's wakeup. */
  | { kind: "scheduler" }
  /** An issue started from the tracker by a person. */
  | { kind: "issue" }
  /**
   * A workflow node. The workflow run is the Squad run's parent. When the
   * workflow came from an IM conversation the run is headless and reports
   * back there.
   */
  | {
      kind: "workflow"
      workflowRunId: string
      conversation?: SquadImConversation
      knowledgeAccess?: KnowledgeReadingAccess
      /** How many team-completion fan-outs led to this workflow. */
      triggerChainDepth?: number
    }
  /** A plugin's `ctx.teams.start`. */
  | { kind: "plugin" }
  /** The CLI bridge (`agent_team_run`). */
  | { kind: "remote" }
  /** An evaluation case. */
  | { kind: "evaluation" }
  /**
   * A replacement of a settled or stuck run (`retry`, a recovery decision).
   * It keeps the replaced run's authority when the caller froze it.
   */
  | {
      kind: "retry"
      /** The run it replaces, `execution:team:<id>` or the durable id. */
      replacesRunId: string
      sessionId?: string
      executionConstraints?: AgentTeamExecutionConstraints
    }
  /**
   * A child run another run launched (`launchChildRun`'s `squad` target). The
   * parent's acting identity is the run's; `origin` is the gate policy the
   * launching surface asked for.
   */
  | {
      kind: "child"
      origin: string
      launchedByRunId?: string
      sessionId?: string
    }

export interface SquadStartRequest {
  squadId: string
  surface: SquadStartSurface
  /** Seeded as the Squad's objective; blank keeps the one it has. */
  goal?: string
  /** A pre-minted run id. Doubles as the idempotency key. */
  runId?: string
  /** Manual "run with ultracode". Omitted lets the Squad decide. */
  ultracode?: boolean
}

/** A conversation the caller knows only by id. */
function sessionStub(sessionId: string | undefined): { session?: ChatSession } {
  return sessionId ? { session: { id: sessionId } as ChatSession } : {}
}

function surfaceInput(
  surface: SquadStartSurface
): Omit<StartSquadRunInput, "squadId" | "goal" | "runId" | "ultracode"> {
  switch (surface.kind) {
    case "chat":
      return {
        ...(surface.person ? { localAuthorization: LOCAL_PERSON_RUN } : {}),
        origin: "chat",
        triggeredFrom: {
          source: "chat",
          ...((surface.session?.id ?? surface.sessionId)
            ? { sessionId: surface.session?.id ?? surface.sessionId }
            : {}),
        },
        ...(surface.session ? { session: surface.session } : {}),
        ...(surface.characterId ? { characterId: surface.characterId } : {}),
      }
    case "console":
      return {
        localAuthorization: LOCAL_PERSON_RUN,
        origin: "interactive",
        triggeredFrom: { source: "ui" },
      }
    case "companion":
      // The paired console has the same durable review channel as the
      // desktop: `companion` would mean unattended and fail a plan review.
      return {
        localAuthorization: LOCAL_PERSON_RUN,
        origin: "interactive",
        triggeredFrom: {
          source: "api",
          ...(surface.deviceId ? { deviceId: surface.deviceId } : {}),
        },
      }
    case "im":
      return {
        origin: "im",
        triggeredFrom: surface.triggeredFrom,
        ...(surface.session ? { session: surface.session, bindConnectorRun: true } : {}),
        ...(surface.characterId ? { characterId: surface.characterId } : {}),
        ...(surface.permissionCeiling ? { permissionCeiling: surface.permissionCeiling } : {}),
        ...(surface.requirePlanApprovalFloor ? { requirePlanApprovalFloor: true } : {}),
        ...(surface.planApprovalDelegate
          ? { planApprovalDelegate: surface.planApprovalDelegate }
          : {}),
      }
    case "bot":
      return {
        origin: "bot",
        triggeredFrom: surface.triggeredFrom,
        permissionCeiling: surface.permissionCeiling,
        ...(surface.requirePlanApprovalFloor ? { requirePlanApprovalFloor: true } : {}),
        ...(surface.characterId ? { characterId: surface.characterId } : {}),
        ...(surface.planApprovalDelegate
          ? { planApprovalDelegate: surface.planApprovalDelegate }
          : {}),
      }
    case "scheduler":
      return { origin: "scheduler", triggeredFrom: { source: "schedule" } }
    case "issue":
      return { origin: "interactive", triggeredFrom: { source: "ui" } }
    case "workflow": {
      const conversation = surface.conversation
      return {
        // An IM-started workflow has nobody watching a modal; a workflow run
        // from the editor or the library keeps the blocking gates.
        origin: conversation ? "im" : "interactive",
        triggeredFrom: conversation
          ? {
              source: "im",
              adapterId: conversation.adapterId,
              conversationKey: conversation.conversationKey,
              ...(conversation.sessionId ? { sessionId: conversation.sessionId } : {}),
            }
          : { source: "ui" },
        launchedByRunId: `execution:workflow:${surface.workflowRunId}`,
        ...(surface.knowledgeAccess ? { knowledgeAccess: surface.knowledgeAccess } : {}),
        ...(surface.triggerChainDepth ? { triggerChainDepth: surface.triggerChainDepth } : {}),
      }
    }
    case "plugin":
      return { origin: "api", triggeredFrom: { source: "api" } }
    case "remote":
      return { origin: "remote", triggeredFrom: { source: "api" } }
    case "evaluation":
      return { origin: "evaluation", triggeredFrom: { source: "api" } }
    case "retry":
      return {
        origin: "interactive",
        triggeredFrom: { source: "ui" },
        parentRunId: surface.replacesRunId,
        ...(surface.executionConstraints
          ? { executionConstraints: surface.executionConstraints }
          : {}),
        ...sessionStub(surface.sessionId),
      }
    case "child":
      return {
        origin: surface.origin,
        // Another run asked for it: the acting identity is the parent's.
        triggeredFrom: { source: "api" },
        ...(surface.launchedByRunId ? { launchedByRunId: surface.launchedByRunId } : {}),
        ...sessionStub(surface.sessionId),
      }
  }
}

/** `startSquadRun`'s input for one request from one surface. */
export function buildSquadStartInput(request: SquadStartRequest): StartSquadRunInput {
  return {
    squadId: request.squadId,
    goal: request.goal ?? "",
    ...(request.runId ? { runId: request.runId } : {}),
    ...(request.ultracode !== undefined ? { ultracode: request.ultracode } : {}),
    ...surfaceInput(request.surface),
  }
}
