/**
 * Deciding whether a project environment's setup may be skipped.
 *
 * See `ProjectEnvironmentSetupReuse` for the contract. This module holds the
 * pure pieces (path validation, the canonical fingerprint input, choosing the
 * record a decision rests on) plus the one I/O step each needs, behind
 * injectable dependencies so the executor stays a thin caller.
 */

import type {
  ProjectEnvironment,
  ProjectEnvironmentInitialization,
  ProjectEnvironmentSetupReuse,
} from "@/types/project-environment"
import { BootstrapAgentValidationError } from "./bootstrap-agent"

/** Bumped when the fingerprint's input shape changes, so old records stop matching. */
const FINGERPRINT_VERSION = 2

/** Keeps a pathological list from turning every turn into a directory walk. */
export const MAX_SETUP_REUSE_PATHS = 32

/**
 * Normalize an execution root string for in-process locking and history
 * comparison so path aliases like `/repo` and `/repo/` or `C:\repo\` share the
 * same directory identity (F3).
 */
export function normalizeExecutionRoot(raw: string): string {
  const trimmed = raw.trim().replace(/\\/g, "/")
  if (!trimmed) return ""
  const drive = /^[A-Za-z]:/.exec(trimmed)?.[0]
  const rest = drive ? trimmed.slice(drive.length) : trimmed
  const absolute = rest.startsWith("/")
  const segments: string[] = []
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue
    segments.push(part)
  }
  const joined = segments.join("/")
  if (drive) return `${drive.toUpperCase()}${absolute ? "/" : ""}${joined}`
  return absolute ? `/${joined}` : joined
}

export interface SetupReuseIo {
  /** Content of a root-relative file; rejects when missing or unreadable as text. */
  readFile: (root: string, relPath: string) => Promise<string>
  /** Existence and cheap identity of a root-relative path; never rejects for a missing path. */
  statFile: (
    root: string,
    relPath: string
  ) => Promise<{ exists: boolean; size?: number; mtimeMs?: number }>
  sha256Hex: (value: string) => Promise<string>
}

/**
 * A root-relative path setup reuse may read, or a reason it may not. Absolute
 * paths and `..` segments are refused outright rather than normalized: the
 * workspace fs commands confine reads to the root anyway, and a declaration
 * that tries to leave it is a mistake worth surfacing, not silently fixing.
 */
export function validateSetupReusePath(raw: string): { ok: true; path: string } | { ok: false } {
  const path = raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "")
  if (!path) return { ok: false }
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return { ok: false }
  if (path.split("/").some((segment) => segment === ".." || segment === "")) return { ok: false }
  return { ok: true, path }
}

/** Throws on an invalid declaration; used by the save-time boundary check. */
export function assertSetupReuse(reuse: ProjectEnvironmentSetupReuse): void {
  for (const list of [reuse.inputs, reuse.outputs]) {
    if (!Array.isArray(list)) throw new Error("Setup reuse inputs and outputs must be lists")
    if (list.length > MAX_SETUP_REUSE_PATHS) {
      throw new Error(`Setup reuse accepts at most ${MAX_SETUP_REUSE_PATHS} paths per list`)
    }
    for (const entry of list) {
      if (typeof entry !== "string" || !validateSetupReusePath(entry).ok) {
        throw new Error(`Setup reuse path must stay inside the execution root: ${String(entry)}`)
      }
    }
  }
}

/**
 * The declaration the executor acts on, or `null` when reuse is off. Invalid
 * Legacy setup reuse paths are sanitized; bootstrap declarations are validated
 * and unioned without truncation so every declared input affects the fingerprint.
 */
export function effectiveSetupReuse(
  environment: Pick<ProjectEnvironment, "setupReuse" | "bootstrapAgent">
): ProjectEnvironmentSetupReuse | null {
  const reuse = environment.setupReuse
  const bootstrap = environment.bootstrapAgent?.enabled ? environment.bootstrapAgent : undefined
  if (!reuse?.enabled && !bootstrap) return null
  const clean = (list: unknown): string[] => {
    if (!Array.isArray(list)) return []
    const seen = new Set<string>()
    for (const entry of list) {
      if (typeof entry !== "string") continue
      const verdict = validateSetupReusePath(entry)
      if (verdict.ok) seen.add(verdict.path)
    }
    return [...seen].sort().slice(0, MAX_SETUP_REUSE_PATHS)
  }
  const bootstrapPaths = (list: unknown): string[] => {
    if (list === undefined) return []
    if (!Array.isArray(list) || list.length > 128) throw new BootstrapAgentValidationError("reuse")
    return list.map((entry: unknown) => {
      const verdict =
        typeof entry === "string" ? validateSetupReusePath(entry) : { ok: false as const }
      if (!verdict.ok) throw new BootstrapAgentValidationError("reuse")
      return verdict.path
    })
  }
  const union = (field: "inputs" | "outputs") =>
    [
      ...new Set([
        ...(reuse?.enabled ? clean(reuse[field]) : []),
        ...bootstrapPaths(bootstrap?.reuse?.[field]),
      ]),
    ].sort()
  return { enabled: true, inputs: union("inputs"), outputs: union("outputs") }
}

/** JSON with object keys sorted at every depth, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])])
    )
  }
  return value
}

/**
 * Everything about the environment definition (and bound execution Host) a
 * setup depends on, without any file I/O. Two setup requests with the same
 * signature on the same Host would run the same command in the same way.
 */
