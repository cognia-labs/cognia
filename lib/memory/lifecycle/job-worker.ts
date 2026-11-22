import type { AppSettings, ChatSession } from "@cognia/agent-config-types"
import { getSettings } from "@/lib/db/settings"
import { getSession } from "@/lib/db/sessions"
import { resolveCharacterById } from "@/lib/db/characters"
import { listMessages } from "@/lib/db/messages"
import { preparePersonalHistory } from "@/lib/execution/personal-visibility"
import {
  appendMemoryAuditEvent,
  claimNextMemoryJob,
  finishMemoryJob,
  createMemoryEvidence,
  failMemoryJob,
  isMemoryJobClaimActive,
  withMemoryJobWrite,
  MemoryJobWriteError,
  type MemoryJobWriteGuardOptions,
} from "@/lib/db/memory-governance"
import {
  getMemory,
  listMemories,
  listProjectClaimsNeedingRecheck,
  updateMemory,
} from "@/lib/db/memories"
import {
  memoryTranscriptProse,
  projectMiningMessageText,
} from "@/lib/memory/write/project-transcript-text"
import { withConsolidationTarget } from "@/lib/memory/write/guarded-consolidation-write"
import { resolveMemoryConfig, type MemoryConfig } from "@/types/memory/memory"
import type { MemoryEvidence, MemoryJob } from "@/types/memory/governance"
import { startMemoryJobHeartbeat } from "@/lib/memory/lifecycle/job-heartbeat"
import { recordMemoryJobOutcome } from "@/lib/memory/lifecycle/record-memory-outcome"
import { resolveJobTranscriptWindow } from "@/lib/memory/lifecycle/transcript-window"
import { detectMemoryExternalContext } from "@/lib/memory/control-plane/contamination"
import { parseAttachmentEvidenceSourceId } from "@cognia/memory/extract/project-attachment-evidence"
import { hasUntrustedMemoryContext } from "@/lib/memory/control-plane/policy"
import { classifySensitiveMemoryTopic } from "@cognia/memory/control-plane/sensitive-topics"
import { readProjectMemoryPolicy, resolveAgentMemoryPolicy } from "@/lib/memory/agent-policy"
import {
  consolidationAuditAction,
  consolidationOpMemoryId,
  type ConsolidationOp,
  type MemoryConsolidationNamespace,
} from "@/lib/memory/consolidate/consolidator"
import { hashContent } from "@/lib/project-knowledge/ingest/ingest-file"
import { hasNoLeakingPii } from "@cognia/redact"
import { MemoryExtractionError } from "@cognia/memory/extract/extractor"

export interface MemoryJobWorkerDeps {
  claimNext: (workerId: string) => Promise<MemoryJob | undefined>
  finish: (
    id: string,
    outcome: MemoryJobProcessOutcome,
    workerId: string,
    fencingEpoch?: number
  ) => Promise<unknown>
  fail: (id: string, code: string, workerId: string, fencingEpoch?: number) => Promise<unknown>
  process: (job: MemoryJob) => Promise<MemoryJobProcessOutcome>
  /** Keeps the lease alive while `process` runs. Returns its own stopper. */
  heartbeat?: (
    jobId: string,
    workerId: string,
    fencingEpoch: number | undefined,
    onLeaseLost: () => void
  ) => () => void
}

export interface MemoryJobProcessOutcome {
  status: "succeeded" | "no_output" | "skipped"
  resultCode: string
}

export interface DrainMemoryJobsOptions {
  workerId?: string
  maxJobs?: number
  /** Stop claiming new work; an already claimed job still finishes under its lease. */
  signal?: AbortSignal
}

export async function drainMemoryJobs(
  options: DrainMemoryJobsOptions = {},
  deps: MemoryJobWorkerDeps = defaultWorkerDeps
): Promise<number> {
  const workerId = options.workerId ?? "memory-job-worker"
  const maxJobs = options.maxJobs ?? 20
  let processed = 0
  while (processed < maxJobs && !options.signal?.aborted) {
    const job = await deps.claimNext(workerId)
    if (!job) break
    let lost = false
    const stopHeartbeat = deps.heartbeat?.(job.id, workerId, job.fencingEpoch, () => {
      lost = true
    })
    try {
      const outcome = await deps.process(job)
      // A lost lease is not an error. The extraction may already have written
      // memories, and the worker that stole the job will redo the work, which
      // the consolidator dedupes. What must NOT happen is overwriting the row
      // that the new owner (or the user's cancel) now controls — the epoch is
      // what keeps that guarantee when the same worker id reclaimed the row.
      if (!lost) await deps.finish(job.id, outcome, workerId, job.fencingEpoch)
    } catch (error) {
      const terminal = error instanceof MemoryExtractionError ? error.cause : error
      if (terminal instanceof MemoryJobTerminalError || terminal instanceof MemoryJobWriteError) {
        if (!lost)
          await deps.finish(
            job.id,
            { status: "skipped", resultCode: terminal.code },
            workerId,
            job.fencingEpoch
          )
        processed += 1
        continue
      }
      const code =
        error instanceof MemoryJobProcessingError || error instanceof MemoryExtractionError
          ? error.code
          : "memory_job_processing_failed"
      if (!lost) await deps.fail(job.id, code, workerId, job.fencingEpoch)
    } finally {
      stopHeartbeat?.()
    }
    processed += 1
  }
  return processed
}

/**
 * Serialises every drain in this process.
 *
 * The interval worker and the post-turn drain both call in, and a second
 * concurrent loop would only fight the first for the same rows. Cross-window
 * and cross-process races are already handled one level down, by the
 * `db.transaction("rw")` inside `claimNextMemoryJob`: a second claimer sees a
 * `running` row with a live lease and skips it. This lock is the cheap
 * in-process half, not the correctness boundary, so nothing here needs a Web
 * Lock on top.
 */
let inFlightDrain: Promise<number> | undefined

function withDrainLock(run: () => Promise<number>): Promise<number> {
  if (inFlightDrain) return inFlightDrain
  const started = run().finally(() => {
    inFlightDrain = undefined
  })
  inFlightDrain = started
  return started
}

/**
 * Run at most one job right after a turn, so a user does not wait up to the
 * full interval to see what the turn learned.
 *
 * Bounded at one because a backlog is the interval worker's problem. In a
 * backlog this may run an OLDER job than the turn's own, since claiming is FIFO
 * by `queuedAt`. That is correct, and it is still bounded.
 */
