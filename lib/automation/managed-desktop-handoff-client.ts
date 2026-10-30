/** Human-started acceptance and its metadata-only handoff preparation (ADR-0233 A6). */
import {
  callManagedDesktop as callHost,
  watchHostTopic,
  type ManagedDesktopQuote,
  type ManagedDesktopTarget,
} from "./managed-desktop-client"
import type {
  ManagedDesktopAcceptanceOutcome,
  ManagedDesktopAcceptanceResult,
  ManagedDesktopEvidenceArtifact,
} from "./managed-desktop-results-client"

export type ManagedDesktopHandoffMode = "commit" | "bundle"

async function callManagedDesktop<T>(
  target: ManagedDesktopTarget,
  name: string,
  args: Record<string, unknown>
): Promise<T> {
  if (target.kind === "remote" && !target.hostId.trim())
    throw new Error("managed_desktop_host_required")
  return callHost<T>(target, name, args)
}

/** Unsupported transfer/automation modes remain dormant at the contract boundary. */
export const MANAGED_DESKTOP_HANDOFF_CAPABILITIES = {
  productionExecution: true,
  livePreview: false,
  crossHost: false,
  projectAutomaticAcceptance: false,
} as const

export interface ManagedDesktopAcceptanceCriterion {
  description: string
  screenshotRequired: boolean
}

/** Host uses UTF-8 byte limits, rather than JavaScript string length. */
export function validManagedDesktopCriteria(
  value: unknown
): value is ManagedDesktopAcceptanceCriterion[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 50 &&
    value.every(
      (row) =>
        row &&
        typeof row === "object" &&
        typeof row.description === "string" &&
        row.description.trim().length > 0 &&
        new TextEncoder().encode(row.description).length <= 1024 &&
        typeof row.screenshotRequired === "boolean"
    )
  )
}

export const ACCEPTANCE_CHANGED_TOPIC = "managed-desktop://acceptance-changed"
export interface ManagedDesktopAcceptanceRun {
  acceptanceId: string
  providerConfigId: string
  deliveryId: string
  commit: string
  mode: ManagedDesktopHandoffMode
  state: "provisioning" | "awaitingSession" | "running" | "completed" | "cancelled" | "failed"
  desktopId: string | null
  desktopGeneration: number | null
  deadlineAt: number | null
  delegationId: string | null
  /** Whether the one-time child session attach happened. The key itself never leaves the Host. */
  childAttached: boolean
  source: { sessionId: string; taskId: string | null; parentRunId: string | null }
  errorCode: string | null
  createdAt: number
  updatedAt: number
  endedAt: number | null
}

export type ManagedDesktopAcceptanceStart = ManagedDesktopHandoffRequest & {
  quoteId: string
  idempotencyKey: string
}
export interface ManagedDesktopAcceptanceCheckpoint {
  acceptanceId: string
  sessionKey: string
  criterionId: string
  idempotencyKey: string
}
export interface ManagedDesktopAcceptanceComplete {
  acceptanceId: string
  sessionKey: string
  idempotencyKey: string
  outcome: ManagedDesktopAcceptanceOutcome
  criteria: Array<{
    criterionId: string
    outcome: "passed" | "failed" | "incomplete"
    artifactIds: string[]
  }>
  summary: string
}

export interface ManagedDesktopDeliverySummary {
  id: string
  revision: number
  commit: string
  branch: string
  modes: ManagedDesktopHandoffMode[]
  createdAt: number
}

export interface ManagedDesktopHandoffRequest {
  deliveryId: string
  deliveryRevision: number
  mode: ManagedDesktopHandoffMode
  providerConfigId: string
  lifetimeSeconds: number
  criteria: ManagedDesktopAcceptanceCriterion[]
  /** Explicit repository-relative files only; Host validates and hashes their contents. */
  acceptanceFiles: string[]
  /** Executed at the repository root by the qualified executor, never a shell string. */
  argv: string[]
}

export interface ManagedDesktopHandoffProposal {
  id: string
  deliveryId: string
  deliveryRevision: number
  mode: ManagedDesktopHandoffMode
  commit: string
  quote: ManagedDesktopQuote
  expiresAt: number
  /**
   * The Host's effective acceptance switch for this configuration. Start also
   * requires an unexpired quote and explicit human cost confirmation.
   */
  executionEnabled: boolean
  /** Why execution is off; `null` once the acceptance switch is effective. */
  dormantReason: "managed_desktop_handoff_requires_results_qualification" | null
}

