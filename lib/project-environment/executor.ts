import {
  runPersonalEgressOperation,
  PersonalEgressDeniedError,
} from "@/lib/execution/personal-egress"
import type { PersonalCredentialContext } from "@/lib/execution/personal-credential"
import {
  assertBootstrapEnvironment,
  prepareBootstrapExecution,
  BootstrapAgentValidationError,
  type BootstrapValidationCode,
} from "./bootstrap-agent"
import { resolveBootstrapSystemPrompt } from "./bootstrap-prompts"
import { isTauri } from "@/lib/tauri"
import { ensureExecutionPortLease } from "@/lib/task-workspace/execution-port-lease"
import { sha256Hex } from "@/lib/data/crypto"
import { readWorkspaceFile, statWorkspaceFile } from "@/lib/files/workspace-fs"
import {
  getProjectEnvironment,
  updateProjectEnvironmentInitialization,
} from "@/lib/db/project-environments"
import type {
  ProjectEnvironment,
  ProjectEnvironmentAction,
  ProjectEnvironmentOs,
  ProjectEnvironmentPolicy,
  ProjectEnvironmentScript,
} from "@/types/project-environment"
import {
  MISE_STEP_FALLBACK,
  miseStepNotices,
  planMiseStep,
  type MiseStepNotice,
  type MiseStepPlan,
  type MiseStepPlanDeps,
} from "@/lib/workspace/mise-step"
import {
  captureEnvironmentHostRoute,
  ExecutionRouteChangedError,
  type EnvironmentHostRoute,
} from "./host-route"
import {
  computeSetupFingerprint,
  effectiveSetupReuse,
  latestSetupRecord,
  normalizeExecutionRoot,
  recordAllowsReuse,
  setupOutputsPresent,
  setupSignature,
  type SetupReuseIo,
} from "./setup-reuse"

export interface ProjectEnvironmentExecutionResult {
  success: boolean
  bypassed: boolean
  exitCode?: number
  stdout?: string
  stderr?: string
  /** True when the Host truncated stdout at its capture limit. */
  stdoutTruncated?: boolean
  /** True when the Host truncated stderr at its capture limit. */
  stderrTruncated?: boolean
  /** True when execution stopped due to timeout. */
  timedOut?: boolean
  /** True when execution was cancelled via `AbortSignal` / Host cancel. */
  cancelled?: boolean
  error?: string
  bootstrapValidationCode?: BootstrapValidationCode
  /** Setup was skipped: the last setup in this root succeeded with the same fingerprint. */
  reused?: boolean
  /** Setup was satisfied by an identical one already running in this root. */
  joined?: boolean
  /** What setup chose not to do and why, e.g. a `mise install` it skipped. */
  notices?: MiseStepNotice[]
}

interface NativeEnvironmentResult {
  stdout: string
  stderr: string
  exit_code: number | null
  timed_out: boolean
  cancelled?: boolean
  stdout_truncated?: boolean
  stderr_truncated?: boolean
}

export interface ExecuteProjectEnvironmentInput {
  environment: ProjectEnvironment
  /** Host-held producer; never read from script arguments. */
  credentialContext?: PersonalCredentialContext
  executionRoot: string
  scope: "local" | "managedWorktree"
  surface: "interactive" | "scheduled"
  actionId?: string
  bypassOnFailure?: boolean
  timeoutSecs?: number
  /** Run setup even when an earlier one could be reused or joined (the manual "Run setup"). */
  force?: boolean
  /** Cancel an in-flight setup or action on the execution Host. */
  signal?: AbortSignal
}

export function resolveEnvironmentScript(
  script: ProjectEnvironmentScript,
  os: ProjectEnvironmentOs
): string {
  return script.byOs?.[os]?.trim() || script.default.trim()
}

function selectAction(
  environment: ProjectEnvironment,
  actionId: string | undefined
): ProjectEnvironmentAction | undefined {
  if (!actionId) return undefined
  const action = environment.actions.find((candidate) => candidate.id === actionId)
  if (!action) throw new Error(`Unknown project environment action: ${actionId}`)
  return action
}

