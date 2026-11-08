/**
 * `mise install` as an optional setup step (ADR-0147, 2026-11-08 amendment).
 *
 * A repository that pins its toolchain in `mise.toml` (or `.mise.toml`) needs
 * those tools before its own setup can run. Cognia proposes the step from the
 * file (`provisioning-inference`), the user accepts it on this device, and the
 * setup executor runs it ahead of the environment's setup script.
 *
 * # What is approved
 *
 * The acceptance is bound to the CONTENT of the mise files at the root:
 * `mise.toml` / `.mise.toml` and the lockfile beside it. Its consent id carries
 * that digest, so an edited file is a new proposal and the step does not run
 * until it is accepted again. A copy whose files differ from the accepted ones
 * (a worktree on another branch) skips the step and says why.
 *
 * # What runs
 *
 * Only `mise install`, in mise's safe mode (`MISE_SAFE=1`): project `[env]`,
 * `[settings]` and hooks are ignored, and tasks, template `exec()`, tool
 * `postinstall` / `install_env` and plugin installs are refused with an error.
 * `MISE_NO_HOOKS=1` is set as well. A mise too old to know safe mode would
 * quietly run all of that, so the step first asks mise whether safe mode is on
 * and skips when it cannot say yes. mise itself is never installed: a machine
 * without it on `PATH` skips the step. Each skip prints a marker line the
 * executor turns into a notice on the setup record.
 */

/** Config files, in the order mise prefers them. */
export const MISE_CONFIG_FILES = ["mise.toml", ".mise.toml"] as const

/** The lockfile beside each config file. */
const MISE_LOCK_FOR: Record<(typeof MISE_CONFIG_FILES)[number], string> = {
  "mise.toml": "mise.lock",
  ".mise.toml": ".mise.lock",
}

/** The consent id prefix; the digest follows the `@`. */
export const MISE_STEP_ID_PREFIX = "setupStep:mise@"

/** Hex characters of the digest kept in the id. */
const DIGEST_LENGTH = 16

export interface MiseFilesIo {
  /** Content of a root-relative file; rejects when it is missing or unreadable. */
  readFile(root: string, relPath: string): Promise<string>
  sha256Hex(value: string): Promise<string>
}

export interface MiseFiles {
  /** The config file and its lockfile when present, in digest order. */
  files: string[]
  /** Short digest of their names and content. */
  digest: string
}

/**
 * The mise files at `root` and their digest, or null when the root has no
 * mise config. The first config file found is the one used, with its own
 * lockfile; the content of both is digested, so editing either changes it.
 */
export async function readMiseFiles(root: string, io: MiseFilesIo): Promise<MiseFiles | null> {
  for (const config of MISE_CONFIG_FILES) {
    const content = await io.readFile(root, config).catch(() => null)
    if (content === null) continue
    const lock = MISE_LOCK_FOR[config]
    const lockContent = await io.readFile(root, lock).catch(() => null)
    const files = lockContent === null ? [config] : [config, lock]
    const material = [config, content, ...(lockContent === null ? [] : [lock, lockContent])]
    const digest = (await io.sha256Hex(material.join("\u0000"))).slice(0, DIGEST_LENGTH)
    return { files, digest }
  }
  return null
}

/** The consent id that accepts these exact mise files. */
export function miseStepId(digest: string): string {
  return `${MISE_STEP_ID_PREFIX}${digest}`
}

/** The digests the user accepted the step for. */
export function acceptedMiseDigests(accepted: readonly string[] | undefined): Set<string> {
  const digests = new Set<string>()
  for (const id of accepted ?? []) {
    if (!id.startsWith(MISE_STEP_ID_PREFIX)) continue
    const digest = id.slice(MISE_STEP_ID_PREFIX.length)
    if (/^[0-9a-f]+$/.test(digest)) digests.add(digest)
  }
  return digests
}