export async function drainMemoryJobsAfterTurn(
  options: DrainMemoryJobsOptions = {},
  deps: MemoryJobWorkerDeps = defaultWorkerDeps
): Promise<number> {
  return withDrainLock(() => drainMemoryJobs({ maxJobs: 1, ...options }, deps))
}

const activeWorkerTickers = new Set<() => void>()

/** Wake any running memory job worker immediately (e.g. after backfill confirm/resume). */
export function nudgeMemoryJobWorker(): void {
  for (const trigger of activeWorkerTickers) {
    trigger()
  }
}

/** Test hook: drop the in-process drain lock between cases. */
export function __resetMemoryDrainLock(): void {
  inFlightDrain = undefined
}

export interface StartMemoryJobWorkerOptions extends DrainMemoryJobsOptions {
  intervalMs?: number
  deps?: MemoryJobWorkerDeps
  /** Escape hatch for tests and for a host that must not touch stored rows. */
  repairNamespaces?: boolean
  /** Injected repair pass; defaults to `repairWorkspaceScopedMemories`. */
  repair?: () => Promise<unknown>
  /** Whether to autonomously advance active workspace history backfills. */
  driveBackfills?: boolean
  /** Injected backfill driver; defaults to `tickActiveWorkspaceBackfills`. */
  tickBackfills?: () => Promise<number>
}

export function startMemoryJobWorker(options: StartMemoryJobWorkerOptions = {}): () => void {
  const deps = options.deps ?? defaultWorkerDeps
  const shouldDriveBackfills =
    options.driveBackfills ?? (options.tickBackfills !== undefined || options.deps === undefined)
  const controller = new AbortController()
  const tick = () => {
    if (controller.signal.aborted || options.signal?.aborted) return
    void withDrainLock(async () => {
      let processed = await drainMemoryJobs({ ...options, signal: controller.signal }, deps)
      if (!shouldDriveBackfills || controller.signal.aborted || options.signal?.aborted) {
        return processed
      }
      const runBackfillStep = options.tickBackfills ?? defaultTickBackfills
      const enqueuedRuns = await runBackfillStep().catch(() => 0)
      if (enqueuedRuns > 0 && !controller.signal.aborted && !options.signal?.aborted) {
        const extra = await drainMemoryJobs({ ...options, signal: controller.signal }, deps)
        processed += extra
        if (extra > 0 && !controller.signal.aborted && !options.signal?.aborted) {
          await runBackfillStep().catch(() => 0)
        }
      }
      return processed
    }).catch(() => {
      // Storage errors may contain transcript text or paths. Log a stable,
      // content-free diagnostic and let the next interval retry the queue.
      console.warn("Memory job worker drain failed")
    })
  }
  activeWorkerTickers.add(tick)
  // Repair unreadable `workspace` rows once per start. It hangs off the worker
  // rather than off a renderer initializer because every host that can process
  // memory at all already starts this worker, and the repair is idempotent by
  // construction, so a no-op boot costs one indexed read.
  if (options.repairNamespaces !== false) {
    void (options.repair ?? defaultRepairNamespaces)().catch(() => undefined)
  }
  const stopClaims = () => controller.abort()
  options.signal?.addEventListener("abort", stopClaims, { once: true })
  tick()
  const timer = setInterval(tick, options.intervalMs ?? 30_000)
  return () => {
    activeWorkerTickers.delete(tick)
    controller.abort()
    clearInterval(timer)
    options.signal?.removeEventListener("abort", stopClaims)
  }
}

class MemoryJobProcessingError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

class MemoryJobTerminalError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

function effectiveConfig(settings: AppSettings): MemoryConfig {
  return resolveMemoryConfig(settings.memory)
}

/**
 * The stored timestamp `rowToUIMessage` stashes in metadata.
 *
 * Returns undefined rather than `Date.now()` when it is missing: this feeds a
 * project claim's `observedAt`, whose entire purpose is to keep "when the
 * evidence happened" separate from "when we learned it". Substituting now would
 * reintroduce exactly the lie the field exists to prevent.
 */
