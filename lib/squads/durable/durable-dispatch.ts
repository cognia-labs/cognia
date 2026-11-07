import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"
import { hasNoLeakingPii, redactText } from "@cognia/redact"
import {
  childStopProof,
  hasRemoteDispatch,
  ownsDispatchAttempt,
  planDispatchAttempt,
} from "@cognia/agent-orchestration/replay"
import { assessStoredTaskRecovery } from "@cognia/agent-orchestration/coordinator"
import { rejectedEpochEvent } from "@cognia/agent-orchestration/rules"
import { recordRunUsage } from "@cognia/agent-orchestration/usage"
import { reportTeamRunUsage } from "@/lib/execution/agent-team-bridge"
import type { AgentTeam } from "@/types/agent/agent-team"
import type {
  AgentTeamSideEffect,
  AgentTeamTrajectoryEvent,
} from "@/types/agent/agent-team-runtime"
import { createEvidenceBundle } from "@cognia/agent-orchestration/evidence"
import { createDecisionLedger } from "@cognia/agent-orchestration/decision-ledger"
import type { AgentExecutionEnvironment } from "@/lib/ai/agent/execution/local-tauri-environment"
import type { DurableChildControl, DurableTeamCoordinator } from "./durable-runtime"
import { isDurableChildReplaySafe } from "./durable-runtime"
import { tokenize } from "@/lib/terminal/completion/tokenize"

export interface BeginDurableDispatchInput {
  coordinator: DurableTeamCoordinator
  team: AgentTeam
  runId: string
  teammateId: string
  taskId: string
  access: "read" | "write"
  taskKind?: "general" | "code" | "ui"
  repositoryId: string
  fileOwnership?: string[]
  runtime?: string
  executorRegistry?: import("@/types/agent/agent-team-runtime").AgentTeamChildRun["executorRegistry"]
  /** Independent attempts retain child recovery gates without parking sibling tasks. */
  isolateFailure?: boolean
  now?: () => number
}

function id(): string {
  return `team-child-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`
}