/** Why the step did not run. Keys under `projectEnvironment.initNotice.*`. */
export type MiseStepNotice =
  /** The root has mise files the user has not accepted at this content. */
  | "miseNotApproved"
  /** Accepted, but Workspace Trust withholds the workspace. */
  | "miseUntrusted"
  /** `mise` is not on `PATH` where setup runs. */
  | "miseMissing"
  /** This mise has no safe mode, so it cannot be kept from running project code. */
  | "miseNoSafeMode"

export const MISE_STEP_NOTICES: readonly MiseStepNotice[] = [
  "miseNotApproved",
  "miseUntrusted",
  "miseMissing",
  "miseNoSafeMode",
]

const MARKER = "cognia-setup-notice:"

/** The environment the step runs with, on top of the setup's own variables. */
export const MISE_STEP_VARIABLES: Readonly<Record<string, string>> = Object.freeze({
  MISE_SAFE: "1",
  MISE_NO_HOOKS: "1",
})

/**
 * The step itself, per shell: `sh -c` everywhere but Windows, `cmd /C` there
 * (the host's setup runner). It checks for mise, then for safe mode, and only
 * then installs; a failed install fails the step.
 */
export const MISE_STEP_SCRIPT = Object.freeze({
  default: [
    `if ! command -v mise >/dev/null 2>&1; then echo "${MARKER}miseMissing"; exit 0; fi`,
    `if [ "$(mise settings get safe 2>/dev/null)" != "true" ]; then echo "${MARKER}miseNoSafeMode"; exit 0; fi`,
    "exec mise install",
  ].join("\n"),
  byOs: {
    windows: [
      `(where mise >nul 2>nul || (echo ${MARKER}miseMissing& exit /b 0))`,
      `(for /f "delims=" %S in ('mise settings get safe 2^>nul') do @if /i "%S"=="true" (mise install & exit /b)) & echo ${MARKER}miseNoSafeMode`,
    ].join(" && "),
  },
})

/** The notices a run of the step printed. */
export function miseStepNotices(output: string | undefined): MiseStepNotice[] {
  const found: MiseStepNotice[] = []
  for (const line of (output ?? "").split(/\r?\n/)) {
    const text = line.trim()
    if (!text.startsWith(MARKER)) continue
    const notice = text.slice(MARKER.length) as MiseStepNotice
    if (MISE_STEP_NOTICES.includes(notice) && !found.includes(notice)) found.push(notice)
  }
  return found
}

/** What setup does about mise in one root. */
export interface MiseStepPlan {
  /** The accepted files to install from, or null when the step does not run. */
  step: MiseFiles | null
  /** Why it does not, when the root has mise files. */
  notices: MiseStepNotice[]
}

export interface MiseStepPlanDeps extends MiseFilesIo {
  /** The workspace's accepted provisioning ids, or null when it is unknown. */
  acceptedIds(projectId: string): Promise<readonly string[] | null>
  /** Whether Workspace Trust withholds the workspace. Unknown counts as withheld. */
  restricted(projectId: string): Promise<boolean>
}

/**
 * Whether setup in `executionRoot` runs `mise install`: only when the root has
 * mise files, the user accepted the step for exactly their content, and the
 * workspace is trusted. Every other case with mise files says why not.
 */
export async function planMiseStep(
  input: { executionRoot: string; projectId: string },
  deps: MiseStepPlanDeps
): Promise<MiseStepPlan> {
  const files = await readMiseFiles(input.executionRoot, deps).catch(() => null)
  if (!files) return { step: null, notices: [] }
  const accepted = await deps.acceptedIds(input.projectId).catch(() => null)
  if (!acceptedMiseDigests(accepted ?? []).has(files.digest)) {
    return { step: null, notices: ["miseNotApproved"] }
  }
  if (await deps.restricted(input.projectId).catch(() => true)) {
    return { step: null, notices: ["miseUntrusted"] }
  }
  return { step: files, notices: [] }
}