function messageCreatedAt(message: { metadata?: unknown }): number | undefined {
  const value = (message.metadata as { createdAt?: unknown } | undefined)?.createdAt
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function hashMessageSourceForJob(message: {
  role: string
  parts?: readonly unknown[]
  metadata?: unknown
}): string {
  const marks = (message.metadata as { personalMarks?: unknown } | undefined)?.personalMarks ?? null
  return hashContent(
    JSON.stringify([message.role, projectMiningMessageText(message.parts ?? []), marks])
  )
}

async function loadJobContext(job: MemoryJob): Promise<{
  settings: AppSettings
  session: ChatSession
  config: MemoryConfig
  transcript: Array<{
    id?: string
    role: string
    text: string
    /** Source timestamp — project claims derive `observedAt` from it. */
    createdAt?: number
    parts?: readonly unknown[]
  }>
  sourceHashes: ReadonlyMap<string, string>
  contaminationState: "clean" | "external-context"
  /** Set when the session advanced past the checkpoint but the window verified intact. */
  windowResultCode?: "revision_advanced_window_intact"
}> {
  if (!job.sessionId) throw new MemoryJobTerminalError("session_missing")
  const [settings, session, messages] = await Promise.all([
    getSettings(),
    getSession(job.sessionId),
    listMessages(job.sessionId),
  ])
  if (!settings || !session) throw new MemoryJobTerminalError("session_unavailable")
  // A durable checkpoint identifies content, not permission to learn it under
  // an old workspace after the session was moved. Never rebind queued work.
  if (job.projectId !== undefined && job.projectId !== session.projectId) {
    throw new MemoryJobTerminalError("project_changed")
  }
  if (job.characterId !== undefined && job.characterId !== session.characterId) {
    throw new MemoryJobTerminalError("character_changed")
  }
  const config = effectiveConfig(settings)
  const [character, project] = await Promise.all([
    session.characterId
      ? resolveCharacterById(session.characterId).catch(() => undefined)
      : Promise.resolve(undefined),
    session.projectId
      ? import("@/lib/db/schema")
          .then(({ getDb }) => getDb().projects.get(session.projectId!))
          .catch(() => undefined)
      : Promise.resolve(undefined),
  ])
  const fullTranscript = messages.map((message) => ({
    id: message.id,
    role: message.role,
    // Typed text only: context the composer attached is not something the user said.
    text: memoryTranscriptProse(message.parts ?? []),
    createdAt: messageCreatedAt(message),
    parts: message.parts,
  }))
  const window = resolveJobTranscriptWindow(job, fullTranscript, session.transcriptRevision)
  if (!window.ok) {
    // Terminal codes mean the window can never resolve again (its messages were
    // deleted, or the slice no longer describes the conversation it was mined
    // from). Burning the retry budget on those is pure waste.
    throw window.terminal
      ? new MemoryJobTerminalError(window.code)
      : new MemoryJobProcessingError(window.code)
  }
  // The job has no personal reader. Check its durable checkpoint against the
  // canonical text first, then withhold before extraction or vector indexing.
  const windowIds = new Set(window.transcript.map((message) => message.id))
  const windowMessages = messages.filter((message) => windowIds.has(message.id))
  const sourceHashes = new Map(
    windowMessages.map((message) => [message.id, hashMessageSourceForJob(message)])
  )
  const personalHistory = await preparePersonalHistory(undefined, windowMessages, { session })
  const withheld = new Set(personalHistory.withheldMessageIds)
  const transcript = window.transcript.filter((message) => !withheld.has(message.id ?? ""))
  const externalContext = detectMemoryExternalContext(transcript)
  const policy = resolveAgentMemoryPolicy({
    config,
    session,
    agentPolicy: character?.memoryPolicy,
    projectPolicy: readProjectMemoryPolicy(project),
    externalContext,
  })
  const allowedToLearn =
    job.kind === "turn-extraction" ? policy.canAutoLearn : policy.canLearnSession
  if (!allowedToLearn || !policy.writableScopes.includes(job.scope)) {
    await appendMemoryAuditEvent({
      action: "learn-denied",
      sessionId: job.sessionId,
      reason: policy.learnReason,
      metadata: { recoveredJob: true },
    })
    throw new MemoryJobTerminalError("learning_denied")
  }
  return {
    settings,
    session,
    config: { ...config, learnFromChats: policy.canLearnSession },
    transcript,
    sourceHashes,
    contaminationState: hasUntrustedMemoryContext(externalContext) ? "external-context" : "clean",
    windowResultCode: window.resultCode,
  }
}

function lastCompletedPair(
  transcript: Array<{ id?: string; role: string; text: string }>
):
  | { userText: string; assistantText: string; userMessageId?: string; assistantMessageId?: string }
  | undefined {
  let assistantIndex = -1
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (transcript[index]?.role === "assistant" && transcript[index]?.text.trim()) {
      assistantIndex = index
      break
    }
  }
  if (assistantIndex < 0) return undefined
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const message = transcript[index]
    if (message?.role === "user" && message.text.trim()) {
      return {
        userText: message.text,
        userMessageId: message.id,
        assistantText: transcript[assistantIndex]!.text,
        assistantMessageId: transcript[assistantIndex]!.id,
      }
    }
  }
  return undefined
}

/**
 * The turn identity a `turn-extraction` job was queued under.
 *
 * `enqueueTurnMemory` builds the key as `turn-extraction:<turnIdentity>`, so
 * stripping the prefix recovers the identity the inline path used to anchor its
 * evidence to. That anchoring is what keeps a memory's provenance timeline
 * pointing at the turn rather than at the job that happened to process it.
 */
function turnIdentityOf(job: MemoryJob): string {
  const prefix = "turn-extraction:"
  return job.dedupeKey?.startsWith(prefix) ? job.dedupeKey.slice(prefix.length) : `job:${job.id}`
}

/**
 * Compose the job's own result code with the transcript-window outcome, so a
 * recovered job that ran against a session whose revision had already advanced
 * is distinguishable in the console from one that replayed a pristine window.
 * `resultCode` is a free-form diagnostic string (`SAFE_IDENTIFIER` in the backup
 * sanitizer permits `:`), so the composed form round-trips through export.
 */
function withWindowOutcome(base: string, windowResultCode: string | undefined): string {
  return windowResultCode ? `${base}:${windowResultCode}` : base
}

async function processTurnExtraction(job: MemoryJob): Promise<MemoryJobProcessOutcome> {
  const context = await loadJobContext(job)
  const pair = lastCompletedPair(context.transcript)
  if (!pair) throw new MemoryJobProcessingError("turn_pair_unavailable")
  const { buildAutoExtractionDeps, runMemoryExtraction } =
    await import("@/lib/memory/write/run-memory-extraction")
  const recentMessages = context.transcript
    .slice(-10)
    .filter(
      (message) => context.contaminationState !== "external-context" || message.role === "user"
    )
  const sourceIds = [
    ...new Set([
      pair.userMessageId!,
      pair.assistantMessageId!,
      ...recentMessages.map((message) => message.id!),
    ]),
  ]
  const writeGuard: MemoryJobWriteGuardOptions = {
    expectedSourceHashes: context.sourceHashes,
    projectMessage: hashMessageSourceForJob,
    projectId: job.projectId ?? context.session.projectId,
    characterId: job.characterId ?? context.session.characterId,
  }
  const recordedMemoryIds = new Set<string>()
  const recordOperations = (operations: readonly ConsolidationOp[]) =>
    recordMemoryJobOutcome({
      job,
      operations,
      contaminationState: context.contaminationState,
      allowSensitiveTopics: context.config.allowSensitiveTopics,
      evidence: { kind: "message", sourceId: turnIdentityOf(job), sourceRole: "user" },
      auditReason: "automatic_learning",
      propagateErrors: true,
    })
  const deps = await buildAutoExtractionDeps(
    {
      session: context.session,
      appSettings: context.settings,
      withCanonicalWrite: (write) => withMemoryJobWrite(job, sourceIds, write, writeGuard),
      recordCanonicalOperation: async (operation) => {
        await recordOperations([operation])
        const id = consolidationOpMemoryId(operation)
        if (id) recordedMemoryIds.add(id)
      },
    },
    context.config
  )
  if (!deps) throw new MemoryJobProcessingError("dependencies_unavailable")
  const result = await runMemoryExtraction(
    {
      newPair: {
        userText: pair.userText,
        assistantText: context.contaminationState === "external-context" ? "" : pair.assistantText,
      },
      recentMessages,
      scope: job.scope,
      characterId: job.characterId,
      projectId: job.projectId,
      agentId: job.agentId,
      provenance: job.provenance,
      source: { sessionId: job.sessionId, messageId: pair.assistantMessageId },
      config: context.config,
    },
    deps
  )
  // Mutations already bound their evidence inside the canonical transaction.
  // NOOP corroboration (and compatibility deps without the callback) is fenced
  // here too, so cancellation cannot append a witness after source deletion.
  await withMemoryJobWrite(
    job,
    sourceIds,
    () =>
      recordOperations(
        result.applied.filter(
          (operation) => !recordedMemoryIds.has(consolidationOpMemoryId(operation) ?? "")
        )
      ),
    writeGuard
  )
  return result.applied.some((operation) => operation.op !== "NOOP")
    ? {
        status: "succeeded",
        resultCode: withWindowOutcome("memories_applied", context.windowResultCode),
      }
    : {
        status: "no_output",
        resultCode: withWindowOutcome("nothing_durable", context.windowResultCode),
      }
}