function handoffArgs(request: ManagedDesktopHandoffRequest) {
  return {
    deliveryId: request.deliveryId,
    deliveryRevision: request.deliveryRevision,
    mode: request.mode,
    providerConfigId: request.providerConfigId,
    lifetimeSeconds: request.lifetimeSeconds,
    criteria: request.criteria.map(({ description, screenshotRequired }) => ({
      description,
      screenshotRequired,
    })),
    acceptanceFiles: request.acceptanceFiles,
    argv: request.argv,
  }
}

export const managedDesktopHandoffClient = {
  deliveries: (target: ManagedDesktopTarget) =>
    callManagedDesktop<ManagedDesktopDeliverySummary[]>(
      target,
      "managed_desktop_handoff_deliveries",
      {}
    ),
  prepare: (target: ManagedDesktopTarget, request: ManagedDesktopHandoffRequest) =>
    callManagedDesktop<ManagedDesktopHandoffProposal>(
      target,
      "managed_desktop_handoff_prepare",
      handoffArgs(request)
    ),
  acceptanceStart: (target: ManagedDesktopTarget, request: ManagedDesktopAcceptanceStart) =>
    callManagedDesktop<ManagedDesktopAcceptanceRun>(target, "managed_desktop_acceptance_start", {
      ...handoffArgs(request),
      quoteId: request.quoteId,
      idempotencyKey: request.idempotencyKey,
    }),
  acceptanceAttach: (target: ManagedDesktopTarget, acceptanceId: string, sessionKey: string) =>
    callManagedDesktop<ManagedDesktopAcceptanceRun>(target, "managed_desktop_acceptance_attach", {
      acceptanceId,
      sessionKey,
    }),
  acceptanceStatus: (target: ManagedDesktopTarget, acceptanceId: string) =>
    callManagedDesktop<ManagedDesktopAcceptanceRun>(target, "managed_desktop_acceptance_status", {
      acceptanceId,
    }),
  acceptanceList: (target: ManagedDesktopTarget) =>
    callManagedDesktop<{ runs: ManagedDesktopAcceptanceRun[] }>(
      target,
      "managed_desktop_acceptance_list",
      {}
    ),
  acceptanceCancel: (target: ManagedDesktopTarget, acceptanceId: string) =>
    callManagedDesktop<ManagedDesktopAcceptanceRun>(target, "managed_desktop_acceptance_cancel", {
      acceptanceId,
    }),
  // No target parameter: child evidence tools cannot be forwarded to another Host.
  acceptanceCheckpoint: (request: ManagedDesktopAcceptanceCheckpoint) =>
    callManagedDesktop<ManagedDesktopEvidenceArtifact>(
      { kind: "local" },
      "managed_desktop_acceptance_checkpoint",
      {
        acceptanceId: request.acceptanceId,
        sessionKey: request.sessionKey,
        criterionId: request.criterionId,
        idempotencyKey: request.idempotencyKey,
      }
    ),
  acceptanceComplete: (request: ManagedDesktopAcceptanceComplete) =>
    callManagedDesktop<ManagedDesktopAcceptanceResult>(
      { kind: "local" },
      "managed_desktop_acceptance_complete",
      {
        acceptanceId: request.acceptanceId,
        sessionKey: request.sessionKey,
        idempotencyKey: request.idempotencyKey,
        outcome: request.outcome,
        criteria: request.criteria.map(({ criterionId, outcome, artifactIds }) => ({
          criterionId,
          outcome,
          artifactIds,
        })),
        summary: request.summary,
      }
    ),
}

export function watchManagedDesktopAcceptance(
  target: ManagedDesktopTarget,
  onRuns: (runs: ManagedDesktopAcceptanceRun[]) => void,
  onError: (error: unknown) => void = () => {}
): () => void {
  return watchHostTopic(
    target,
    ACCEPTANCE_CHANGED_TOPIC,
    async () => (await managedDesktopHandoffClient.acceptanceList(target)).runs,
    onRuns,
    onError
  )
}

/** Suppress paths, provider responses, credentials and arbitrary backend text. */
export function managedDesktopHandoffErrorKey(error: unknown): string {
  const value =
    typeof error === "string" ? error : error instanceof Error ? error.message : undefined
  switch (value) {
    case "managed_desktop_handoff_source_unavailable":
    case "managed_desktop_handoff_source_changed":
    case "managed_desktop_handoff_provenance_required":
      return "sourceUnavailable"
    case "managed_desktop_authentication_required":
    case "managed_desktop_session_invalidated":
      return "identityChanged"
    default:
      return "prepareFailed"
  }
}
