import {
  recordedRunMetadata,
  authorityFromPermissionCeiling,
  requestersFromRunOrigin,
  runTriggerFromOrigin,
} from "@/lib/execution/acting-authority"
/**
 * The app's binding of the durable Agent Team coordinator (ADR-0217).
 *
 * The coordinator itself lives in `@cognia/agent-orchestration/coordinator`.
 * This module supplies the app's ports: run state in Dexie, the execution-run
 * journal, `@cognia/redact`, the app's path semantics and the managed fleet
 * session projection. It also maps an `AgentTeam` onto the coordinator's
 * team spec and holds the shared coordinator every app caller uses.
 */

import { hasNoLeakingPii, redactText } from "@cognia/redact"
import Dexie from "dexie"
import { getLiveSidecarSessionIds } from "@/lib/claude/ipc"
import { getLiveExternalAgentProcessIds } from "@/lib/ai/agent/external/agent-transport"
import {
  createDurableTeamCoordinator as createCoordinator,
  isStoredChildReplaySafe,
  type DurableTeamCoordinator as Coordinator,
  type DurableTeamSpec,
  type TeamPathPolicy,
  type TeamRemoteSessions,
  type TeamRunJournal,
} from "@cognia/agent-orchestration/coordinator"
import type { TeamRunStore } from "@cognia/agent-orchestration/store"
import { dexieTeamRunStore, getAgentTeamRun } from "@/lib/db/agent-team-runtime"
import { createExecutionRun, getExecutionRun, runEventJournal } from "@/lib/db/execution-runs"
import { agentTeamExecutionRunId } from "@/lib/execution/agent-team-bridge"
import { isPathWithinRoot, normalizeFsPath } from "@/lib/files/permissions"
import { isTauri } from "@/lib/tauri"
import type { AgentTeam, TeammateRuntime } from "@/types/agent/agent-team"
import type {
  AgentTeamCheckpoint,
  AgentTeamChildRun,
  AgentTeamExecutionConstraints,
  AgentTeamTrajectoryEvent,
} from "@/types/agent/agent-team-runtime"

export type {
  DurableChildControl,
  RecoveryOutcome,
  RegisterDurableChildInput,
  WorkspaceLeaseRequest,
} from "@cognia/agent-orchestration/coordinator"

/**
 * The execution-run journal as the coordinator's run journal. The row is
 * addressed the way `agent-team-bridge` addresses it, never by the bare run
 * id: both this path and `startSquadRun` create a row for the same run, and
 * the bridge's contract is that the ids converge because both derive from
 * `agentTeamExecutionRunId`, so whichever path runs first wins and the second
 * is a no-op. Keying this one on the bare id made `team:<runId>` and
 * `team:<teamId>` two journal sources, so the cockpit listed the same run
 * twice, the second copy with no session, its coordination tab "unavailable".
 */
export const executionRunTeamJournal: TeamRunJournal = {
  async runPrepared({ runId, projectId, title, at }) {
    const executionRunId = agentTeamExecutionRunId(runId)
    const executionRun = await getExecutionRun(executionRunId)
    if (!executionRun) {
      const constraints = (await getAgentTeamRun(runId).catch(() => undefined))
        ?.executionConstraints
      await createExecutionRun({
        id: executionRunId,
        ...recordedRunMetadata(runTriggerFromOrigin(constraints?.triggeredFrom), {
          runId: executionRunId,
          authority: authorityFromPermissionCeiling(constraints?.permissionCeiling),
          requesters: requestersFromRunOrigin(constraints?.triggeredFrom),
        }),
        kind: "team",
        sourceId: runId,
        ...(projectId ? { projectId } : {}),
        title,
        status: "queued",
        currentRevision: 0,
        startedAt: at,
        updatedAt: at,
      })
      await runEventJournal.append(executionRunId, {
        id: `execution-event:${runId}:started`,
        ts: at,
        type: "run.started",
        visibility: "summary",
        payload: { summary: "Agent team run started" },
      })
    } else if (["waiting", "paused", "recovery_required"].includes(executionRun.status)) {
      await runEventJournal.append(executionRunId, {
        id: `execution-event:${runId}:resumed:${at}`,
        ts: at,
        type: "run.resumed",
        visibility: "summary",
        payload: { summary: "Agent team run resumed" },
      })
    }
  },
}

