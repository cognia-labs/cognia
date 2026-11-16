/**
 * Composer `#` file memory: append one bullet to the instruction file a turn
 * in this workspace actually loads.
 *
 * The target comes from the same discovery the send path uses
 * ({@link discoverProjectInstructionFiles}), so a line written here is a line
 * the next turn reads:
 *
 * - `project`: the project instruction file nearest the working directory
 *   (AGENTS.md / CLAUDE.md / … in the configured order). A workspace without
 *   one gets the first configured name created in the working directory.
 * - `user`: the global file, `~/.cognia/<name>` (or the configured
 *   `globalPath`). Created with the first configured name when there is none.
 *
 * The write is the Prompt Center's: a versioned read, then a checked write
 * against the hash of the bytes read (or against absence for a new file), so a
 * concurrent edit is retried on the fresh text rather than overwritten. The
 * send path's memo is cleared afterwards.
 *
 * The workspace-file commands run on this window's transport. Callers only use
 * this where that transport is the machine the conversation's turns load their
 * instructions from (`lib/chat/memory-target.ts`).
 */

import {
  isWorkspaceFileConflict,
  readWorkspaceFileVersioned,
  writeWorkspaceFileChecked,
} from "@/lib/files/workspace-fs"
import { clearInstructionCache, discoverProjectInstructionFiles } from "./load"
import { basename, dirname, joinPath } from "./paths"
import { resolveInstructionsConfig, type InstructionsConfig } from "./types"

export type InstructionMemoryScope = "project" | "user"

/** Why a line could not be written. Each maps to a message the composer shows. */
export type InstructionMemoryRefusal =
  | "empty"
  /** Instruction loading is off, so no turn would read the file. */
  | "instructions-off"
  /** The global file is excluded from loading. */
  | "global-off"
  | "no-workspace"
  | "no-home"
  /** The file kept changing under the write. */
  | "conflict"

export class InstructionMemoryError extends Error {
  constructor(readonly reason: InstructionMemoryRefusal) {
    super(`instruction memory refused: ${reason}`)
    this.name = "InstructionMemoryError"
  }
}

export interface AppendInstructionMemoryInput {
  scope: InstructionMemoryScope
  text: string
  cwd?: string | null
  roots: string[]
  config?: InstructionsConfig
}

export interface AppendInstructionMemoryDeps {
  discover?: typeof discoverProjectInstructionFiles
  read?: typeof readWorkspaceFileVersioned
  write?: typeof writeWorkspaceFileChecked
  homeDir?: () => Promise<string | null>
}

async function defaultHomeDir(): Promise<string | null> {
  try {
    const { homeDir } = await import("@tauri-apps/api/path")
    return await homeDir()
  } catch {
    return null
  }
}

/** Where the line goes: a directory the write is rooted at and a name in it. */
interface TargetFile {
  root: string
  relPath: string
  /** Discovery saw the file, so a failed read is a real failure, not absence. */
  existed: boolean
}

async function resolveTarget(
  input: AppendInstructionMemoryInput,
  deps: Required<AppendInstructionMemoryDeps>
): Promise<TargetFile> {
  const config = resolveInstructionsConfig(input.config)
  if (!config.enabled) throw new InstructionMemoryError("instructions-off")
  const [firstName] = config.fileNames
  const home = (await deps.homeDir()) ?? undefined

  if (input.scope === "user") {
    if (!config.includeGlobal) throw new InstructionMemoryError("global-off")
    const found = await deps.discover({
      cwd: input.cwd ?? undefined,
      roots: input.roots,
      config: input.config,
      homeDir: home ?? null,
    })
    const global = found.find((file) => file.source === "global")
    if (global) {
      return { root: dirname(global.absPath), relPath: basename(global.absPath), existed: true }
    }
    if (config.globalPath) {
      return {
        root: dirname(config.globalPath),
        relPath: basename(config.globalPath),
        existed: false,
      }
    }
    if (!home || !firstName) throw new InstructionMemoryError("no-home")
    // Rooted at the home directory so the write creates `.cognia/` when needed.
    return { root: home, relPath: joinPath(".cognia", firstName), existed: false }
  }

  const cwd = input.cwd ?? input.roots[0]
  if (!cwd) throw new InstructionMemoryError("no-workspace")
  const found = await deps.discover({
    cwd,
    roots: input.roots,
    config: input.config,
    homeDir: home ?? null,
  })
  // Layered discovery lists project files root → cwd, so the last is nearest.
  const nearest = found.filter((file) => file.source === "project").at(-1)
  if (nearest) {
    return { root: dirname(nearest.absPath), relPath: basename(nearest.absPath), existed: true }
  }
  if (!firstName) throw new InstructionMemoryError("instructions-off")
  return { root: cwd, relPath: firstName, existed: false }
}

function appendBullet(existing: string, text: string): string {
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""
  return `${existing}${separator}- ${text}\n`
}

/** Concurrent edits are retried on the fresh text this many times. */
const MAX_ATTEMPTS = 3

/**
 * Append `- <text>` to the instruction file `scope` resolves to and return its
 * absolute path. Throws {@link InstructionMemoryError} for a refusal the user
 * can act on; any other error is the host's.
 */
export async function appendInstructionMemory(
  input: AppendInstructionMemoryInput,
  deps: AppendInstructionMemoryDeps = {}
): Promise<string> {
  const text = input.text.trim()
  if (!text) throw new InstructionMemoryError("empty")
  const resolved: Required<AppendInstructionMemoryDeps> = {
    discover: deps.discover ?? discoverProjectInstructionFiles,
    read: deps.read ?? readWorkspaceFileVersioned,
    write: deps.write ?? writeWorkspaceFileChecked,
    homeDir: deps.homeDir ?? defaultHomeDir,
  }
  const target = await resolveTarget(input, resolved)

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let current: { content: string; sha256: string } | null
    try {
      current = await resolved.read(target.root, target.relPath)
    } catch (error) {
      // An unreadable file that exists must not be "created" over.
      if (target.existed && attempt === 0) throw error
      // No file here yet, or it vanished since: create it, and let the absence
      // precondition turn a racing creator into a conflict.
      current = null
    }
    try {
      await resolved.write(
        target.root,
        target.relPath,
        appendBullet(current?.content ?? "", text),
        current ? { expectedSha256: current.sha256 } : { expectAbsent: true }
      )
      clearInstructionCache()
      return joinPath(target.root, target.relPath)
    } catch (error) {
      if (!isWorkspaceFileConflict(error)) throw error
    }
  }
  throw new InstructionMemoryError("conflict")
}
