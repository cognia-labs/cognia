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
import { isTauri, transport } from "@/lib/tauri"
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
  computeSetupFingerprint,
  effectiveSetupReuse,
  latestSetupRecord,
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
  // `mise install` belongs to setup, never to an action (ADR-0147, 2026-11-08
  // amendment): it runs ahead of the setup script when the user accepted it
  // for this root's exact mise files.
  const mise: MiseStepPlan = action
    ? { step: null, notices: [] }
    : await planMiseStep(
        { executionRoot: input.executionRoot, projectId: input.environment.projectId },
        miseStepDeps
      ).catch(() => ({ step: null, notices: [] }))
  if (!(input.environment.bootstrapAgent?.enabled && !action) && !mise.step && !hasScript(script)) {
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

  if (action) return runScript(input, script, policy, { recordInitialization: false })
  return runSetupCoalesced(input, policy, mise)
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

/** The environment's own policy, or the host default applied when it has none. */
type HostExecutionPolicy =
  ProjectEnvironmentPolicy | { network: "on" | "off"; requireSandbox: boolean }

// ---------------------------------------------------------------------------
// Setup: one at a time per root, joined when identical, skipped when unchanged
// ---------------------------------------------------------------------------

interface SetupFlight {
  signature: string
  promise: Promise<ProjectEnvironmentExecutionResult>
}

/**
 * Setups in flight, keyed by environment, scope and root. Two setups in the
 * same root at once (a chat turn and a scheduled fire, or a prewarm and the
 * fire it prepared for) would run the same installer twice into the same
 * directory, racing each other. The second request instead waits for the
 * first and, when it asked for the same thing and that succeeded, takes its
 * result.
 */
const setupFlights = new Map<string, SetupFlight>()

function setupFlightKey(input: ExecuteProjectEnvironmentInput): string {
  return [input.environment.id, input.scope, input.executionRoot].join("\u0000")
}

async function runSetupCoalesced(
  input: ExecuteProjectEnvironmentInput,
  policy: HostExecutionPolicy,
  mise: MiseStepPlan
): Promise<ProjectEnvironmentExecutionResult> {
  const key = setupFlightKey(input)
  // The mise files are part of what this setup does: a different accepted
  // content is a different setup, for joining and for reuse alike.
  const signature =
    setupSignature(input.environment) + (mise.step ? `\u0000mise:isolated:${mise.step.digest}` : "")
  for (let inFlight = setupFlights.get(key); inFlight; inFlight = setupFlights.get(key)) {
    const outcome = await inFlight.promise.catch(() => null)
    // Joined only when the finished setup did what this request would have
    // done and it worked. A failure is not shared: this request makes its own
    // attempt, under its own surface's bypass rules. A forced run never joins.
    if (
      !input.force &&
      !input.environment.bootstrapAgent?.enabled &&
      inFlight.signature === signature &&
      outcome?.success &&
      !outcome.bypassed
    ) {
      return { success: true, bypassed: false, exitCode: outcome.exitCode, joined: true }
    }
  }
  // No await between the empty lookup above and this set, so no other caller
  // can slip a second flight in for the same key.
  const promise = runSetupOnce(input, policy, signature, mise)
  setupFlights.set(key, { signature, promise })
  try {
    return await promise
  } finally {
    if (setupFlights.get(key)?.promise === promise) setupFlights.delete(key)
  }
}

async function runSetupOnce(
  input: ExecuteProjectEnvironmentInput,
  policy: HostExecutionPolicy,
  signature: string,
  mise: MiseStepPlan
): Promise<ProjectEnvironmentExecutionResult> {
  let reuse: ReturnType<typeof effectiveSetupReuse>
  try {
    assertBootstrapEnvironment(input.environment)
    reuse = withMiseInputs(effectiveSetupReuse(input.environment), mise)
  } catch (validationError) {
    // Invalid imported config must reach the normal recorded failure path,
    // even if it carries a matching historic fingerprint.
    return runScript(input, input.environment.setupScript, policy, {
      recordInitialization: true,
      validationError,
      mise,
    })
  }
  const bootstrap = input.environment.bootstrapAgent?.enabled === true
  let bootstrapInvalidated = false
  let fingerprint: string | undefined
  if (reuse) {
    fingerprint = await computeSetupFingerprint(
      signature,
      input.executionRoot,
      reuse,
      setupReuseIo
    ).catch(() => undefined)
    if ((fingerprint || bootstrap) && !input.force) {
      // The caller's copy of the environment may predate the last setup (a
      // settings draft, a row read before a concurrent run finished), so the
      // decision reads the stored history.
      const stored =
        (await getProjectEnvironment(input.environment.id).catch(() => undefined)) ??
        input.environment
      const record = latestSetupRecord(stored, input.executionRoot, input.scope)
      const outputsPresent = await setupOutputsPresent(
        input.executionRoot,
        reuse,
        setupReuseIo
      ).catch(() => false)
      if (bootstrap) {
        bootstrapInvalidated =
          !fingerprint ||
          !outputsPresent ||
          (record?.status === "succeeded" && record.fingerprint !== fingerprint)
      }
      if (!bootstrap && fingerprint && recordAllowsReuse(record, fingerprint) && outputsPresent) {
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
    {
      recordInitialization: true,
      ...(fingerprint ? { fingerprint } : {}),
      mise,
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

const setupReuseIo: SetupReuseIo = {
  readFile: (root, relPath) => readWorkspaceFile(root, relPath),
  statFile: async (root, relPath) => {
    const stat = await statWorkspaceFile(root, relPath)
    return { exists: stat.exists, size: stat.size, mtimeMs: stat.mtimeMs ?? undefined }
  },
  sha256Hex,
}

// ---------------------------------------------------------------------------
// The host call
// ---------------------------------------------------------------------------

async function runScript(
  input: ExecuteProjectEnvironmentInput,
  script: ProjectEnvironmentScript,
  policy: HostExecutionPolicy,
  options: {
    recordInitialization: boolean
    fingerprint?: string
    validationError?: unknown
    mise?: MiseStepPlan
  }
): Promise<ProjectEnvironmentExecutionResult> {
  const startedAt = Date.now()
  if (options.recordInitialization) {
    await updateProjectEnvironmentInitialization(
      input.environment.id,
      {
        status: "running",
        scope: input.scope,
        executionRoot: input.executionRoot,
        startedAt,
      },
      startedAt
    )
  }

  let portLeaseFailed = false
  try {
    if (options.validationError !== undefined) throw options.validationError
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
    try {
      await ensureExecutionPortLease({
        cwd: input.executionRoot,
        projectId: input.environment.projectId,
      })
    } catch (cause) {
      portLeaseFailed = true
      throw cause
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
          transport.call<NativeEnvironmentResult>("project_environment_execute", {
            script: { default: MISE_STEP_FALLBACK, mise: miseInstall },
            cwd: input.executionRoot,
            variables: {},
            keyringReferences: [],
            policy,
            timeoutSecs: input.timeoutSecs,
          }),
        true
      )
      if (installed.timed_out) throw new Error("mise install timed out")
      if (installed.exit_code !== 0) {
        throw new Error(`mise install exited with code ${installed.exit_code ?? "unknown"}`)
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
              transport.call<NativeEnvironmentResult>("project_environment_execute", {
                script: bootstrap?.script ?? script,
                cwd: input.executionRoot,
                variables: bootstrap?.variables ?? input.environment.variables,
                keyringReferences: input.environment.keyringReferences,
                policy,
                // The CLI must retain its configured budget plus time to reap tool groups.
                timeoutSecs: bootstrap
                  ? Math.max(input.timeoutSecs ?? 0, bootstrap.timeoutSecs)
                  : input.timeoutSecs,
              }),
            true
          )
        : // A setup that is only the mise step has nothing more to run.
          { stdout: "", stderr: "", exit_code: 0, timed_out: false }
    const success = !result.timed_out && result.exit_code === 0
    const error = result.timed_out
      ? "Project environment setup timed out"
      : success
        ? undefined
        : `Project environment setup exited with code ${result.exit_code ?? "unknown"}`
    const bypassed = !success && input.surface === "interactive" && input.bypassOnFailure === true
    if (options.recordInitialization) {
      const completedAt = Date.now()
      await updateProjectEnvironmentInitialization(
        input.environment.id,
        {
          status: bypassed ? "bypassed" : success ? "succeeded" : "failed",
          scope: input.scope,
          executionRoot: input.executionRoot,
          startedAt,
          completedAt,
          exitCode: result.exit_code ?? undefined,
          error,
          // Only a real success vouches for skipping a later setup.
          ...(success && !miseSkipped && options.fingerprint
            ? { fingerprint: options.fingerprint }
            : {}),
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
      error,
      ...(notices.length ? { notices } : {}),
    }
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause)
    const bypassed =
      !(cause instanceof PersonalEgressDeniedError) &&
      !portLeaseFailed &&
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
          startedAt,
          completedAt,
          error,
        },
        completedAt
      )
    }
    return {
      success: bypassed,
      bypassed,
      error,
      ...(cause instanceof BootstrapAgentValidationError
        ? { bootstrapValidationCode: cause.code }
        : {}),
    }
  }
}