/** Redacted text, or `undefined` when it still leaks after redaction. */
export function redactTeamTextForPersistence(text: string): string | undefined {
  const redacted = redactText(text).redacted
  return hasNoLeakingPii(redacted) ? redacted : undefined
}

export const appTeamPathPolicy: TeamPathPolicy = {
  normalize: normalizeFsPath,
  isWithinRoot: isPathWithinRoot,
  async canonicalize(path) {
    // Browser-only runs have no Host filesystem. On desktop, resolve aliases
    // on disk without requiring a Git checkout or allocating a port block.
    if (!isTauri()) return normalizeFsPath(path)
    const { approvalAwareTransport } = await import("@/lib/task-workspace/user-action")
    return approvalAwareTransport.call<string>("task_workspace_canonical_root", { path })
  },
}

export const fleetTeamRemoteSessions: TeamRemoteSessions = {
  async release(remoteSessionId) {
    const { removeManagedFleetSession } = await import("@/lib/fleet/managed-session-projection")
    // The child is already terminated in the store; a projection that could
    // not be removed now is not a reason to report the termination as failed.
    await removeManagedFleetSession(remoteSessionId).catch(() => false)
  },
}

/** The coordinator's view of an app team. */
export function durableTeamSpec(team: AgentTeam): DurableTeamSpec {
  const { config } = team
  return {
    id: team.id,
    leadId: team.leadId,
    ...(team.projectId ? { projectId: team.projectId } : {}),
    objective: team.task,
    ...(config.repositories ? { repositories: config.repositories } : {}),
    ...(config.workingDir ? { workingDir: config.workingDir } : {}),
    ...(config.writeMode ? { writeMode: config.writeMode } : {}),
    ...(config.resourcePolicy ? { resourcePolicy: config.resourcePolicy } : {}),
    ...(config.maxConcurrentTeammates !== undefined
      ? { maxConcurrentTeammates: config.maxConcurrentTeammates }
      : {}),
    ...(config.environmentRef ? { environmentVersionId: config.environmentRef.versionId } : {}),
    ...(config.userConstraints ? { userConstraints: config.userConstraints } : {}),
  }
}

export interface DurableTeamCoordinatorOptions {
  /** Where run state lives; the app's Dexie store by default. */
  store?: TeamRunStore<AgentTeamExecutionConstraints>
  now?: () => number
  globalConcurrency?: number
  agingIntervalMs?: number
}

// Explicitly name the executor owner. New/plugin runtimes have no stop proof
// until an authoritative registry is mapped here; never default to sidecar.
const LOCAL_EXECUTOR_REGISTRIES = {
  claude: "sidecar",
  "claude-agent-sdk": "sidecar",
  "ai-sdk": "sidecar",
  openclaude: "external",
  crush: "external",
  "continue-dev": "external",
  "rovo-dev": "external",
  codebuff: "external",
  auggie: "external",
  "autohand-code": "external",
  codebuddy: "external",
  "command-code": "external",
  kilocode: "external",
  "mistral-vibe": "external",
  "mimo-code": "external",
  "hermes-agent": "external",
  "oh-my-pi": "external",
  muse: "external",
  amp: "external",
  zcode: "external",
  codex: "external",
  "codex-acp": "external",
  "codex-app-server": "external",
  "claude-code": "external",
  "gemini-cli": "external",
  "antigravity-acp": "external",
  "cursor-cli": "external",
  "copilot-cli": "external",
  kiro: "external",
  "qwen-code": "external",
  "pi-rpc": "external",
  droid: "external",
  devin: "external",
  "minimax-code": "external",
  grok: "external",
  kimi: "external",
  cline: "external",
  qoder: "external",
  goose: "external",
  aider: "external",
  "opencode-acp": "external",
  "opencode-server": "external",
} as const satisfies Record<TeammateRuntime | "claude-agent-sdk" | "ai-sdk", "sidecar" | "external">