async function processSessionDistill(job: MemoryJob): Promise<MemoryJobProcessOutcome> {
  const context = await loadJobContext(job)
  const sourceIds = context.transcript
    .map((message) => message.id)
    .filter((id): id is string => Boolean(id))
  const writeGuard: MemoryJobWriteGuardOptions = {
    expectedSourceHashes: context.sourceHashes,
    projectMessage: hashMessageSourceForJob,
    projectId: job.projectId ?? context.session.projectId,
    characterId: job.characterId ?? context.session.characterId,
  }
  const { buildEpisodicMaintenanceDeps } =
    await import("@/lib/memory/lifecycle/build-maintenance-deps")
  const { runMemoryMaintenance } = await import("@/lib/memory/lifecycle/maintenance")
  const deps = await buildEpisodicMaintenanceDeps(
    {
      session: context.session,
      appSettings: context.settings,
      withCanonicalWrite: (write) => withMemoryJobWrite(job, sourceIds, write, writeGuard),
      contaminationState: context.contaminationState,
    },
    context.config
  )
  if (!deps) throw new MemoryJobProcessingError("dependencies_unavailable")
  await runMemoryMaintenance(
    {
      transcript: context.transcript.filter(
        (message) => context.contaminationState !== "external-context" || message.role === "user"
      ),
      scope: job.scope,
      characterId: job.characterId,
      projectId: job.projectId,
      agentId: job.agentId,
      provenance: job.provenance,
      contaminationState: context.contaminationState,
      source: { sessionId: job.sessionId },
      config: context.config,
    },
    deps
  )
  return {
    status: "succeeded",
    resultCode: withWindowOutcome("maintenance_completed", context.windowResultCode),
  }
}

/**
 * Persist the governance trail for one mined claim: the row patch, one evidence
 * row per citation, and the audit event.
 *
 * Evidence rows are written HERE and not by the consolidator because a claim's
 * evidence can only be attached once `persist` has produced a memory id. The
 * `messageId` on each row is what lets deletion of a source message find and
 * revoke the claims that depended on it.
 */
async function recordProjectClaimOutcome(params: {
  job: MemoryJob
  operation: ConsolidationOp
  contaminationState: "clean" | "external-context"
  allowSensitiveTopics?: boolean
  transcriptRevision?: number
  roleByMessageId: Map<string, string>
  excerpts: ReadonlyMap<string, string> | undefined
  toolExcerpts?: ReadonlyMap<string, string>
}): Promise<void> {
  const { job, operation } = params
  const memoryId = consolidationOpMemoryId(operation)
  const auditAction = consolidationAuditAction(operation)
  if (!memoryId || !auditAction) return

  const claim =
    operation.op === "ADD" ||
    operation.op === "CONFLICT" ||
    operation.op === "QUARANTINE" ||
    operation.op === "UPDATE"
      ? operation.candidate?.projectClaim
      : undefined
  const candidateText =
    operation.op === "ADD" || operation.op === "CONFLICT" || operation.op === "QUARANTINE"
      ? (operation.memory.text ?? operation.candidate?.text ?? "")
      : operation.op === "UPDATE"
        ? (operation.candidate?.text ?? "")
        : ""
  const topic = classifySensitiveMemoryTopic(candidateText)
  const quarantineSensitive = topic.sensitive && !params.allowSensitiveTopics
  const attachmentDerived = claim?.evidence?.some((reference) => reference.kind === "file")
  await updateMemory(memoryId, {
    evidenceState: "supported",
    reviewStatus: operation.op === "CONFLICT" ? "conflict" : "unreviewed",
    contaminationState: attachmentDerived ? "external-context" : params.contaminationState,
    sensitivity: topic.sensitive ? "sensitive" : "normal",
    ...(attachmentDerived || quarantineSensitive ? { trustState: "quarantined" as const } : {}),
  })

  for (const reference of claim?.evidence ?? []) {
    // `code-location` is checkable in principle but not on every shell, so it
    // is recorded with strategy `none` and contributes no support. See ADR
    // deviation #4 in the plan: making it real needs a batched native stat.
    const attachment =
      reference.kind === "file" ? parseAttachmentEvidenceSourceId(reference.sourceId) : undefined
    if (reference.kind === "file" && !attachment) continue
    const messageId =
      attachment?.messageId ??
      (reference.kind === "code-location"
        ? undefined
        : reference.kind === "message"
          ? reference.sourceId
          : reference.sourceId.slice(0, reference.sourceId.lastIndexOf(":")))
    const toolExcerpt =
      reference.kind === "tool-result" ? params.toolExcerpts?.get(reference.sourceId) : undefined
    const excerpt =
      toolExcerpt ??
      (attachment
        ? params.excerpts?.get(reference.sourceId)
        : messageId
          ? params.excerpts?.get(messageId)
          : undefined)
    await createMemoryEvidence({
      memoryId,
      kind: reference.kind,
      sourceId: reference.sourceId,
      sessionId: job.sessionId,
      messageId,
      sourceRole: attachment
        ? undefined
        : normalizeSourceRole(messageId ? params.roleByMessageId.get(messageId) : undefined),
      excerptHash: excerpt !== undefined ? hashContent(excerpt) : undefined,
      contaminationState: attachment ? "external-context" : params.contaminationState,
      reviewed: false,
      sourceRevision: params.transcriptRevision,
      validationStrategy:
        reference.kind === "file"
          ? "attachment-content-hash"
          : reference.kind === "message"
            ? "message-presence"
            : reference.kind === "tool-result"
              ? toolExcerpt !== undefined
                ? "tool-output-hash"
                : "tool-result-hash"
              : "none",
    })
  }

  await appendMemoryAuditEvent({
    action: auditAction,
    memoryId,
    sessionId: job.sessionId,
    reason: "project_mining",
  })
}

