import type { VisualWorkflow, WorkflowInterface, WorkflowNodeKind } from "./visual"
import type { WorkflowRetryMode } from "./visual"

export type WorkflowEnvironment = "production" | "staging" | "development" | (string & {})

export interface WorkflowDependencyManifest {
  nodeTypes: Array<{ kind: WorkflowNodeKind; typeVersion: number }>
  workflows: Array<{ workflowId: string; nodeId: string }>
  credentials: Array<{ key: string; refId: string; kind?: string }>
}

export interface WorkflowConfigDefinition {
  constants: Record<string, string>
  secretRefs: Array<{ key: string; refId: string; kind?: string }>
}

/** Immutable executable artifact created by every publish operation. */
export interface WorkflowVersion {
  id: string
  accountId: string
  workflowId: string
  sequence: number
  definition: VisualWorkflow
  interface: WorkflowInterface
  dependencyManifest: WorkflowDependencyManifest
  configDefinition: WorkflowConfigDefinition
  digest: string
  name: string
  description?: string
  /** Operator-authored immutable label for this publication. */
  versionName?: string
  /** Operator-authored immutable release notes for this publication. */
  releaseNotes?: string
  createdAt: number
  createdBy?: string
}

/** Atomic pointer selecting the version executed in one environment. */
export interface WorkflowDeployment {
  id: string
  accountId: string
  workflowId: string
  environment: WorkflowEnvironment
  versionId: string
  revision: number
  status: "active" | "disabled"
  createdAt: number
  updatedAt: number
  updatedBy?: string
}

export type WorkflowEntrypoint =
  | "http"
  | "mcp"
  | "portal"
  | "trigger"
  | "skill"
  | "agent-tool"
  | "subworkflow"
  | "desktop"
  | "cli"
  // A `workflow` scheduled task (app scheduler) — see
  // `lib/scheduler/executors/workflow-executor.ts`.
  | "schedule"
  // An installed Bot whose executor is a published workflow. Its own
  // entrypoint so run history can tell a Bot-driven run from a human one, and
  // so admission can scope a Bot differently from a person at a keyboard.
  | "bot"
  // An approved agent plan's `sub_workflow` step, admitting the exact version
  // the plan was approved against (ADR-0045).
  | "plan"

export interface WorkflowInvocation {
  id: string
  accountId: string
  entrypoint: WorkflowEntrypoint
  caller: string
  deploymentId: string
  deploymentRevision: number
  versionId: string
  idempotencyKey?: string
  runId?: string
  status: "admitted" | "running" | "completed" | "rejected"
  dependencyLock?: WorkflowDependencyLock
  retryOfRunId?: string
  retryMode?: WorkflowRetryMode
  startStepId?: string
  seedRunId?: string
  operatedBy?: string
  /**
   * Present when this Host admitted the invocation (auth, quota, idempotency,
   * release lock) but its Run Policy placed the run on another Host (ADR-0136
   * placement contract). No local run row exists; `runId` is the id the
   * target was asked to mint, and every read goes to the target.
   */
  placement?: WorkflowInvocationPlacement
  createdAt: number
  updatedAt: number
}

/** Where a placed invocation's run is, and what this Host last learned of it. */
export interface WorkflowInvocationPlacement {
  /** The Host the Run Policy selected (`openRemoteHostTarget` ref). */
  hostRef: string
  /** The durable host-dispatch job carrying the admission to that Host. */
  dispatchId: string
  /**
   * - `dispatching`: the job has not been accepted by the target yet.
   * - `accepted`: the target admitted the run (`remoteRunId`).
   * - `settled`: the run reached a terminal status; `terminal` holds its view.
   * - `refused`: the target refused, the job failed, or it was cancelled
   *   before it landed; `refusal` says why and no remote run exists.
   */
  state: "dispatching" | "accepted" | "settled" | "refused"
  /** The run id the target admitted; equals `runId` when it honoured the request. */
  remoteRunId?: string
  /** Last run status the target reported. */
  remoteStatus?: import("./visual").RunStatus
  /** When the target last answered for this run. */
  observedAt?: number
  /** Token and cost usage the target recorded, folded into the app's daily budget. */
  usage?: { tokens: number; costUsd: number; costKnown: boolean }
  /** Terminal run view, kept so a settled run reads without its Host. */
  terminal?: {
    status: import("./visual").RunStatus
    startedAt: number
    completedAt?: number
    output?: unknown
    error?: { message: string; nodeId?: string; code?: string }
  }
  refusal?: { code: string; message: string }
  /** Set when a caller cancelled before the target accepted; a late acceptance is cancelled there. */
  cancelRequestedAt?: number
}

export interface WorkflowDependencyBinding {
  workflowId: string
  versionId: string
  deploymentId: string
  deploymentRevision: number
  dependencyLock?: WorkflowDependencyLock
}

/** Versions resolved before a formal run is admitted. Keys are parent node ids. */
export interface WorkflowDependencyLock {
  workflows: Record<string, WorkflowDependencyBinding>
  indexes: Record<string, string>
  /** Exact production plugin artifacts selected during application publication. */
  plugins?: Record<string, WorkflowPluginDependencyBinding>
}

export interface WorkflowPluginDependencyBinding {
  pluginId: string
  version: string
  manifestDigest: string
  capabilities: string[]
  runtimeProfile: "headless"
}

export interface WorkflowExecutionBinding {
  invocationId?: string
  versionId: string
  deploymentId: string
  deploymentRevision: number
  entrypoint: WorkflowEntrypoint
  caller: string
  idempotencyKey?: string
  dependencyLock?: WorkflowDependencyLock
}