async function isLocalExecutorStopped(
  runtime: string,
  sessionId?: string,
  executorRegistry?: AgentTeamChildRun["executorRegistry"]
): Promise<boolean | undefined> {
  if (!Object.hasOwn(LOCAL_EXECUTOR_REGISTRIES, runtime)) return undefined
  if (
    executorRegistry !== undefined &&
    executorRegistry !== "sidecar" &&
    executorRegistry !== "external-process"
  )
    return undefined
  const defaultRegistry =
    LOCAL_EXECUTOR_REGISTRIES[runtime as keyof typeof LOCAL_EXECUTOR_REGISTRIES]
  if (
    executorRegistry === "external-process" ||
    (!executorRegistry && defaultRegistry === "external")
  ) {
    const processes = await getLiveExternalAgentProcessIds()
    // ACP/Codex native session ids are not Rust process ids. Without a
    // process-to-session binding, only a wholly quiescent owning registry is proof.
    // Legacy preset names can also name network executors: their absence
    // from the process table is not stop evidence without an owner binding.
    if (processes === undefined) return undefined
    if (processes.size > 0) return false
    return executorRegistry === "external-process" ? true : undefined
  }
  const sessions = await getLiveSidecarSessionIds()
  // Old rows do not identify which Host actually ran their executor.
  if (!executorRegistry) return undefined
  return sessions === undefined
    ? undefined
    : sessionId
      ? !sessions.has(sessionId)
      : sessions.size === 0
}

export function createDurableTeamCoordinator(options: DurableTeamCoordinatorOptions = {}) {
  const coordinator = createCoordinator<AgentTeamExecutionConstraints>({
    store: options.store ?? dexieTeamRunStore,
    journal: executionRunTeamJournal,
    redactForPersistence: redactTeamTextForPersistence,
    paths: appTeamPathPolicy,
    remoteSessions: fleetTeamRemoteSessions,
    // Some recovery gates run inside a Dexie transaction. Keep it alive while
    // Rust answers; a reload must not turn an IPC wait into an auto-commit.
    localSessions: {
      isStopped: (runtime, sessionId, registry) =>
        Dexie.waitFor(isLocalExecutorStopped(runtime, sessionId, registry)),
    },
    ...(options.now ? { now: options.now } : {}),
    ...(options.globalConcurrency !== undefined
      ? { globalConcurrency: options.globalConcurrency }
      : {}),
    ...(options.agingIntervalMs !== undefined ? { agingIntervalMs: options.agingIntervalMs } : {}),
  })
  return {
    ...coordinator,
    /** Prepare a durable run of an app team (see `durableTeamSpec`). */
    prepareRun: (team: AgentTeam, runId?: string) =>
      coordinator.prepareRun(durableTeamSpec(team), runId),
  }
}

export type DurableTeamCoordinator = Omit<
  Coordinator<AgentTeamExecutionConstraints>,
  "prepareRun"
> & {
  prepareRun(team: AgentTeam, runId?: string): Promise<string>
}

let sharedCoordinator: DurableTeamCoordinator | undefined

export function getDurableTeamCoordinator(): DurableTeamCoordinator {
  sharedCoordinator ??= createDurableTeamCoordinator()
  return sharedCoordinator
}

export function __resetDurableTeamCoordinatorForTesting(): void {
  sharedCoordinator = undefined
}

/**
 * Whether a child may be replayed from its checkpoint, reading from `store`
 * (the shared coordinator's store by default, so every app caller sees the
 * run state the coordinator writes).
 */
export function isDurableChildReplaySafe(
  childRunId: string,
  checkpoint?: AgentTeamCheckpoint,
  trajectory?: readonly AgentTeamTrajectoryEvent[],
  store: TeamRunStore<AgentTeamExecutionConstraints> = getDurableTeamCoordinator().store
): Promise<boolean> {
  return isStoredChildReplaySafe(store, childRunId, checkpoint, trajectory)
}
