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
 * that digest, so an edited file is a new proposal. A worktree with different
 * content skips the step and says why.
 *
 * # What runs
 *
 * The Host stages the approved bytes in its own temporary project and runs
 * `mise install` in safe mode with isolated config discovery. The checkout
 * and the Host's ambient mise overrides cannot change the approved inputs.
 */

/** The provisioning offer chooses one project config in this order. */
export const MISE_CONFIG_FILES = ["mise.toml", ".mise.toml"] as const
const MISE_LOCKFILE = "mise.lock"

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

interface MiseFileSnapshot extends MiseFiles {
  /** The exact bytes used for approval, carried to the Host for staging. */
  install: { config: string; lockfile?: string }
}

/**
 * The mise files at `root` and their digest, or null when the root has no
 * mise config. The first config file found is the one used, with its own
 * lockfile; the content of both is digested, so editing either changes it.
 */
export async function readMiseFiles(
  root: string,
  io: MiseFilesIo
): Promise<MiseFileSnapshot | null> {
  for (const config of MISE_CONFIG_FILES) {
    const content = await io.readFile(root, config).catch(() => null)
    if (content === null) continue
    const lockContent = await io.readFile(root, MISE_LOCKFILE).catch(() => null)
    const files = lockContent === null ? [config] : [config, MISE_LOCKFILE]
    const material = [
      config,
      content,
      ...(lockContent === null ? [] : [MISE_LOCKFILE, lockContent]),
    ]
    const digest = (await io.sha256Hex(material.join("\u0000"))).slice(0, DIGEST_LENGTH)
    const install = { config: content, ...(lockContent === null ? {} : { lockfile: lockContent }) }
    return { files, digest, install }
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
  /** The Host predates the isolated snapshot runner. */
  | "miseIsolationUnavailable"

export const MISE_STEP_NOTICES: readonly MiseStepNotice[] = [
  "miseNotApproved",
  "miseUntrusted",
  "miseMissing",
  "miseNoSafeMode",
  "miseIsolationUnavailable",
]

const MARKER = "cognia-setup-notice:"

/** Legacy Hosts resolve the default script and skip the optional installer. */
export const MISE_STEP_FALLBACK = `echo ${MARKER}miseIsolationUnavailable`

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
  step: MiseFileSnapshot | null
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