function normalizeSourceRole(role: string | undefined): MemoryEvidence["sourceRole"] {
  return role === "user" || role === "assistant" || role === "system" || role === "tool"
    ? role
    : undefined
}

/**
 * The backfill run that queued this window, or null for a live-mined one.
 *
 * `project-mining:<runId>:<sessionId>:<first>:<last>:<count>` for a run, and
 * `project-mining:<sessionId>:<first>:<last>:<count>` otherwise. The two are
 * told apart by field count, not by pattern-matching the id, so a session id
 * that happens to look like a run id cannot be misread.
 */
export function projectMiningRunIdOf(dedupeKey: string | undefined, runId?: string): string | null {
  if (runId) return runId
  if (!dedupeKey) return null
  const tagged = /^project-mining:(pmr_[^:]+):/.exec(dedupeKey)
  if (tagged) return tagged[1]!
  const parts = dedupeKey.split(":")
  if (parts[0] !== "project-mining") return null
  return parts.length === 6 ? parts[1]! : null
}

async function processProjectMining(job: MemoryJob): Promise<MemoryJobProcessOutcome> {
  const context = await loadJobContext(job)
  const projectId = job.projectId ?? context.session.projectId
  // A claim with no workspace has nowhere to be recalled from; retrying cannot
  // produce one, so this is terminal rather than a burned retry budget.
  if (!projectId) throw new MemoryJobTerminalError("project_missing")
  const runId = projectMiningRunIdOf(job.dedupeKey, job.runId)

  const [{ getDb }, { allRootPaths }] = await Promise.all([
    import("@/lib/db/schema"),
    import("@/lib/workspace/roots"),
  ])
  const db = getDb()
  if (runId && db.projectMiningRuns) {
    const run = await db.projectMiningRuns.get(runId).catch(() => undefined)
    if (run && run.status !== "running" && run.status !== "queued") {
      throw new MemoryJobTerminalError("job_claim_lost")
    }
  }
  // Roots feed path normalization. A workspace row that has gone missing is not
  // fatal — mining proceeds with no roots, which only means in-root absolute
  // paths are not rewritten and the identifying-path gate refuses the window.
  const project = await db.projects.get(projectId).catch(() => undefined)

  // Re-project the window with TOOL OUTPUT included. `loadJobContext` uses the
  // shared search projection, which drops tool parts — correct for personal
  // extraction, fatal here: a project's verified outcomes and gotchas live in
  // what Read/Bash/Grep actually returned, not in the assistant's summary of it.
  const messages = context.transcript
    .filter((entry): entry is typeof entry & { id: string } => Boolean(entry.id))
    .map((entry) => ({
      id: entry.id,
      role: entry.role,
      text: entry.parts ? projectMiningMessageText(entry.parts) : entry.text,
      createdAt: entry.createdAt,
      parts: entry.parts,
    }))
  const roleByMessageId = new Map(messages.map((message) => [message.id, message.role]))
  const sourceIds = messages.map((message) => message.id)
  const writeGuard: MemoryJobWriteGuardOptions = {
    expectedSourceHashes: context.sourceHashes,
    projectMessage: hashMessageSourceForJob,
    projectId,
    characterId: job.characterId ?? context.session.characterId,
    runId,
  }
  const recordedMemoryIds = new Set<string>()

  const { buildProjectMiningDeps, runProjectMining } =
    await import("@/lib/memory/write/run-project-mining")
  const deps = await buildProjectMiningDeps(
    {
      session: context.session,
      appSettings: context.settings,
      withCanonicalWrite: (write) => withMemoryJobWrite(job, sourceIds, write, writeGuard),
      recordCanonicalOperation: async (operation, excerptCtx) => {
        const id = consolidationOpMemoryId(operation)
        if (!id || !consolidationAuditAction(operation)) return
        await recordProjectClaimOutcome({
          job,
          operation,
          contaminationState: context.contaminationState,
          allowSensitiveTopics: context.config.allowSensitiveTopics,
          transcriptRevision: context.session.transcriptRevision,
          roleByMessageId,
          excerpts: excerptCtx.excerpts,
          toolExcerpts: excerptCtx.toolExcerpts,
        })
        recordedMemoryIds.add(id)
      },
    },
    context.config
  )
  if (!deps) throw new MemoryJobProcessingError("dependencies_unavailable")

  const updateNamespaces = new Map<ConsolidationOp, MemoryConsolidationNamespace>()
  const result = await runProjectMining(
    {
      messages,
      projectId,
      workspaceRoots: project ? allRootPaths(project) : [],
      projectHint: project?.name,
      // Claims describe the workspace, so they live at the workspace scope even
      // when the job itself was queued under a narrower one.
      scope: "workspace",
      characterId: job.characterId,
      agentId: job.agentId,
      provenance: job.provenance,
      source: { sessionId: job.sessionId },
      transcriptRevision: context.session.transcriptRevision,
      config: context.config,
    },
    {
      ...deps,
      consolidate: async (input) => {
        // Capture each group's target before consolidation. UPDATE has no row
        // snapshot, and the job alone cannot recover its branch/path narrowing.
        const expected: MemoryConsolidationNamespace = {
          scope: input.scope,
          projectId: input.projectId,
          characterId: input.scope === "character" ? input.characterId : undefined,
          agentId: input.scope === "agent" ? input.agentId : undefined,
          branch: input.branch,
          pathPattern: input.pathPattern,
        }
        const consolidated = await deps.consolidate(input)
        for (const operation of consolidated.applied) {
          if (operation.op === "UPDATE") updateNamespaces.set(operation, expected)
        }
        return consolidated
      },
    }
  )

  for (const operation of result.applied) {
    const memoryId = consolidationOpMemoryId(operation)
    if (!memoryId || !consolidationAuditAction(operation) || recordedMemoryIds.has(memoryId)) {
      continue
    }
    await withMemoryJobWrite(
      job,
      sourceIds,
      async () => {
        // Creation ops carry the row as written; UPDATE carries its group's
        // captured namespace. Never infer the expected namespace from a fresh
        // read, which would authorize a row that moved after consolidation.
        const expected =
          operation.op === "UPDATE"
            ? updateNamespaces.get(operation)
            : "memory" in operation
              ? operation.memory
              : undefined
        if (!expected) throw new MemoryJobProcessingError("project_mining_namespace_unavailable")
        const target = await withConsolidationTarget(memoryId, { expected }, "update", () =>
          recordProjectClaimOutcome({
            job,
            operation,
            contaminationState: context.contaminationState,
            transcriptRevision: context.session.transcriptRevision,
            roleByMessageId,
            excerpts: result.redactedExcerpts,
            toolExcerpts: result.redactedToolExcerpts,
          })
        )
        if (!target.ok) {
          await appendMemoryAuditEvent({
            action: "conflict",
            memoryId,
            sessionId: job.sessionId,
            reason: target.reason,
          })
        }
      },
      writeGuard
    )
  }

  if (!(await isMemoryJobClaimActive(job))) {
    throw new MemoryJobWriteError("job_claim_lost")
  }

  if (runId) {
    const netCreated = result.applied.filter(
      (operation) =>
        operation.op === "ADD" || operation.op === "CONFLICT" || operation.op === "QUARANTINE"
    ).length
    if (netCreated > 0) {
      const { recordProjectMiningRunClaims } = await import("@/lib/db/project-mining-runs")
      await recordProjectMiningRunClaims(runId, netCreated).catch(() => undefined)
    }
  }

  const partialAttachments =
    result.attachmentCoverage &&
    result.attachmentCoverage.mined < result.attachmentCoverage.available
  if (result.attachmentCoverage) {
    await appendMemoryAuditEvent({
      action: "learn-allowed",
      sessionId: job.sessionId,
      reason: partialAttachments ? "attachment_mining_partial" : "attachment_mining_completed",
      metadata: {
        attachmentChunksAvailable: result.attachmentCoverage.available,
        attachmentChunksMined: result.attachmentCoverage.mined,
      },
    })
  }
  if (result.applied.some((operation) => operation.op !== "NOOP")) {
    return {
      status: "succeeded",
      resultCode: withWindowOutcome(
        partialAttachments ? "claims_applied_attachment_partial" : "claims_applied",
        context.windowResultCode
      ),
    }
  }
  return {
    status: "no_output",
    resultCode: withWindowOutcome(
      partialAttachments ? "attachment_mining_partial" : (result.skipReason ?? "nothing_durable"),
      context.windowResultCode
    ),
  }
}