function createUniqueId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID()
  }
  return `env-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function cancelledResult(isAction: boolean): ProjectEnvironmentExecutionResult {
  return {
    success: false,
    bypassed: false,
    cancelled: true,
    error: isAction
      ? "Project environment action was cancelled"
      : "Project environment setup was cancelled",
  }
}

/** Runs setup or a reusable action without ever loading secret values in JS. */
export async function executeProjectEnvironment(
  input: ExecuteProjectEnvironmentInput
): Promise<ProjectEnvironmentExecutionResult> {
  if (!input.environment.isEnabled) {
    return { success: true, bypassed: false }
  }
  if (input.surface === "scheduled" && input.bypassOnFailure) {
    return {
      success: false,
      bypassed: false,
      error: "Scheduled project environment setup cannot be bypassed",
    }
  }

  const action = selectAction(input.environment, input.actionId)
  const script = action?.script ?? input.environment.setupScript
  if (input.signal?.aborted) {
    return cancelledResult(Boolean(action))
  }

  const route = captureEnvironmentHostRoute()
  try {
    // `mise install` belongs to setup, never to an action (ADR-0147, 2026-11-08
    // amendment): it runs ahead of the setup script when the user accepted it
    // for this root's exact mise files.
    const mise: MiseStepPlan = action
      ? { step: null, notices: [] }
      : await planMiseForRoute(input, route)
    if (
      !(input.environment.bootstrapAgent?.enabled && !action) &&
      !mise.step &&
      !hasScript(script)
    ) {
      return {
        success: true,
        bypassed: false,
        ...(mise.notices.length ? { notices: mise.notices } : {}),
      }
    }
    const policy =
      input.environment.policy ??
      (isTauri()
        ? { network: "on" as const, requireSandbox: false }
        : { network: "off" as const, requireSandbox: true })

    if (action)
      return await runScript(input, script, policy, route, { recordInitialization: false })
    return await runSetupCoalesced(input, policy, route, mise)
  } catch (cause) {
    if (cause instanceof ExecutionRouteChangedError) {
      return { success: false, bypassed: false, error: cause.message }
    }
    throw cause
  } finally {
    route.release()
  }
}

function hasScript(script: ProjectEnvironmentScript): boolean {
  return Boolean(
    script.default.trim() || Object.values(script.byOs ?? {}).some((value) => value?.trim())
  )
}

/** Production lookups for the mise step: this root's files, the workspace row, its trust. */
const miseStepDeps: MiseStepPlanDeps = {
  readFile: (root, relPath) => readWorkspaceFile(root, relPath),
  sha256Hex,
  acceptedIds: async (projectId) => {
    const { getAllProjects } = await import("@/lib/db/projects")
    const project = (await getAllProjects()).find((candidate) => candidate.id === projectId)
    return project ? (project.workspaceProvisioning?.accepted ?? []) : null
  },
  restricted: async (projectId) => {
    const [{ getAllProjects }, { isWorkspaceRestricted }, { getSettings }] = await Promise.all([
      import("@/lib/db/projects"),
      import("@/lib/workspace/trust-gate"),
      import("@/lib/db/settings"),
    ])
    const project = (await getAllProjects()).find((candidate) => candidate.id === projectId)
    if (!project) return true
    const settings = await getSettings().catch(() => undefined)
    return isWorkspaceRestricted(project, {
      enabled: settings?.workspaceTrust?.enabled !== false,
      onWeb: !isTauri(),
    })
  },
}

function miseStepDepsFor(route: EnvironmentHostRoute): MiseStepPlanDeps {
  return {
    ...miseStepDeps,
    readFile: async (root, relPath) => {
      route.assertCurrent()
      return readWorkspaceFile(root, relPath, undefined, route.transport)
    },
  }
}

async function planMiseForRoute(
  input: ExecuteProjectEnvironmentInput,
  route: EnvironmentHostRoute
): Promise<MiseStepPlan> {
  return planMiseStep(
    { executionRoot: input.executionRoot, projectId: input.environment.projectId },
    miseStepDepsFor(route)
  ).catch((cause) => {
    if (cause instanceof ExecutionRouteChangedError) throw cause
    return { step: null, notices: [] }
  })
}

/** The environment's own policy, or the host default applied when it has none. */
type HostExecutionPolicy =
  ProjectEnvironmentPolicy | { network: "on" | "off"; requireSandbox: boolean }

// ---------------------------------------------------------------------------
// Setup: one at a time per root, joined when identical, skipped when unchanged
// ---------------------------------------------------------------------------

interface SetupFlight {
  environmentId: string
  scope: ExecuteProjectEnvironmentInput["scope"]
  hostKey: string
  signature: string
  /** Fingerprint verified to hold both before and after this flight succeeded. */
  completedFingerprint?: string
  promise: Promise<ProjectEnvironmentExecutionResult>
}

/**
 * Setups in flight, keyed by execution Host and normalized directory root
 * (F3, F7). Two setups in the same directory on the same Host — even from
 * different environment profiles, scopes, or path aliases — serialize rather
 * than racing installers in the same directory. The second request joins only
 * after re-verifying the current mise plan, setup-reuse fingerprint and
 * outputs (F1).
 */
const setupFlights = new Map<string, SetupFlight>()

function setupFlightKey(hostKey: string, executionRoot: string): string {
  return [hostKey, normalizeExecutionRoot(executionRoot)].join("\u0000")
}

function setupSignatureWithMise(
  environment: ProjectEnvironment,
  hostKey: string,
  mise: MiseStepPlan
): string {
  return (
    setupSignature(environment, hostKey) +
    (mise.step ? `\u0000mise:isolated:${mise.step.digest}` : "")
  )
}

async function waitForFlight(
  promise: Promise<ProjectEnvironmentExecutionResult>,
  signal?: AbortSignal
): Promise<
  { settled: true; outcome: ProjectEnvironmentExecutionResult | null } | { settled: false }
> {
  if (!signal) {
    return { settled: true, outcome: await promise.catch(() => null) }
  }
  if (signal.aborted) return { settled: false }
  return new Promise((resolve) => {
    const onAbort = () => resolve({ settled: false })
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (outcome) => {
        signal.removeEventListener("abort", onAbort)
        resolve({ settled: true, outcome })
      },
      () => {
        signal.removeEventListener("abort", onAbort)
        resolve({ settled: true, outcome: null })
      }
    )
  })
}

async function runSetupCoalesced(
  input: ExecuteProjectEnvironmentInput,
  policy: HostExecutionPolicy,
  route: EnvironmentHostRoute,
  initialMise: MiseStepPlan
): Promise<ProjectEnvironmentExecutionResult> {
  const key = setupFlightKey(route.hostKey, input.executionRoot)
  // The mise files are part of what this setup does: a different accepted
  // content is a different setup, for joining and for reuse alike.
  let currentMise = initialMise
  let signature = setupSignatureWithMise(input.environment, route.hostKey, currentMise)
  const reuseIo = setupReuseIoFor(route)

  for (let inFlight = setupFlights.get(key); inFlight; inFlight = setupFlights.get(key)) {
    const waited = await waitForFlight(inFlight.promise, input.signal)
    if (!waited.settled) {
      return cancelledResult(false)
    }
    route.assertCurrent()
    // Re-read mise plan and reuse inputs after waiting (F1): a lockfile or
    // mise edit while the prior flight ran invalidates joining.
    currentMise = await planMiseForRoute(input, route)
    signature = setupSignatureWithMise(input.environment, route.hostKey, currentMise)
    const outcome = waited.outcome

    // Joined only when the finished setup did what this request would have
    // done, on the same Host, and it worked. A failure or cancellation is not
    // shared: this request makes its own attempt under its own surface's rules.
    // A forced or bootstrap run never joins.
    if (
      !input.force &&
      !input.environment.bootstrapAgent?.enabled &&
      inFlight.environmentId === input.environment.id &&
      inFlight.scope === input.scope &&
      inFlight.hostKey === route.hostKey &&
      inFlight.signature === signature &&
      outcome?.success &&
      !outcome.bypassed &&
      !outcome.cancelled
    ) {
      let reuse: ReturnType<typeof effectiveSetupReuse> | undefined
      try {
        reuse = withMiseInputs(effectiveSetupReuse(input.environment), currentMise)
      } catch {
        reuse = undefined
      }
      if (reuse === null) {
        return {
          success: true,
          bypassed: false,
          exitCode: outcome.exitCode,
          joined: true,
          ...(currentMise.notices.length ? { notices: currentMise.notices } : {}),
        }
      }
      if (reuse && inFlight.completedFingerprint) {
        const freshFingerprint = await computeSetupFingerprint(
          signature,
          input.executionRoot,
          reuse,
          reuseIo
        ).catch((cause) => {
          if (cause instanceof ExecutionRouteChangedError) throw cause
          return undefined
        })
        const outputsPresent = await setupOutputsPresent(input.executionRoot, reuse, reuseIo).catch(
          (cause) => {
            if (cause instanceof ExecutionRouteChangedError) throw cause
            return false
          }
        )
        if (
          freshFingerprint &&
          freshFingerprint === inFlight.completedFingerprint &&
          outputsPresent
        ) {
          return {
            success: true,
            bypassed: false,
            exitCode: outcome.exitCode,
            joined: true,
            ...(currentMise.notices.length ? { notices: currentMise.notices } : {}),
          }
        }
      }
    }
  }

  if (input.signal?.aborted) {
    return cancelledResult(false)
  }

  // No await between the empty lookup above and this set, so no other caller
  // can slip a second flight in for the same key.
  const flight: SetupFlight = {
    environmentId: input.environment.id,
    scope: input.scope,
    hostKey: route.hostKey,
    signature,
    promise: undefined as unknown as Promise<ProjectEnvironmentExecutionResult>,
  }
  const promise = runSetupOnce(input, policy, route, signature, currentMise, flight)
  flight.promise = promise
  setupFlights.set(key, flight)
  try {
    return await promise
  } finally {
    if (setupFlights.get(key) === flight) setupFlights.delete(key)
  }
}

async function runSetupOnce(
  input: ExecuteProjectEnvironmentInput,
  policy: HostExecutionPolicy,
  route: EnvironmentHostRoute,
  signature: string,
  mise: MiseStepPlan,
  flight: SetupFlight
): Promise<ProjectEnvironmentExecutionResult> {
  let reuse: ReturnType<typeof effectiveSetupReuse>
  try {
    assertBootstrapEnvironment(input.environment)
    reuse = withMiseInputs(effectiveSetupReuse(input.environment), mise)
  } catch (validationError) {
    // Invalid imported config must reach the normal recorded failure path,
    // even if it carries a matching historic fingerprint.
    return runScript(input, input.environment.setupScript, policy, route, {
      recordInitialization: true,
      validationError,
      mise,
    })
  }
  const bootstrap = input.environment.bootstrapAgent?.enabled === true
  const reuseIo = setupReuseIoFor(route)
  let bootstrapInvalidated = false
  let fingerprint: string | undefined
  if (reuse) {
    fingerprint = await computeSetupFingerprint(
      signature,
      input.executionRoot,
      reuse,
      reuseIo
    ).catch((cause) => {
      if (cause instanceof ExecutionRouteChangedError) throw cause
      return undefined
    })
    if ((fingerprint || bootstrap) && !input.force) {
      // The caller's copy of the environment may predate the last setup (a
      // settings draft, a row read before a concurrent run finished), so the
      // decision reads the stored history.
      const stored =
        (await getProjectEnvironment(input.environment.id).catch(() => undefined)) ??
        input.environment
      const record = latestSetupRecord(stored, input.executionRoot, input.scope, route.hostKey)
      const outputsPresent = await setupOutputsPresent(input.executionRoot, reuse, reuseIo).catch(
        (cause) => {
          if (cause instanceof ExecutionRouteChangedError) throw cause
          return false
        }
      )
      if (bootstrap) {
        bootstrapInvalidated =
          !fingerprint ||
          !outputsPresent ||
          (record !== null && record.status !== "succeeded") ||
          (record?.status === "succeeded" &&
            (record.fingerprint !== fingerprint || record.hostKey !== route.hostKey))
      }
      if (
        !bootstrap &&
        route.cacheable &&
        fingerprint &&
        recordAllowsReuse(record, fingerprint, route.hostKey) &&
        outputsPresent
      ) {
        flight.completedFingerprint = fingerprint
        // Not written to the history: the history records setups that ran, and
        // a reuse on every turn would push those out of its 100-entry window.
        return {
          success: true,
          bypassed: false,
          exitCode: record?.exitCode,
          reused: true,
          ...(mise.notices.length ? { notices: mise.notices } : {}),
        }
      }
    }
  }
  return runScript(
    bootstrapInvalidated ? { ...input, force: true } : input,
    input.environment.setupScript,
    policy,
    route,
    {
      recordInitialization: true,
      ...(fingerprint ? { fingerprint } : {}),
      reuse,
      signature,
      mise,
      flight,
    }
  )
}

/**
 * A setup that installs with mise is fingerprinted over the mise files too, so
 * editing `mise.toml` or its lockfile runs setup again even when the setup's
 * own declared inputs did not change. Reuse off stays off.
 */
function withMiseInputs(
  reuse: ReturnType<typeof effectiveSetupReuse>,
  mise: MiseStepPlan
): ReturnType<typeof effectiveSetupReuse> {
  if (!reuse || !mise.step) return reuse
  return { ...reuse, inputs: [...new Set([...reuse.inputs, ...mise.step.files])].sort() }
}

function setupReuseIoFor(route: EnvironmentHostRoute): SetupReuseIo {
  return {
    readFile: async (root, relPath) => {
      route.assertCurrent()
      return readWorkspaceFile(root, relPath, undefined, route.transport)
    },
    statFile: async (root, relPath) => {
      route.assertCurrent()
      const stat = await statWorkspaceFile(root, relPath, route.transport)
      return { exists: stat.exists, size: stat.size, mtimeMs: stat.mtimeMs ?? undefined }
    },
    sha256Hex,
  }
}

// ---------------------------------------------------------------------------
// The host call
// ---------------------------------------------------------------------------

class MiseStepFailedError extends Error {
  constructor(
    message: string,
    readonly output: NativeEnvironmentResult
  ) {
    super(message)
    this.name = "MiseStepFailedError"
  }
}

async function invokeHostExecute(
  route: EnvironmentHostRoute,
  payload: Record<string, unknown>,
  signal: AbortSignal | undefined
): Promise<NativeEnvironmentResult> {
  if (signal?.aborted) {
    return { stdout: "", stderr: "", exit_code: null, timed_out: false, cancelled: true }
  }
  route.assertCurrent()
  const operationId = signal ? createUniqueId() : undefined
  const requestPayload = operationId ? { ...payload, operationId } : payload
  let cancelSent = false
  const sendCancel = () => {
    if (!operationId || cancelSent) return
    cancelSent = true
    void route.transport.call("project_environment_cancel", { operationId }).catch(() => undefined)
  }
  if (signal) {
    signal.addEventListener("abort", sendCancel, { once: true })
  }
  try {
    const result = await route.transport.call<NativeEnvironmentResult>(
      "project_environment_execute",
      requestPayload
    )
    if (signal?.aborted && !result.cancelled && result.exit_code !== 0) {
      return { ...result, cancelled: true }
    }
    return result
  } finally {
    if (signal) {
      signal.removeEventListener("abort", sendCancel)
    }
  }
}

async function runScript(
  input: ExecuteProjectEnvironmentInput,
  script: ProjectEnvironmentScript,
  policy: HostExecutionPolicy,
  route: EnvironmentHostRoute,
  options: {
    recordInitialization: boolean
    fingerprint?: string
    reuse?: ReturnType<typeof effectiveSetupReuse>
    signature?: string
    validationError?: unknown
    mise?: MiseStepPlan
    flight?: SetupFlight
  }
): Promise<ProjectEnvironmentExecutionResult> {
  const startedAt = Date.now()
  const attemptId = createUniqueId()
  if (options.recordInitialization) {
    await updateProjectEnvironmentInitialization(
      input.environment.id,
      {
        status: "running",
        scope: input.scope,
        executionRoot: input.executionRoot,
        hostKey: route.hostKey,
        attemptId,
        startedAt,
      },
      startedAt
    )
  }

  let portLeaseFailed = false
  try {
    if (options.validationError !== undefined) throw options.validationError
    if (input.signal?.aborted) {
      const result: NativeEnvironmentResult = {
        stdout: "",
        stderr: "",
        exit_code: null,
        timed_out: false,
        cancelled: true,
      }
      return await finishNativeResult(
        input,
        route,
        options,
        startedAt,
        attemptId,
        result,
        [],
        false
      )
    }
    const bootstrapAgent =
      options.recordInitialization && input.environment.bootstrapAgent?.enabled
        ? input.environment.bootstrapAgent
        : undefined
    const bootstrap = bootstrapAgent
      ? prepareBootstrapExecution(
          input.environment,
          input.force === true,
          await resolveBootstrapSystemPrompt(bootstrapAgent, input.environment.projectId)
        )
      : undefined
    route.assertCurrent()
    if (route.isCurrent()) {
      try {
        await ensureExecutionPortLease({
          cwd: input.executionRoot,
          projectId: input.environment.projectId,
        })
      } catch (cause) {
        portLeaseFailed = true
        throw cause
      }
      route.assertCurrent()
    }
    const notices: MiseStepNotice[] = [...(options.mise?.notices ?? [])]
    let miseSkipped = false
    if (options.mise?.step) {
      // The Host stages the snapshot under the setup's existing execution
      // policy. Only the regular setup script receives project variables.
      const miseInstall = options.mise.step.install
      const installed = await runPersonalEgressOperation(
        input.credentialContext ?? {},
        () =>
          invokeHostExecute(
            route,
            {
              script: { default: MISE_STEP_FALLBACK, mise: miseInstall },
              cwd: input.executionRoot,
              variables: {},
              keyringReferences: [],
              policy,
              timeoutSecs: input.timeoutSecs,
            },
            input.signal
          ),
        true
      )
      if (installed.cancelled) {
        return await finishNativeResult(
          input,
          route,
          options,
          startedAt,
          attemptId,
          installed,
          notices,
          miseSkipped
        )
      }
      if (installed.timed_out) {
        throw new MiseStepFailedError("mise install timed out", installed)
      }
      if (installed.exit_code !== 0) {
        throw new MiseStepFailedError(
          `mise install exited with code ${installed.exit_code ?? "unknown"}`,
          installed
        )
      }
      for (const notice of miseStepNotices(installed.stdout)) {
        miseSkipped = true
        if (!notices.includes(notice)) notices.push(notice)
      }
    }
    const result =
      bootstrap || hasScript(script)
        ? await runPersonalEgressOperation(
            input.credentialContext ?? {},
            () =>
              invokeHostExecute(
                route,
                {
                  script: bootstrap?.script ?? script,
                  cwd: input.executionRoot,
                  variables: bootstrap?.variables ?? input.environment.variables,
                  keyringReferences: input.environment.keyringReferences,
                  policy,
                  // The CLI must retain its configured budget plus time to reap tool groups.
                  timeoutSecs: bootstrap
                    ? Math.max(input.timeoutSecs ?? 0, bootstrap.timeoutSecs)
                    : input.timeoutSecs,
                },
                input.signal
              ),
            true
          )
        : // A setup that is only the mise step has nothing more to run.
          { stdout: "", stderr: "", exit_code: 0, timed_out: false }
    return await finishNativeResult(
      input,
      route,
      options,
      startedAt,
      attemptId,
      result,
      notices,
      miseSkipped
    )
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause)
    const miseOutput = cause instanceof MiseStepFailedError ? cause.output : undefined
    const routeChanged = cause instanceof ExecutionRouteChangedError
    const bypassed =
      !(cause instanceof PersonalEgressDeniedError) &&
      !portLeaseFailed &&
      !routeChanged &&
      input.surface === "interactive" &&
      input.bypassOnFailure === true
    if (options.recordInitialization) {
      const completedAt = Date.now()
      await updateProjectEnvironmentInitialization(
        input.environment.id,
        {
          status: bypassed ? "bypassed" : "failed",
          scope: input.scope,
          executionRoot: input.executionRoot,
          hostKey: route.hostKey,
          attemptId,
          startedAt,
          completedAt,
          ...(miseOutput?.exit_code != null ? { exitCode: miseOutput.exit_code } : {}),
          error,
        },
        completedAt
      )
    }
    return {
      success: bypassed,
      bypassed,
      error,
      ...(miseOutput
        ? {
            exitCode: miseOutput.exit_code ?? undefined,
            stdout: miseOutput.stdout || undefined,
            stderr: miseOutput.stderr || undefined,
            ...(miseOutput.stdout_truncated ? { stdoutTruncated: true } : {}),
            ...(miseOutput.stderr_truncated ? { stderrTruncated: true } : {}),
            ...(miseOutput.timed_out ? { timedOut: true } : {}),
          }
        : {}),
      ...(cause instanceof BootstrapAgentValidationError
        ? { bootstrapValidationCode: cause.code }
        : {}),
    }
  }
}

async function finishNativeResult(
  input: ExecuteProjectEnvironmentInput,
  route: EnvironmentHostRoute,
  options: {
    recordInitialization: boolean
    fingerprint?: string
    reuse?: ReturnType<typeof effectiveSetupReuse>
    signature?: string
    flight?: SetupFlight
  },
  startedAt: number,
  attemptId: string,
  result: NativeEnvironmentResult,
  notices: MiseStepNotice[],
  miseSkipped: boolean
): Promise<ProjectEnvironmentExecutionResult> {
  const cancelled = Boolean(result.cancelled)
  const timedOut = Boolean(result.timed_out)
  const success = !cancelled && !timedOut && result.exit_code === 0
  const isAction = !options.recordInitialization
  const error = cancelled
    ? isAction
      ? "Project environment action was cancelled"
      : "Project environment setup was cancelled"
    : timedOut
      ? isAction
        ? "Project environment action timed out"
        : "Project environment setup timed out"
      : success
        ? undefined
        : `Project environment setup exited with code ${result.exit_code ?? "unknown"}`
  const bypassed =
    !success && !cancelled && input.surface === "interactive" && input.bypassOnFailure === true

  let verifiedFingerprint: string | undefined
  if (
    success &&
    !miseSkipped &&
    route.cacheable &&
    options.fingerprint &&
    options.reuse &&
    options.signature
  ) {
    // Re-hash declared inputs after the script finishes (F1): if a lockfile or
    // manifest changed mid-run, do not stamp a reuse fingerprint for the stale
    // pre-run snapshot.
    const postFingerprint = await computeSetupFingerprint(
      options.signature,
      input.executionRoot,
      options.reuse,
      setupReuseIoFor(route)
    ).catch(() => undefined)
    if (postFingerprint === options.fingerprint) {
      verifiedFingerprint = postFingerprint
      if (options.flight) {
        options.flight.completedFingerprint = verifiedFingerprint
      }
    }
  }

  if (options.recordInitialization) {
    const completedAt = Date.now()
    await updateProjectEnvironmentInitialization(
      input.environment.id,
      {
        status: cancelled ? "cancelled" : bypassed ? "bypassed" : success ? "succeeded" : "failed",
        scope: input.scope,
        executionRoot: input.executionRoot,
        hostKey: route.hostKey,
        attemptId,
        startedAt,
        completedAt,
        exitCode: result.exit_code ?? undefined,
        error,
        // Only a real, stable success on a named Host vouches for skipping later setup.
        ...(verifiedFingerprint ? { fingerprint: verifiedFingerprint } : {}),
        ...(notices.length ? { notices } : {}),
      },
      completedAt
    )
  }

  return {
    success: success || bypassed,
    bypassed,
    exitCode: result.exit_code ?? undefined,
    stdout: result.stdout || undefined,
    stderr: result.stderr || undefined,
    ...(result.stdout_truncated ? { stdoutTruncated: true } : {}),
    ...(result.stderr_truncated ? { stderrTruncated: true } : {}),
    ...(timedOut ? { timedOut: true } : {}),
    ...(cancelled ? { cancelled: true } : {}),
    error,
    ...(notices.length ? { notices } : {}),
  }
}