export function setupSignature(
  environment: Pick<
    ProjectEnvironment,
    "setupScript" | "variables" | "keyringReferences" | "policy" | "bootstrapAgent"
  >,
  hostKey?: string
): string {
  return canonicalJson({
    v: FINGERPRINT_VERSION,
    hostKey: hostKey ?? null,
    setupScript: environment.setupScript,
    variables: environment.variables,
    keyringReferences: [...environment.keyringReferences]
      .map(({ variable, keyringRef }) => ({ variable, keyringRef }))
      .sort((a, b) => a.variable.localeCompare(b.variable)),
    policy: environment.policy ?? null,
    ...(environment.bootstrapAgent?.enabled ? { bootstrapAgent: environment.bootstrapAgent } : {}),
  })
}

/**
 * The fingerprint a successful setup is recorded under: the signature plus the
 * content of every declared input. A missing input is part of the answer
 * (`absent`), since creating the lockfile must re-run setup. An input that
 * cannot be read as text falls back to its size and mtime. One that cannot
 * even be stat'ed makes the fingerprint unavailable, and setup simply runs.
 */
export async function computeSetupFingerprint(
  signature: string,
  executionRoot: string,
  reuse: ProjectEnvironmentSetupReuse,
  io: SetupReuseIo
): Promise<string> {
  const inputs = await Promise.all(
    reuse.inputs.map(async (path) => {
      try {
        return { path, content: await io.sha256Hex(await io.readFile(executionRoot, path)) }
      } catch {
        const stat = await io.statFile(executionRoot, path)
        if (!stat.exists) return { path, content: "absent" }
        return { path, content: `stat:${stat.size ?? "?"}:${stat.mtimeMs ?? "?"}` }
      }
    })
  )
  return io.sha256Hex(canonicalJson({ signature, inputs }))
}

/** True when every declared output still exists under the root. */
export async function setupOutputsPresent(
  executionRoot: string,
  reuse: ProjectEnvironmentSetupReuse,
  io: SetupReuseIo
): Promise<boolean> {
  const stats = await Promise.all(reuse.outputs.map((path) => io.statFile(executionRoot, path)))
  return stats.every((stat) => stat.exists)
}

/**
 * The record a reuse decision rests on: the most recent setup attempt for this
 * root, scope and execution Host (F2, F7).
 *
 * Unfinished `running` attempts are NOT skipped: if a setup began after an
 * earlier success and never settled (crash / reload / abrupt termination), it
 * stays the latest record so the older success cannot vouch for a potentially
 * half-mutated workspace. A `running` entry whose own attempt subsequently
 * settled (same `attemptId`, or same `startedAt` with a finished record) is
 * superseded by its terminal record.
 */
export function latestSetupRecord(
  environment: Pick<ProjectEnvironment, "lastInitialization" | "initializationHistory">,
  executionRoot: string,
  scope: ProjectEnvironmentInitialization["scope"],
  hostKey?: string
): ProjectEnvironmentInitialization | null {
  const normalizedRoot = normalizeExecutionRoot(executionRoot)
  const matching = [
    ...(environment.initializationHistory ?? []),
    ...(environment.lastInitialization ? [environment.lastInitialization] : []),
  ].filter((record) => {
    if (normalizeExecutionRoot(record.executionRoot) !== normalizedRoot || record.scope !== scope) {
      return false
    }
    if (hostKey !== undefined) {
      // A success must strictly match this Host; an unattributed `running`
      // attempt for this root/scope still invalidates reuse fail-closed.
      return (
        record.hostKey === hostKey || (record.status === "running" && record.hostKey === undefined)
      )
    }
    return record.hostKey === undefined
  })

  const settledAttemptIds = new Set<string>()
  const settledStartTimes = new Set<number>()
  for (const record of matching) {
    if (record.status === "running") continue
    if (record.attemptId) settledAttemptIds.add(record.attemptId)
    else settledStartTimes.add(record.startedAt)
  }

  const candidates = matching.filter((record) => {
    if (record.status !== "running") return true
    if (record.attemptId && settledAttemptIds.has(record.attemptId)) return false
    if (!record.attemptId && settledStartTimes.has(record.startedAt)) return false
    return true
  })

  let latest: ProjectEnvironmentInitialization | null = null
  for (const record of candidates) {
    const at = record.completedAt ?? record.startedAt
    const latestAt = latest ? (latest.completedAt ?? latest.startedAt) : -Infinity
    if (at > latestAt) {
      latest = record
    } else if (at === latestAt && latest) {
      // At an identical timestamp, an unsettled `running` attempt supersedes an
      // earlier finished attempt unless the finished record is the completion
      // of that same start time (already filtered above).
      if (record.status === "running" || latest.status !== "running") {
        latest = record
      }
    }
  }
  return latest
}

/** Whether `record` vouches for skipping a setup whose fingerprint is `fingerprint`. */
export function recordAllowsReuse(
  record: ProjectEnvironmentInitialization | null,
  fingerprint: string,
  hostKey?: string
): boolean {
  if (record?.status !== "succeeded" || record.fingerprint !== fingerprint) return false
  if (hostKey !== undefined && record.hostKey !== hostKey) return false
  return true
}