/**
 * How many claims one sweep pass re-checks.
 *
 * The drain budget is 20 jobs per 30s tick and each claim costs a handful of
 * Dexie reads plus a redaction pass, so the sweep is deliberately shallow and
 * runs daily: it exists to catch drift the targeted triggers missed (a crash
 * between a deletion and its enqueue), not to be the primary path.
 */
const CLAIM_SWEEP_BATCH = 25

async function processClaimRevalidation(job: MemoryJob): Promise<MemoryJobProcessOutcome> {
  const { buildClaimRevalidationDeps, revalidateClaim } =
    await import("@/lib/memory/lifecycle/revalidate-claim")
  const deps = await buildClaimRevalidationDeps()

  const targets = job.memoryId
    ? [job.memoryId]
    : (await listProjectClaimsNeedingRecheck(CLAIM_SWEEP_BATCH)).map((memory) => memory.id)
  if (targets.length === 0) {
    return { status: "no_output", resultCode: "no_claims_to_recheck" }
  }

  let invalidated = 0
  let revalidated = 0
  for (const memoryId of targets) {
    const result = await revalidateClaim(memoryId, deps)
    if (result.status === "invalidated") {
      invalidated += 1
      // The console's activity view is how a user finds out a claim stopped
      // being used. An invalidation with no audit row is indistinguishable
      // from one that never happened.
      await appendMemoryAuditEvent({
        action: "invalidated",
        memoryId,
        reason: "evidence_revoked",
        metadata: { support: result.verdict?.support ?? 0 },
      }).catch(() => undefined)
    } else if (result.status === "revalidated") {
      revalidated += 1
    }
  }

  if (invalidated > 0) return { status: "succeeded", resultCode: "claims_invalidated" }
  if (revalidated > 0) return { status: "succeeded", resultCode: "claims_revalidated" }
  return { status: "no_output", resultCode: "nothing_to_recheck" }
}

/** A lazy legacy-hash backfill must not send the entire corpus in one job. */
export const MAX_VECTOR_RECONCILE_UPSERTS = 500

async function processVectorReconcile(
  job: MemoryJob,
  config: MemoryConfig
): Promise<MemoryJobProcessOutcome> {
  const cleanupOnly = !config.enabled || config.temporary
  const { tryBuildMemoryVectorSink, filterPersonalMemories } =
    await import("@/lib/memory/runtime/build-deps")
  const sink = cleanupOnly
    ? await tryBuildMemoryVectorSink(config, { cleanupOnly: true })
    : await tryBuildMemoryVectorSink(config)
  if (!sink) throw new MemoryJobProcessingError("vector_backend_unavailable")

  // Backend snapshot first (when the store can list) so both healing legs and
  // the orphan sweep work off one consistent view.
  const backendIds = sink.listIds ? new Set(await sink.listIds()) : undefined

  const rows = await listMemories({ status: "active" })
  const readableIds = new Set((await filterPersonalMemories(rows)).map((memory) => memory.id))
  const activeDocIds = new Set<string>()
  let changes = 0
  let upserts = 0
  for (const row of rows) {
    if (!(await isMemoryJobClaimActive(job))) {
      throw new MemoryJobWriteError("job_claim_lost")
    }
    if (!readableIds.has(row.id)) {
      // Keep existing owner-scoped derived vectors; the recall boundary checks
      // their canonical provenance. This background job must not re-embed them.
      if (row.vectorDocId) activeDocIds.add(row.vectorDocId)
      continue
    }
    // PII-bearing text must not live in the vector store; skipping the row
    // also lets the orphan sweep below remove any legacy embedding of it.
    if (!hasNoLeakingPii(row.text)) continue
    const docId = row.vectorDocId ?? row.id
    activeDocIds.add(docId)
    const textHash = hashContent(row.text)
    // Missing hashes on legacy rows mean unknown freshness. Apply exactly the
    // same visibility/PII gates as missing ids, including during lazy backfill.
    const drift =
      !row.vectorDocId || row.vectorTextHash !== textHash || (backendIds && !backendIds.has(docId))
    if (drift && !cleanupOnly && upserts < MAX_VECTOR_RECONCILE_UPSERTS) {
      await sink.upsert(docId, row.text)
      if (!(await isMemoryJobClaimActive(job))) {
        throw new MemoryJobWriteError("job_claim_lost")
      }
      const live = await getMemory(row.id)
      if (live && live.status !== "active") {
        activeDocIds.delete(docId)
        await sink.delete([docId]).catch(() => undefined)
        continue
      }
      if (live && hashContent(live.text) !== textHash) {
        continue
      }
      await updateMemory(row.id, { vectorDocId: docId, vectorTextHash: textHash })
      upserts += 1
      changes += 1
    }
  }

  // Orphans: backend docs no active memory points at (invalidated/hard-deleted
  // rows whose vector cleanup failed). Only possible with a listing API.
  if (backendIds) {
    if (!(await isMemoryJobClaimActive(job))) {
      throw new MemoryJobWriteError("job_claim_lost")
    }
    const orphans = [...backendIds].filter((id) => !activeDocIds.has(id))
    if (orphans.length > 0) {
      await sink.delete(orphans)
      changes += orphans.length
    }
  }
  return changes > 0
    ? { status: "succeeded", resultCode: "vectors_reconciled" }
    : { status: "no_output", resultCode: "already_consistent" }
}

