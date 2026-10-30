/**
 * Row types for the local code-adoption tracker (Phase 1).
 *
 * Legacy fields mirror the Rust `CodeAdoptionTurn` / `FileAttribution` DTOs
 * (`crates/cognia-git/src/code_adoption/mod.rs`); optional capture provenance
 * binds the TypeScript projection to its immutable Host/root/run. Persisted to the
 * `codeAdoptionTurns` Dexie table (v108). Metrics + hunk line ranges only —
 * never the diff body — so the row is safe and is intentionally kept out of
 * mobile sync.
 */

import type {
  ChangeKind,
  ContributionOrigin,
  TaskWorkspaceOrigin,
} from "@/lib/task-workspace/types"

/** Durable provenance of one physical root in a captured chat turn. */
export interface CodeAdoptionRun {
  runId: string
  workspaceRoot: string
  executionRoot?: string
  origin?: TaskWorkspaceOrigin
}

/** One attributed file: metrics + hunk ranges, no code. */
export interface CodeAdoptionFile {
  /** Repo-relative path, forward slashes. */
  path: string
  added: number
  removed: number
  /** `true` when the file was created during the turn. */
  isNew: boolean
  /** Inclusive `[startLine, endLine]` ranges on the new side, one per hunk. */
  hunks: Array<[number, number]>
  /** Retained even when two roots changed the same relative path. */
  taskWorkspaceRunId?: string
  workspaceRoot?: string
  origin?: ContributionOrigin
  kind?: ChangeKind
  /** False for resources whose textual line counts were not captured. */
  statsKnown?: boolean
  /** Accepted subset, populated only by the authoritative Task Workspace ledger. */
  acceptedAdded?: number
  acceptedRemoved?: number
  adoptionState?: CodeAdoptionState
}

export type CodeAdoptionMeasurement = "taskWorkspace" | "legacyFingerprint" | "unavailable"
export type CodeAdoptionTrackingState = "tracked" | "truncated" | "unavailable"
export type CodeAdoptionState =
  | "pending"
  | "accepted"
  | "partiallyAccepted"
  | "rejected"
  | "reverted"
  | "unavailable"
  | "notApplicable"

/** One turn's write-attribution record. */
export interface CodeAdoptionTurnRow {
  /** Dexie primary key: `turnRecordId(sessionId, runId)`, unique across page loads. */
  id: string
  runId: number
  sessionId: string
  /** Durable Task Workspace run correlated with this chat turn, when present. */
  taskWorkspaceRunId?: string
  /** Every physical root captured by this turn, primary first. */
  taskWorkspaceRuns?: CodeAdoptionRun[]
  bundleTurnId?: string
  /** The primary run's owning execution Host, never the current selection. */
  origin?: TaskWorkspaceOrigin
  /** The complete source patch scope, including explicit user contributions. */
  capturedFiles?: CodeAdoptionFile[]
  /**
   * The assistant message that closed this turn, stamped at settle. The chat
   * renders the turn's change card under it. TS-only: the Rust DTO never
   * carries it.
   */
  assistantMessageId?: string
  /** Canonicalized workspace root (resolved cwd). */
  workspaceRoot: string
  /** Runtime attribution, for example `"in-app"` or `"external"`. */
  agentKind: string
  model: string | null
  /** Epoch milliseconds at reconcile time. */
  ts: number
  totalFiles: number
  totalAdded: number
  totalRemoved: number
  files: CodeAdoptionFile[]
  /** `true` when the per-turn file cap clamped the record. */
  truncated: boolean
  /** Optional for rows written before authoritative adoption tracking shipped. */
  measurement?: CodeAdoptionMeasurement
  trackingState?: CodeAdoptionTrackingState
  trackingReason?: string
  adoptionState?: CodeAdoptionState
  adoptionReason?: string
  proposedFiles?: number
  proposedAdded?: number
  proposedRemoved?: number
  acceptedFiles?: number
  acceptedAdded?: number
  acceptedRemoved?: number
}