function isVerificationCommand(
  event: Extract<CaptureStreamEvent, { type: "tool-result" }>
): boolean {
  if (
    !/^(?:bash|shell|shell_command|exec_command|shell_execute(?:_advanced)?|run_terminal_cmd)$/i.test(
      event.toolName
    )
  )
    return false
  const command = typeof event.input?.command === "string" ? event.input.command : ""
  // Only simple foreground commands qualify; shell composition or redirection
  // can mask the verifier's result or mutate the revision being certified.
  if (/[;&|`\n\r$<>\\]/.test(command)) return false
  // Reuse quote-aware tokenization for flags, not as a shell security parser.
  if (
    tokenize(command).some(({ value }) =>
      /^--?(?:h|help|v|version|list|listTests|list-tests|showConfig|show-config|dry-run|no-run|watch|watchAll|ui|fix|write|update|updateSnapshot|u|passWithNoTests|if-present)(?:=|$)/i.test(
        value
      )
    )
  )
    return false
  return /^(?:rtk\s+)?(?:(?:pnpm|npm|yarn|bun)(?:\s+(?:exec|run))?\s+(?:test(?::[\w-]+)?|vitest|jest|playwright\s+test|lint|typecheck|tsc|build)|(?:npx\s+)?(?:vitest|jest|tsc)|cargo\s+(?:test|check|build))(?=\s|$)/i.test(
    command.trim()
  )
}

function redactedJson(value: unknown): string {
  const redacted = redactText(JSON.stringify(value) ?? "null").redacted
  return hasNoLeakingPii(redacted) ? redacted : JSON.stringify({ redacted: true })
}

class DispatchControlConflictError extends Error {}

export async function beginDurableDispatch(input: BeginDurableDispatchInput) {
  const now = input.now ?? Date.now
  let childRunId = id()
  let retryTargetHostRef: string | undefined
  let attempt = 1
  let previousFailures = 0
  let dispatchEpoch = 0
  let admissionRefusal: string | undefined
  const startedAt = now()
  const store = input.coordinator.store
  try {
    await store.atomically(async (tx) => {
      const run = await tx.getRun(input.runId)
      const plan = planDispatchAttempt(
        await tx.findLatestChild(input.runId, input.taskId, input.teammateId),
        run
      )
      if (plan.kind === "conflict") throw new DispatchControlConflictError(plan.reason)
      const eligibility = await input.coordinator.assessTaskRecovery(input.runId, input.taskId, tx)
      if (!eligibility.eligible) {
        admissionRefusal = eligibility.reason
        if (run)
          await tx.updateRunIfCurrent(run.id, run, {
            status: "needs_input",
            recoveryReason: eligibility.reason,
            updatedAt: now(),
          })
        for (const childId of eligibility.childRunIds) {
          const child = await tx.getChild(childId)
          if (child)
            await tx.updateChildIfCurrent(childId, child, {
              // Preserve turn completion as evidence even on legacy rows with
              // no startup metadata; a second gate must not infer never-started.
              status: child.status === "completed" ? "completed" : "needs_input",
              waitingReason: eligibility.reason,
              updatedAt: now(),
            })
        }
        return
      }
      attempt = plan.attempt
      if (plan.kind === "resume") {
        childRunId = plan.child.id
        retryTargetHostRef = plan.retryTargetHostRef
        previousFailures = plan.previousFailures
        dispatchEpoch = plan.child.dispatchEpoch ?? 0
        const resumed = await tx.updateChildIfCurrent(childRunId, plan.child, {
          status: "running",
          runtime: input.runtime ?? plan.child.runtime,
          executorRegistry: input.executorRegistry,
          dispatchEpoch,
          dispatchLeaseId: undefined,
          dispatchLeaseExpiresAt: undefined,
          attempt,
          // Recovery admitted a new attempt using the previous attempt's proof.
          // A stop written after this admission belongs to this attempt and
          // must survive (and refuse) the later executor-start transaction.
          stop: undefined,
          decisionVersion: run?.decisionVersion ?? plan.child.decisionVersion,
          error: undefined,
          waitingReason: undefined,
          completedAt: undefined,
          updatedAt: startedAt,
        })
        if (!resumed)
          throw new DispatchControlConflictError("Child control changed before dispatch")
      } else {
        await input.coordinator.registerChild(
          {
            runId: input.runId,
            childRunId,
            teammateId: input.teammateId,
            taskId: input.taskId,
            repositoryId: input.repositoryId,
            access: input.access,
            ...(input.fileOwnership ? { fileOwnership: input.fileOwnership } : {}),
            ...(input.runtime ? { runtime: input.runtime } : {}),
            ...(input.executorRegistry ? { executorRegistry: input.executorRegistry } : {}),
          },
          tx
        )
      }
    })
    if (admissionRefusal) throw new DispatchControlConflictError(admissionRefusal)
  } catch (error) {
    if (error instanceof DispatchControlConflictError) throw error
    const parking = await Promise.allSettled([
      (async () => {
        const child = await store.getChild(childRunId)
        if (child && ["running", "queued", "recovering"].includes(child.status)) {
          await store.updateChildIfCurrent(childRunId, child, {
            status: "needs_input",
            waitingReason: "recovery_required",
            error: "Dispatch initialization could not be persisted",
            updatedAt: now(),
          })
        }
      })(),
      (async () => {
        if (input.isolateFailure) return
        const run = await store.getRun(input.runId)
        if (run && ["running", "queued", "recovering"].includes(run.status)) {
          await store.updateRunIfCurrent(input.runId, run, {
            status: "needs_input",
            recoveryReason: "dispatch_initialization_failed",
            updatedAt: now(),
          })
        }
      })(),
    ])
    const failures = parking.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    )
    if (failures.length)
      throw new AggregateError(
        [error, ...failures],
        "Dispatch initialization and recovery persistence failed",
        { cause: error }
      )
    throw error
  }

  let executionStarted = false
  let executionInvoked = false
  let executionFinished = false
  let localStopObserved = false
  let localStopFailed = false
  const pendingLocalStops = new Set<Promise<void>>()
  let localSettlement: Promise<void> | undefined
  const appendDispatchTrajectory = (
    event: Parameters<typeof store.appendTrajectory>[0],
    content?: Parameters<typeof store.appendTrajectory>[1],
    epoch = dispatchEpoch
  ) =>
    store.appendTrajectory(
      { ...event, expectedDispatchEpoch: epoch, expectedDispatchAttempt: attempt },
      content
    )
  const checkpointDispatch = (
    checkpoint: Parameters<typeof input.coordinator.checkpoint>[1],
    epoch = dispatchEpoch
  ) =>
    input.coordinator.checkpoint(childRunId, {
      ...checkpoint,
      expectedDispatchEpoch: epoch,
      expectedDispatchAttempt: attempt,
    })
  const admitExecution = async (
    claim: (
      tx: typeof store,
      child: NonNullable<Awaited<ReturnType<typeof store.getChild>>>
    ) => ReturnType<typeof store.getChild>
  ) => {
    let refusal: string | undefined
    const result = await store.atomically(async (tx) => {
      const child = await tx.getChild(childRunId)
      const run = await tx.getRun(input.runId)
      if (!child || child.attempt !== attempt || (child.dispatchEpoch ?? 0) !== dispatchEpoch)
        throw new Error("Dispatch epoch changed before executor start")
      if (!["running", "queued"].includes(child.status) || child.stop?.epoch === dispatchEpoch)
        throw new DOMException("Child stopped before executor start", "AbortError")
      if (
        !run ||
        !["running", "recovering", "queued"].includes(run.status) ||
        run.stop?.state === "requested" ||
        run.stop?.state === "unconfirmed"
      )
        throw new Error("Run is not accepting execution")
      const eligibility = await input.coordinator.assessTaskRecovery(
        input.runId,
        input.taskId,
        tx,
        childRunId
      )
      if (!eligibility.eligible) {
        refusal = eligibility.reason
        await tx.updateRunIfCurrent(run.id, run, {
          status: "needs_input",
          recoveryReason: eligibility.reason,
          updatedAt: now(),
        })
        await tx.updateChildIfCurrent(child.id, child, {
          status: "needs_input",
          waitingReason: eligibility.reason,
          updatedAt: now(),
        })
        return undefined
      }
      return claim(tx, child)
    })
    if (refusal) throw new Error(refusal)
    return result
  }
  const startLocalExecution = async (): Promise<void> => {
    if (executionStarted) return
    const epoch = dispatchEpoch + 1
    const started = await admitExecution(async (tx, child) => {
      const patch = {
        dispatchEpoch: epoch,
        ...(hasRemoteDispatch(child)
          ? { remoteDispatchEpoch: child.remoteDispatchEpoch ?? child.dispatchEpoch ?? 0 }
          : {}),
        startedAt: now(),
        settledEpoch: undefined,
        fenceCapable: false,
        fenceGraceMs: undefined,
        leaseTtlMs: undefined,
        lastRenewalSentAt: undefined,
        dispatchLeaseId: undefined,
        dispatchLeaseExpiresAt: undefined,
        updatedAt: now(),
      }
      if (!(await tx.updateChildIfCurrent(childRunId, child, patch))) return undefined
      await tx.appendTrajectory({
        runId: input.runId,
        childRunId,
        expectedDispatchEpoch: epoch,
        kind: "model_turn_started",
        correlationId: childRunId,
        createdAt: now(),
      })
      return { ...child, ...patch }
    })
    if (!started) throw new Error("Child changed before local executor start")
    dispatchEpoch = epoch
    executionStarted = true
  }
  const claimRemoteLease = async (lease: Parameters<typeof store.claimDispatchLease>[0]) => {
    if (executionStarted) throw new Error("Dispatch already claimed an execution")
    const child = await admitExecution(async (tx) => {
      const claimed = await tx.claimDispatchLease({
        ...lease,
        childRunId,
        expectedEpoch: dispatchEpoch,
      })
      if (claimed)
        await tx.appendTrajectory({
          runId: input.runId,
          childRunId,
          expectedDispatchEpoch: claimed.dispatchEpoch,
          kind: "model_turn_started",
          correlationId: childRunId,
          createdAt: now(),
        })
      return claimed
    })
    if (child) {
      dispatchEpoch = child.dispatchEpoch ?? 0
      executionStarted = true
    }
    return child
  }
  const settleLocalExecution = async (): Promise<void> => {
    // ACK comes from runtime disposal of the WP1 TOOL groups (including the
    // Claude CLI); turn completion and deferred helper lifetimes are separate.
    if (!executionStarted) return
    for (;;) {
      const child = await store.getChild(childRunId)
      if (!child) return
      if (child.attempt !== attempt || (child.dispatchEpoch ?? 0) !== dispatchEpoch) {
        await store.appendTrajectory(
          rejectedEpochEvent(child, dispatchEpoch, "local_settlement", now())
        )
        return
      }
      if (hasRemoteDispatch(child)) return
      const at = now()
      if (
        await store.updateChildIfCurrent(childRunId, child, {
          settledEpoch: dispatchEpoch,
          stop: {
            state: "confirmed",
            epoch: dispatchEpoch,
            requestedAt: child.stop?.requestedAt ?? at,
            proof: { kind: "ack", epoch: dispatchEpoch, at },
          },
          updatedAt: at,
        })
      )
        return
    }
  }

  const sideEffects = new Map<string, AgentTeamSideEffect>()
  const toolStartedAt = new Map<string, number>()
  const toolInputs = new Map<string, Record<string, unknown>>()
  const toolResults: Array<Extract<CaptureStreamEvent, { type: "tool-result" }>> = []
  let toolTimeMs = 0
  let writes = Promise.resolve()
  let writeError: unknown
  const persistenceAbort = new AbortController()
  let pendingSteeringIds: string[] = []
  let detachControl: (() => void) | undefined
  let providerControl: DurableChildControl | undefined
  let executionEnvironment: AgentExecutionEnvironment | undefined
  let turnContextPrepared = false
  const enqueue = (operation: () => Promise<unknown>): void => {
    writes = writes.then(async () => {
      if (persistenceAbort.signal.aborted) return
      try {
        await ownedChild()
        await operation()
      } catch (error) {
        writeError = error
        persistenceAbort.abort(error)
      }
    })
  }
  const flush = async (): Promise<void> => {
    await writes
    if (persistenceAbort.signal.aborted) throw writeError
  }
  const parkRun = async (reason: string, at: number): Promise<void> => {
    if (input.isolateFailure) return
    const run = await store.getRun(input.runId)
    if (!run || ["completed", "failed", "cancelled", "terminated"].includes(run.status)) return
    await store.updateRunIfCurrent(input.runId, run, {
      status: "needs_input",
      recoveryReason: reason,
      updatedAt: at,
    })
  }
  const ownedChild = async () => {
    const child = await store.getChild(childRunId)
    if (!ownsDispatchAttempt(child, attempt) || (child.dispatchEpoch ?? 0) !== dispatchEpoch) {
      if (child)
        await store.appendTrajectory(rejectedEpochEvent(child, dispatchEpoch, "projection", now()))
      const error = new Error("Dispatch no longer owns this child attempt")
      error.name = "AbortError"
      throw error
    }
    return child
  }
  const currentChild = async () => {
    const child = await ownedChild()
    if (
      !["running", "queued"].includes(child.status) ||
      child.stop?.state === "requested" ||
      child.stop?.state === "unconfirmed" ||
      (executionStarted &&
        hasRemoteDispatch(child) &&
        !!childStopProof(child, now()) &&
        child.settledEpoch !== dispatchEpoch)
    ) {
      const error = new Error("Child is no longer active")
      error.name = "AbortError"
      throw error
    }
    return child
  }
  const updateOwnedChild = async (patch: Parameters<typeof store.updateChild>[1]) => {
    if (!(await store.updateChildIfCurrent(childRunId, await ownedChild(), patch))) {
      throw new Error("Dispatch no longer owns this child projection")
    }
  }
  const hasUnsafeRemoteHistory = async (): Promise<boolean> => {
    const [checkpoint, trajectory] = await Promise.all([
      store.getLatestCheckpoint(childRunId),
      store.listTrajectory(input.runId),
    ])
    if (
      !trajectory.some((event) => event.childRunId === childRunId && event.kind === "remote_event")
    ) {
      return false
    }
    return !(await isDurableChildReplaySafe(childRunId, checkpoint, trajectory, store))
  }

  const capture = (event: CaptureStreamEvent): void => {
    const eventEpoch = dispatchEpoch
    if (event.type === "tool-call") {
      const effectId = event.id ?? `tool-${sideEffects.size + 1}`
      toolStartedAt.set(effectId, now())
      if (event.input) toolInputs.set(effectId, event.input)
      sideEffects.set(effectId, {
        id: effectId,
        kind: event.toolName,
        state: "intent",
        replay: "unknown",
      })
      const checkpointEffects = [...sideEffects.values()].map((effect) => ({ ...effect }))
      enqueue(async () => {
        const safeInput = redactedJson(event.input)
        const large = safeInput.length > 8192
        const trajectory = await appendDispatchTrajectory(
          {
            runId: input.runId,
            childRunId,
            kind: "tool_intent",
            correlationId: effectId,
            payload: {
              toolName: event.toolName,
              ...(large ? { contentAddressed: true } : { input: JSON.parse(safeInput) }),
            },
            createdAt: now(),
          },
          large ? { data: safeInput, mimeType: "application/json" } : undefined,
          eventEpoch
        )
        await checkpointDispatch(
          {
            trajectorySequence: trajectory.sequence,
            replay: "needs_input",
            sideEffects: checkpointEffects,
          },
          eventEpoch
        )
      })
      return
    }
    if (event.type === "tool-result") {
      const effectId = event.id ?? `tool-result-${toolResults.length + 1}`
      const toolStart = toolStartedAt.get(effectId)
      if (toolStart !== undefined) {
        toolTimeMs += Math.max(0, now() - toolStart)
        toolStartedAt.delete(effectId)
      }
      const existing = sideEffects.get(effectId)
      sideEffects.set(effectId, {
        id: effectId,
        kind: event.toolName,
        state: event.isError ? "failed" : "completed",
        replay: existing?.replay ?? "unknown",
      })
      const checkpointEffects = [...sideEffects.values()].map((effect) => ({ ...effect }))
      const checkpointReplay = checkpointEffects.some((effect) => effect.state === "intent")
        ? "needs_input"
        : "safe"
      toolResults.push({ ...event, input: event.input ?? toolInputs.get(effectId) })
      enqueue(async () => {
        const safeResult = redactedJson({ input: event.input, result: event.result })
        const large = safeResult.length > 8192
        const trajectory = await appendDispatchTrajectory(
          {
            runId: input.runId,
            childRunId,
            kind: "tool_result",
            correlationId: effectId,
            payload: {
              toolName: event.toolName,
              isError: event.isError,
              ...(large ? { contentAddressed: true } : JSON.parse(safeResult)),
            },
            createdAt: now(),
          },
          large ? { data: safeResult, mimeType: "application/json" } : undefined,
          eventEpoch
        )
        await checkpointDispatch(
          {
            trajectorySequence: trajectory.sequence,
            replay: checkpointReplay,
            sideEffects: checkpointEffects,
          },
          eventEpoch
        )
      })
    }
  }

  const refreshControl = (): void => {
    detachControl?.()
    if (!providerControl && !executionEnvironment) {
      detachControl = undefined
      return
    }
    detachControl = input.coordinator.attachLiveControl(childRunId, {
      async steer(message, sourceMessageId) {
        if (!providerControl) throw new Error("The active child runtime does not support steering")
        await providerControl.steer(message, sourceMessageId)
      },
      async pause() {
        const safe = await providerControl?.pause?.()
        await executionEnvironment?.suspend(childRunId)
        return safe
      },
      async resume(epoch) {
        // A resumed executor owns a new epoch; this dispatch keeps fencing its old callbacks.
        await executionEnvironment?.resume(childRunId)
        await providerControl?.resume?.(epoch)
      },
      resumeStartsExecution:
        providerControl?.resumeStartsExecution ?? providerControl?.resume !== undefined,
      async terminate() {
        const proof = await providerControl?.terminate?.()
        await executionEnvironment?.terminate(childRunId)
        return proof
      },
    })
  }

  const attachControl = async (
    control: DurableChildControl,
    sessionId?: string,
    executorRegistry?: BeginDurableDispatchInput["executorRegistry"]
  ): Promise<() => void> => {
    await ownedChild()
    if (sessionId || executorRegistry)
      await updateOwnedChild({
        ...(sessionId ? { sessionId } : {}),
        ...(executorRegistry ? { executorRegistry } : {}),
        updatedAt: now(),
      })
    providerControl = control
    refreshControl()
    return () => detachControl?.()
  }

  const evidence = createEvidenceBundle({
    store,
    runId: input.runId,
    childRunId,
    taskId: input.taskId,
    attempt,
    policy: input.team.config.evidencePolicy,
    now,
  })

  const recordToolEvidence = async (revision?: string): Promise<void> => {
    // Inspect the stream backwards once. A later edit invalidates previous
    // checks; a failed latest check cannot be hidden by a different passing one.
    const statuses = new Map<number, "passed" | "failed" | "unknown">()
    const latestChecks = new Map<string, "passed" | "failed" | "unknown">()
    let changedLater = false
    for (let index = toolResults.length - 1; index >= 0; index--) {
      const event = toolResults[index]
      if (!isVerificationCommand(event)) {
        if (!/^(Read|Glob|Grep|Search|WebSearch|WebFetch)$/i.test(event.toolName))
          changedLater = true
        continue
      }
      const result = event.result as { exitCode?: number; exit_code?: number } | undefined
      const exitCode =
        result && typeof result === "object" ? (result.exitCode ?? result.exit_code) : undefined
      const status =
        event.isError === true || (exitCode !== undefined && exitCode !== 0)
          ? "failed"
          : !changedLater && (exitCode === 0 || event.isError === false)
            ? "passed"
            : "unknown"
      statuses.set(index, status)
      const command = String(event.input?.command).trim()
      if (!latestChecks.has(command)) latestChecks.set(command, status)
    }
    const hasUnverifiedCheck = [...latestChecks.values()].some((status) => status !== "passed")
    for (const [index, event] of toolResults.entries()) {
      const content = redactedJson({
        input: event.input,
        result: event.result,
        isError: event.isError,
      })
      await evidence.record({
        kind: "command",
        title: event.toolName,
        content,
        mimeType: "application/json",
      })
      const status = statuses.get(index)
      if (status) {
        await evidence.record({
          kind: "test",
          title: event.toolName,
          content,
          mimeType: "application/json",
          status: status === "passed" && hasUnverifiedCheck ? "unknown" : status,
          ...(revision ? { revision } : {}),
        })
      }
    }
  }

  const checkpointPause = async (): Promise<boolean> => {
    await flush()
    await ownedChild()
    const pausedAt = now()
    const effects = [...sideEffects.values()]
    const safe =
      !(await hasUnsafeRemoteHistory()) &&
      effects.every(
        (effect) =>
          effect.state !== "unknown" && !(effect.state === "intent" && effect.replay !== "safe")
      )
    const event = await appendDispatchTrajectory({
      runId: input.runId,
      childRunId,
      kind: "checkpoint",
      correlationId: `pause:${childRunId}:${pausedAt}`,
      payload: { replay: safe ? "safe" : "needs_input", paused: true },
      createdAt: pausedAt,
    })
    await checkpointDispatch({
      trajectorySequence: event.sequence,
      replay: safe ? "safe" : "needs_input",
      sideEffects: effects,
    })
    return safe
  }

  const finishLocalExecution = async (): Promise<void> => {
    try {
      const child = await store.getChild(childRunId)
      if (
        child?.attempt === attempt &&
        (child.dispatchEpoch ?? 0) === dispatchEpoch &&
        !hasRemoteDispatch(child) &&
        (["pausing", "paused"].includes(child.status) ||
          child.waitingReason === "pause_unconfirmed")
      )
        await checkpointPause()
    } finally {
      await settleLocalExecution()
    }
  }

  return {
    childRunId,
    /** Serialize task projection with epoch claims, including the outer catch. */
    projectIfCurrent(project: () => void): Promise<boolean> {
      return store.atomically(async (tx) => {
        const child = await tx.getChild(childRunId)
        const taskChildren = new Set(
          (await tx.listChildren(input.runId))
            .filter((candidate) => candidate.taskId === input.taskId)
            .map((candidate) => candidate.id)
        )
        // Journal sequence orders task admission/execution across teammates,
        // even when clocks tie or an older child's updatedAt changes later.
        const owner = (await tx.listTrajectory(input.runId))
          .filter(
            (event) =>
              event.childRunId &&
              taskChildren.has(event.childRunId) &&
              (event.kind === "child_created" || event.kind === "model_turn_started")
          )
          .reduce<AgentTeamTrajectoryEvent | undefined>(
            (latest, event) => (!latest || event.sequence > latest.sequence ? event : latest),
            undefined
          )
        if (
          !child ||
          owner?.childRunId !== childRunId ||
          child.attempt !== attempt ||
          (child.dispatchEpoch ?? 0) !== dispatchEpoch
        ) {
          if (child)
            await tx.appendTrajectory(
              rejectedEpochEvent(child, dispatchEpoch, "task_status", now())
            )
          return false
        }
        project()
        return true
      })
    },
    get dispatchEpoch(): number {
      return dispatchEpoch
    },
    bindDispatchEpoch(epoch: number): void {
      dispatchEpoch = epoch
      executionStarted = true
    },
    startLocalExecution,
    claimRemoteLease,
    retryTargetHostRef,
    capture,
    flush,
    signal: persistenceAbort.signal,
    dispose(): void {
      detachControl?.()
      detachControl = undefined
    },
    attachControl,
    /**
     * The provider session ended under the child (a cancel that retires the
     * session rather than its turn). Forget it, so nothing steers or resumes
     * a session that no longer exists; later steering waits in the durable
     * queue for the child's next turn.
     */
    async releaseSession(sessionId: string): Promise<void> {
      const child = await ownedChild()
      providerControl = undefined
      refreshControl()
      if (child.sessionId === sessionId) {
        await updateOwnedChild({ sessionId: undefined, updatedAt: now() })
      }
    },
    attachEnvironment(environment: AgentExecutionEnvironment): void {
      executionEnvironment = environment
      refreshControl()
    },
    async setWorkspace(input: { workspacePath: string; branch?: string }): Promise<void> {
      await updateOwnedChild({
        workspacePath: input.workspacePath,
        ...(input.branch ? { branch: input.branch } : {}),
        updatedAt: now(),
      })
    },
    async prepareTurnContext(): Promise<string> {
      await currentChild()
      if (turnContextPrepared) return ""
      turnContextPrepared = true
      const [run, checkpoint, trajectory, pending, attempts] = await Promise.all([
        store.getRun(input.runId),
        store.getLatestCheckpoint(childRunId),
        store.listTrajectory(input.runId),
        store.listPendingSteering(childRunId),
        store.listChildren(input.runId),
      ])
      if (!run) throw new Error(`Unknown durable AgentTeam run: ${input.runId}`)
      const decisionContext = await createDecisionLedger({
        store,
        runId: input.runId,
        leadId: input.team.leadId,
        now,
      }).context()
      await updateOwnedChild({
        decisionVersion: run.decisionVersion,
        updatedAt: now(),
      })
      const relevant = await Promise.all(
        trajectory
          .filter(
            (event) =>
              (!event.childRunId || event.childRunId === childRunId) &&
              event.sequence > (checkpoint?.trajectorySequence ?? 0)
          )
          .slice(-24)
          .map(async (event) => {
            const content = event.contentHash
              ? await store.getContent(event.contentHash)
              : undefined
            return {
              sequence: event.sequence,
              kind: event.kind,
              payload: event.payload,
              ...(content
                ? { content: new TextDecoder().decode(content.data).slice(0, 8192) }
                : {}),
            }
          })
      )
      const attemptHistory = attempts
        .filter((child) => child.taskId === input.taskId)
        .map((child) => ({ attempt: child.attempt, status: child.status, error: child.error }))
      const raw = [
        `Frozen objective: ${run.objective}`,
        `Recovery checkpoint: ${checkpoint?.id ?? "none"}`,
        `Attempt history: ${JSON.stringify(attemptHistory)}`,
        decisionContext
          ? `Frozen run constraints and accepted decisions — do not override them:\n${decisionContext}`
          : "",
        relevant.length > 0 ? `Relevant local trajectory: ${JSON.stringify(relevant)}` : "",
        pending.length > 0
          ? `Operator steering to apply now:\n${pending.map((item) => `- ${item.message}`).join("\n")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n")
      const redacted = redactText(raw).redacted
      if (!hasNoLeakingPii(redacted)) {
        for (const receipt of pending) {
          await store.updateSteeringReceipt(receipt.id, "rejected", now(), "pii_gate")
        }
        throw new Error("Durable AgentTeam recovery context still contains PII after redaction")
      }
      pendingSteeringIds = pending.map((receipt) => receipt.id)
      for (const receipt of pending) {
        const deliveredAt = now()
        await store.updateSteeringReceipt(receipt.id, "delivered", deliveredAt)
        await appendDispatchTrajectory({
          runId: input.runId,
          childRunId,
          kind: "steering_delivered",
          correlationId: receipt.id,
          createdAt: deliveredAt,
        })
      }
      return redacted
    },
    trackLocalStop(stopped: Promise<void>): void {
      pendingLocalStops.add(stopped)
      void stopped
        .then(
          async () => {
            pendingLocalStops.delete(stopped)
            localStopObserved = true
            // A terminal event can arrive after a transport/timeout rejection.
            if (
              executionFinished &&
              !localSettlement &&
              pendingLocalStops.size === 0 &&
              !localStopFailed
            ) {
              localSettlement = finishLocalExecution()
              await localSettlement
            }
          },
          () => {
            pendingLocalStops.delete(stopped)
            localStopFailed = true
          }
        )
        .catch(() => undefined)
    },
    async recordRemoteDisposal(
      proof: import("@cognia/agent-orchestration").StopProof
    ): Promise<void> {
      // A current-epoch receipt remains evidence when an operator stop or a
      // transport failure wins the result race. Result projection stays gated.
      const child = await ownedChild()
      if (!hasRemoteDispatch(child) || proof.kind !== "ack" || proof.epoch !== dispatchEpoch)
        throw new Error("stop_unconfirmed: remote disposal acknowledgement does not match")
      await updateOwnedChild({
        settledEpoch: dispatchEpoch,
        stop: { state: "confirmed", epoch: dispatchEpoch, requestedAt: proof.at, proof },
        updatedAt: now(),
      })
    },
    async bindLocalSidecarSession(sessionId: string): Promise<void> {
      const { getLiveSidecarSessionIds } = await import("@/lib/claude/ipc")
      const live = await getLiveSidecarSessionIds()
      if (!live?.has(sessionId)) return
      const child = await ownedChild()
      if (child.sessionId !== sessionId) return
      await updateOwnedChild({ executorRegistry: "sidecar", updatedAt: now() })
    },
    async run<T>(
      operation: (admissionSignal: AbortSignal) => Promise<T>,
      signal?: AbortSignal,
      options?: { deferExecutionStart?: boolean }
    ): Promise<T> {
      if (executionInvoked) throw new Error("Dispatch executor was already invoked")
      executionInvoked = true
      await currentChild()
      return input.coordinator.trackChildExecution(
        childRunId,
        async () => {
          try {
            return await input.coordinator.withChildAdmission(
              childRunId,
              (admissionSignal) =>
                input.coordinator.withWorkspaceLease(
                  {
                    childRunId,
                    runId: input.runId,
                    repositoryId: input.repositoryId,
                    access: input.access,
                    ...(input.fileOwnership ? { fileOwnership: input.fileOwnership } : {}),
                  },
                  async () => {
                    await currentChild()
                    if (!options?.deferExecutionStart) await startLocalExecution()
                    admissionSignal.throwIfAborted()
                    return operation(admissionSignal)
                  },
                  admissionSignal
                ),
              signal ? AbortSignal.any([signal, persistenceAbort.signal]) : persistenceAbort.signal
            )
          } finally {
            executionFinished = true
            // The operation may wrap a timeout or a transport race. Only an
            // executor's independent terminal observation can confirm its stop.
            if (pendingLocalStops.size > 0) {
              localSettlement = Promise.allSettled([...pendingLocalStops]).then(async () => {
                if (localStopObserved && !localStopFailed) await finishLocalExecution()
              })
            } else if (localStopObserved && !localStopFailed) {
              localSettlement = finishLocalExecution()
              await localSettlement
            }
            if (!localStopObserved || localStopFailed || pendingLocalStops.size > 0) {
              const child = await store.getChild(childRunId)
              if (
                executionStarted &&
                child?.attempt === attempt &&
                (child.dispatchEpoch ?? 0) === dispatchEpoch &&
                !hasRemoteDispatch(child) &&
                !childStopProof(child, now())
              )
                await store.updateChildIfCurrent(childRunId, child, {
                  stop: {
                    ...child.stop,
                    state: "unconfirmed",
                    epoch: dispatchEpoch,
                    requestedAt: child.stop?.requestedAt ?? now(),
                  },
                  updatedAt: now(),
                })
            }
          }
        },
        () => localSettlement
      )
    },

    async wait(waitingReason: string, hostRef?: string): Promise<void> {
      await flush()
      const waitingAt = now()
      try {
        const changed = await store.updateChildIfCurrent(childRunId, await currentChild(), {
          status: "queued",
          waitingReason,
          ...(hostRef ? { hostRef } : {}),
          error: undefined,
          updatedAt: waitingAt,
        })
        if (changed) await parkRun(`worker_waiting:${waitingReason}`, waitingAt)
      } finally {
        detachControl?.()
      }
    },

    checkpointPause,

    async complete(result: {
      text: string
      usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
      costUsd?: number
      commitSha?: string
      workspaceRevision?: string
      diffContent?: string
      environmentEvidence?: Array<{
        kind: import("@/types/agent/agent-team-runtime").AgentTeamEvidenceKind
        title: string
        content?: string | Uint8Array
        url?: string
        status?: "passed" | "failed" | "unknown"
        revision?: string
      }>
    }): Promise<void> {
      await flush()
      if (pendingLocalStops.size > 0)
        throw new Error("stop_unconfirmed: local executor has not ended")
      if (localStopObserved && !localStopFailed) {
        localSettlement ??= finishLocalExecution()
        await localSettlement
      }
      const child = await ownedChild()
      if (!["running", "queued"].includes(child.status)) await currentChild()
      const executorUnconfirmed =
        child.settledEpoch !== dispatchEpoch ||
        child.stop?.state !== "confirmed" ||
        child.stop.proof?.kind !== "ack" ||
        child.stop.proof.epoch !== dispatchEpoch ||
        localStopFailed
      if (executorUnconfirmed && !hasRemoteDispatch(child))
        throw new Error("stop_unconfirmed: executor disposal has not been acknowledged")
      await currentChild()
      const completedAt = now()
      if (
        [...sideEffects.values()].some(
          (effect) => effect.state === "intent" || effect.state === "unknown"
        )
      ) {
        const reason = "Cannot complete dispatch with an unsettled tool result"
        const parked = await store.updateChildIfCurrent(childRunId, child, {
          status: "needs_input",
          waitingReason: "recovery_required",
          error: reason,
          updatedAt: completedAt,
        })
        if (parked) await parkRun("uncertain_side_effect", completedAt)
        throw new Error(reason)
      }
      const safeText = redactText(result.text).redacted
      if (!hasNoLeakingPii(safeText)) {
        throw new Error("Durable AgentTeam outcome still contains PII after redaction")
      }
      const terminal = await appendDispatchTrajectory(
        {
          runId: input.runId,
          childRunId,
          kind: "model_turn_completed",
          correlationId: childRunId,
          payload: { usage: result.usage },
          createdAt: completedAt,
        },
        { data: safeText, mimeType: "text/markdown" }
      )
      const revision = result.workspaceRevision ?? result.commitSha
      await evidence.record({ kind: "activity", title: "Agent execution completed", revision })
      await evidence.record({ kind: "outcome", title: "Agent result", content: safeText, revision })
      await recordToolEvidence(revision)
      for (const item of result.environmentEvidence ?? []) {
        await evidence.record({
          ...item,
          ...(typeof item.content === "string"
            ? { content: redactText(item.content).redacted }
            : {}),
        })
      }
      if (result.diffContent) {
        await evidence.record({
          kind: "diff",
          title: "Workspace changes",
          content: redactText(result.diffContent).redacted,
          mimeType: "application/json",
          revision,
        })
      }
      if (result.commitSha) {
        await evidence.record({
          kind: "commit",
          title: result.commitSha,
          metadata: { sha: result.commitSha },
          revision,
        })
      }
      const validation = await evidence.validate({
        taskKind: input.taskKind ?? (input.access === "write" ? "code" : "general"),
        visualSupported: input.taskKind === "ui",
        revision,
        requireRevision: true,
      })
      if (!validation.complete) {
        const reason = `Evidence gate requires: ${validation.missing.join(", ")}`
        await store.updateChildIfCurrent(childRunId, await currentChild(), {
          status: "needs_input",
          error: reason,
          updatedAt: completedAt,
        })
        await parkRun("evidence_incomplete", completedAt)
        throw new Error(reason)
      }
      const checkpointEvent = await appendDispatchTrajectory({
        runId: input.runId,
        childRunId,
        kind: "checkpoint",
        correlationId: `checkpoint:${childRunId}`,
        payload: { replay: "safe", terminalSequence: terminal.sequence },
        createdAt: completedAt,
      })
      await checkpointDispatch({
        trajectorySequence: checkpointEvent.sequence,
        replay: "safe",
        sideEffects: [...sideEffects.values()],
        ...(result.commitSha ? { workspaceCommit: result.commitSha } : {}),
      })
      const completed = await store.updateChildIfCurrent(childRunId, await currentChild(), {
        status: "completed",
        // Worker disposal receipts are dormant in WP1. Keep the result and
        // existing recovery projection explicit without certifying settlement.
        waitingReason: executorUnconfirmed ? "stop_unconfirmed" : undefined,
        ...(executorUnconfirmed
          ? {
              stop: {
                state: "unconfirmed" as const,
                epoch: dispatchEpoch,
                requestedAt: completedAt,
              },
            }
          : {}),
        completedAt,
        updatedAt: completedAt,
        resourceUsage: {
          promptTokens: result.usage?.promptTokens ?? 0,
          completionTokens: result.usage?.completionTokens ?? 0,
          totalTokens: result.usage?.totalTokens ?? 0,
          ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
          wallTimeMs: Math.max(0, completedAt - startedAt),
          toolTimeMs,
          attempts: attempt,
          failures: previousFailures,
        },
      })
      if (!completed) throw new Error("Child control changed during completion")
      // The total goes to the durable record, then to the execution run's
      // remote-safe snapshot, which is the half a paired device can read.
      await reportTeamRunUsage(
        input.runId,
        await recordRunUsage(store, input.runId, completedAt),
        completedAt
      )
      for (const receiptId of pendingSteeringIds) {
        await store.updateSteeringReceipt(receiptId, "applied", completedAt)
      }
      detachControl?.()
    },

    async fail(error: unknown): Promise<void> {
      await writes
      try {
        const current = await store.getChild(childRunId)
        if (!current) return
        if (current.attempt !== attempt || (current.dispatchEpoch ?? 0) !== dispatchEpoch) {
          await store.appendTrajectory(
            rejectedEpochEvent(current, dispatchEpoch, "failure_projection", now())
          )
          return
        }
        if (["completed", "cancelled", "terminated", "paused"].includes(current.status)) return
        if (
          current.status === "queued" &&
          current.startedAt !== undefined &&
          current.stop?.state === "confirmed"
        )
          return
        if (current.status === "needs_input") {
          const eligibility = await assessStoredTaskRecovery(
            store,
            input.runId,
            input.taskId,
            now()
          )
          if (!eligibility.eligible) await parkRun(eligibility.reason, now())
          return
        }
        const failedAt = now()
        const message = redactText(error instanceof Error ? error.message : String(error)).redacted
        const event = await appendDispatchTrajectory({
          runId: input.runId,
          childRunId,
          kind: "child_failed",
          correlationId: childRunId,
          payload: { error: message },
          createdAt: failedAt,
        })
        const effects = [...sideEffects.values()].map((effect) =>
          effect.state === "intent" ? { ...effect, state: "unknown" as const } : effect
        )
        const replayUnsafe =
          persistenceAbort.signal.aborted ||
          (await hasUnsafeRemoteHistory()) ||
          effects.some((effect) => effect.state === "unknown" && effect.replay !== "safe")
        await checkpointDispatch({
          trajectorySequence: event.sequence,
          replay: replayUnsafe ? "needs_input" : "safe",
          sideEffects: effects,
        })
        const eligibility = await assessStoredTaskRecovery(store, input.runId, input.taskId, now())
        const needsInput = !eligibility.eligible
        const latest = await store.getChild(childRunId)
        if (
          !latest ||
          latest.attempt !== attempt ||
          (latest.dispatchEpoch ?? 0) !== dispatchEpoch ||
          ["completed", "cancelled", "terminated", "paused", "needs_input"].includes(latest.status)
        )
          return
        await store.updateChildIfCurrent(childRunId, latest, {
          status: needsInput ? "needs_input" : "failed",
          ...(!eligibility.eligible &&
          eligibility.reason === "stop_unconfirmed" &&
          !childStopProof(latest, now())
            ? {
                stop: {
                  state: "unconfirmed" as const,
                  epoch: dispatchEpoch,
                  requestedAt: failedAt,
                },
              }
            : {}),
          waitingReason: needsInput ? "recovery_required" : undefined,
          error: message,
          completedAt: failedAt,
          updatedAt: failedAt,
          resourceUsage: {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            wallTimeMs: Math.max(0, failedAt - startedAt),
            toolTimeMs,
            attempts: attempt,
            failures: previousFailures + 1,
          },
        })
        if (needsInput) {
          await parkRun(
            !eligibility.eligible ? eligibility.reason : "uncertain_side_effect",
            failedAt
          )
        }
        await reportTeamRunUsage(
          input.runId,
          await recordRunUsage(store, input.runId, failedAt),
          failedAt
        )
      } finally {
        detachControl?.()
        detachControl = undefined
      }
    },
  }
}

export type DurableDispatch = Awaited<ReturnType<typeof beginDurableDispatch>>