async function processLifecycleSweep(
  job: MemoryJob,
  config: MemoryConfig
): Promise<MemoryJobProcessOutcome> {
  if (!config.compactColdEpisodic && !config.dedupColdClusters) {
    return { status: "no_output", resultCode: "lifecycle_sweep_disabled" }
  }
  const [
    { runMemoryLifecycleSweep, retentionParamsFor },
    { isDecayable, retentionScore },
    { compactMemoryText },
    { sameMemoryNamespace },
    buildDeps,
    memDb,
    governance,
    { getDb },
  ] = await Promise.all([
    import("@/lib/memory/lifecycle/lifecycle-sweep"),
    import("@cognia/memory/forget/retention"),
    import("@cognia/memory/forget/compaction"),
    import("@/lib/memory/consolidate/consolidator"),
    import("@/lib/memory/runtime/build-deps"),
    import("@/lib/db/memories"),
    import("@/lib/db/memory-governance"),
    import("@/lib/db/schema"),
  ])
  const [reader, sink] = await Promise.all([
    config.dedupColdClusters ? buildDeps.tryBuildMemoryVectorReader(config) : undefined,
    buildDeps.tryBuildMemoryVectorSink(config),
  ])
  const retentionParams = retentionParamsFor(config)
  const threshold = config.coldRetentionThreshold ?? 0.2
  const isStillColdSnapshot = (
    live: import("@/types/memory/memory").Memory | undefined,
    snapshot: import("@/types/memory/memory").Memory,
    now: number
  ): live is import("@/types/memory/memory").Memory =>
    Boolean(
      live &&
      live.status === "active" &&
      live.revisionOf === undefined &&
      live.version === snapshot.version &&
      live.text === snapshot.text &&
      !live.pinned &&
      isDecayable(live) &&
      live.compactedAt === undefined &&
      sameMemoryNamespace(live, snapshot) &&
      retentionScore(live, { now, params: retentionParams }) < threshold
    )

  const syncRevisedVector = async (
    memory: import("@/types/memory/memory").Memory,
    text: string
  ) => {
    if (!sink) return
    if (!(await buildDeps.filterPersonalMemories([memory])).length) return
    try {
      if (hasNoLeakingPii(text)) {
        await sink.upsert(memory.vectorDocId ?? memory.id, text)
        await memDb.updateMemory(memory.id, {
          vectorDocId: memory.vectorDocId ?? memory.id,
          vectorTextHash: hashContent(text),
        })
      } else if (memory.vectorDocId) {
        await sink.delete([memory.vectorDocId])
      }
    } catch {
      const { noteMemoryVectorFailure } = await import("./enqueue-reconcile")
      noteMemoryVectorFailure()
    }
  }

  const report = await runMemoryLifecycleSweep(
    { config },
    {
      listActive: () => listMemories({ status: "active" }),
      ...(reader ? { loadEmbeddings: (rows) => reader.getEmbeddings(rows) } : {}),
      reviseText: async (memory, text, reason, now) => {
        if (!(await isMemoryJobClaimActive(job))) {
          throw new MemoryJobWriteError("job_claim_lost")
        }
        const db = getDb()
        if (db.memories && typeof db.transaction === "function") {
          const applied = await db.transaction("rw", [db.memories], async () => {
            const live = await db.memories.get(memory.id)
            if (!isStillColdSnapshot(live, memory, now)) return false
            await memDb.updateMemory(memory.id, {
              text,
              bumpVersion: true,
              revisionReason: reason,
              compactedAt: now,
            })
            return true
          })
          if (!applied) return false
        } else {
          await memDb.updateMemory(memory.id, {
            text,
            bumpVersion: true,
            revisionReason: reason,
            compactedAt: now,
          })
        }
        await syncRevisedVector(memory, text)
      },
      supersede: async (loser, survivor) => {
        await memDb.invalidateMemory(loser.id, survivor.id)
        if (!sink || !loser.vectorDocId) return
        try {
          await sink.delete([loser.vectorDocId])
        } catch {
          const { noteMemoryVectorFailure } = await import("./enqueue-reconcile")
          noteMemoryVectorFailure()
        }
      },
      moveEvidence: async (loser, survivor) => {
        for (const row of await governance.listMemoryEvidence(loser.id)) {
          const { id: _id, memoryId: _memoryId, ...rest } = row
          await governance.createMemoryEvidence({ ...rest, memoryId: survivor.id })
        }
      },
      applyDedupMerge: async ({ survivor, survivorText, merged, now }) => {
        if (!(await isMemoryJobClaimActive(job))) {
          throw new MemoryJobWriteError("job_claim_lost")
        }
        const db = getDb()
        if (!db.memories || typeof db.transaction !== "function") {
          await memDb.updateMemory(survivor.id, {
            text: survivorText,
            bumpVersion: true,
            revisionReason: "dedup-merge",
            compactedAt: now,
          })
          for (const loser of merged) {
            for (const row of await governance.listMemoryEvidence(loser.id)) {
              const { id: _id, memoryId: _memoryId, ...rest } = row
              await governance.createMemoryEvidence({ ...rest, memoryId: survivor.id })
            }
            await memDb.invalidateMemory(loser.id, survivor.id)
            await appendMemoryAuditEvent({
              action: "invalidated",
              memoryId: loser.id,
              reason: "dedup_merged",
              metadata: { survivorId: survivor.id },
            })
          }
          await appendMemoryAuditEvent({
            action: "revised",
            memoryId: survivor.id,
            reason: "dedup_merge",
            metadata: { merged: merged.length },
          })
          await syncRevisedVector(survivor, survivorText)
          if (sink) {
            const loserDocs = merged
              .map((loser) => loser.vectorDocId)
              .filter((id): id is string => Boolean(id))
            if (loserDocs.length > 0) {
              await sink.delete(loserDocs).catch(async () => {
                const { noteMemoryVectorFailure } = await import("./enqueue-reconcile")
                noteMemoryVectorFailure()
              })
            }
          }
          return { applied: true, mergedIds: merged.map((loser) => loser.id) }
        }

        const outcome = await db.transaction(
          "rw",
          [db.memories, db.memoryEvidence, db.memoryAuditEvents],
          async () => {
            const liveSurvivor = await db.memories.get(survivor.id)
            if (!isStillColdSnapshot(liveSurvivor, survivor, now)) {
              return { applied: false, mergedLosers: [] as typeof merged }
            }
            const mergedLosers: Array<(typeof merged)[number]> = []
            for (const loser of merged) {
              const liveLoser = await db.memories.get(loser.id)
              if (isStillColdSnapshot(liveLoser, loser, now)) {
                mergedLosers.push(loser)
              }
            }
            if (mergedLosers.length === 0) {
              return { applied: false, mergedLosers: [] as typeof merged }
            }
            const effectiveText =
              mergedLosers.length === merged.length
                ? survivorText
                : (compactMemoryText(
                    [survivor.text, ...mergedLosers.map((loser) => loser.text)].join("\n\n"),
                    { force: true }
                  )?.text ?? survivor.text)
            await memDb.updateMemory(survivor.id, {
              text: effectiveText,
              bumpVersion: true,
              revisionReason: "dedup-merge",
              compactedAt: now,
            })
            for (const loser of mergedLosers) {
              for (const row of await governance.listMemoryEvidence(loser.id)) {
                const { id: _id, memoryId: _memoryId, ...rest } = row
                await governance.createMemoryEvidence({ ...rest, memoryId: survivor.id })
              }
              await memDb.invalidateMemory(loser.id, survivor.id)
              await appendMemoryAuditEvent({
                action: "invalidated",
                memoryId: loser.id,
                reason: "dedup_merged",
                metadata: { survivorId: survivor.id },
              })
            }
            await appendMemoryAuditEvent({
              action: "revised",
              memoryId: survivor.id,
              reason: "dedup_merge",
              metadata: { merged: mergedLosers.length },
            })
            return { applied: true, mergedLosers, effectiveText }
          }
        )
        if (!outcome.applied || outcome.mergedLosers.length === 0) {
          return { applied: false, mergedIds: [] }
        }
        await syncRevisedVector(survivor, outcome.effectiveText ?? survivorText)
        if (sink) {
          const loserDocs = outcome.mergedLosers
            .map((loser) => loser.vectorDocId)
            .filter((id): id is string => Boolean(id))
          if (loserDocs.length > 0) {
            await sink.delete(loserDocs).catch(async () => {
              const { noteMemoryVectorFailure } = await import("./enqueue-reconcile")
              noteMemoryVectorFailure()
            })
          }
        }
        return { applied: true, mergedIds: outcome.mergedLosers.map((loser) => loser.id) }
      },
      audit: (event) => appendMemoryAuditEvent(event).then(() => undefined),
    }
  )
  if (report.merges.length === 0 && report.compacted.length === 0) {
    return {
      status: "no_output",
      resultCode: report.dedupSkipped ? "lifecycle_dedup_no_vectors" : "nothing_cold",
    }
  }
  return { status: "succeeded", resultCode: "lifecycle_swept" }
}

/**
 * Dispatch one job.
 *
 * EXHAUSTIVE SWITCH, deliberately — this was an `if / if / fall through to
 * vector reconcile` chain, which meant every future job kind silently ran the
 * reconciler instead of its own handler. The `never` assignment makes a new kind
 * a compile error at exactly the place that has to handle it.
 */
export async function processMemoryJob(job: MemoryJob): Promise<MemoryJobProcessOutcome> {
  const config = resolveMemoryConfig((await getSettings())?.memory)
  // Text-writing: turn-extraction, session-distill, project-mining and
  // memory-lifecycle-sweep (compaction/dedup) require enabled && !temporary.
  // Cleanup: project-claim-revalidate revokes source support without rewriting
  // text; vector-reconcile may delete orphan/unsafe vectors under either hard
  // gate, but must not re-embed. Tombstone/deleted-data retention cleanup runs
  // outside this dispatcher and remains allowed. These are all six job kinds.
  if (job.kind !== "project-claim-revalidate" && job.kind !== "vector-reconcile") {
    if (!config.enabled) return { status: "skipped", resultCode: "memory_disabled" }
    if (config.temporary) return { status: "skipped", resultCode: "memory_temporary" }
  }
  switch (job.kind) {
    case "turn-extraction":
      return processTurnExtraction(job)
    case "session-distill":
      return processSessionDistill(job)
    case "project-mining":
      return processProjectMining(job)
    case "project-claim-revalidate":
      return processClaimRevalidation(job)
    case "vector-reconcile":
      return processVectorReconcile(job, config)
    case "memory-lifecycle-sweep":
      return processLifecycleSweep(job, config)
    default: {
      const exhaustive: never = job.kind
      throw new MemoryJobTerminalError(`unknown_job_kind:${String(exhaustive)}`)
    }
  }
}

async function defaultRepairNamespaces(): Promise<unknown> {
  const { repairWorkspaceScopedMemories } =
    await import("@/lib/memory/backfill/repair-workspace-scope")
  return repairWorkspaceScopedMemories()
}

async function defaultTickBackfills(): Promise<number> {
  const { tickActiveWorkspaceBackfills } = await import("@/lib/memory/backfill/backfill-service")
  return tickActiveWorkspaceBackfills()
}

const defaultWorkerDeps: MemoryJobWorkerDeps = {
  claimNext: claimNextMemoryJob,
  finish: (id, outcome, workerId, fencingEpoch) =>
    finishMemoryJob(id, outcome.status, outcome.resultCode, Date.now(), {
      workerId,
      fencingEpoch,
    }),
  fail: (id, code, workerId, fencingEpoch) =>
    failMemoryJob(id, code, Date.now(), { workerId, fencingEpoch }),
  process: processMemoryJob,
  heartbeat: (jobId, workerId, fencingEpoch, onLeaseLost) =>
    startMemoryJobHeartbeat(jobId, workerId, { fencingEpoch, onLeaseLost }),
}
