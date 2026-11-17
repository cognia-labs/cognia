/**
 * Orchestrator for project instruction loading. Composes the pure discovery /
 * import-expansion / render layers behind a small per-key memo cache (because
 * `resolveSendOptions` runs every turn and must not re-walk the tree on each
 * send).
 *
 * Which filesystem it reads depends on the host:
 *   - a caller-supplied `fs` (the CLI passes a Node adapter and its home dir);
 *   - the desktop: the Tauri fs plugin;
 *   - an always-on headless Host: its root-confined workspace reads, so only
 *     files under the workspace roots are visible;
 *   - web / mobile: no project filesystem. The result is empty AND says so in
 *     `warnings` — a host that silently loaded nothing was indistinguishable
 *     from a project without instruction files.
 *
 * The `fs`, `isTauriEnv`, `isHeadlessEnv`, `homeDir` and `now` inputs are
 * injectable so the whole orchestration is unit-testable without a real shell.
 */

import { isTauri } from "@/lib/tauri"
import { isHeadlessHost } from "@/lib/platform/detect"
import { discoverInstructionPaths, type DiscoveredPath } from "./discover"
import {
  discoverMarkdownAgentFiles,
  discoverMarkdownAgentPaths,
  type MarkdownAgentPath,
} from "./discover-agents"
import { expandImports } from "./imports"
import { renderInstructions } from "./render"
import { dirname, isDescendant, joinPath, pathKey } from "./paths"
import {
  resolveInstructionsConfig,
  type InstructionFile,
  type InstructionFs,
  type InstructionsConfig,
  type ResolvedInstructions,
} from "./types"

export interface LoadInstructionsInput {
  cwd?: string
  roots: string[]
  config?: InstructionsConfig
  /** Injected fs (tests). When omitted a real Tauri-backed adapter is built. */
  fs?: InstructionFs
  /** Override Tauri detection (tests). */
  isTauriEnv?: boolean
  /** Override headless-Host detection (tests). */
  isHeadlessEnv?: boolean
  /** Override the resolved home dir (tests); skips the `@tauri-apps/api/path` call. */
  homeDir?: string | null
  /** Injectable clock for the cache TTL (tests). */
  now?: () => number
}

const EMPTY: ResolvedInstructions = { section: "", files: [], markdownAgentFiles: [], warnings: [] }

/** Why a host without a project filesystem loaded no instruction files. */
export const NO_INSTRUCTION_FS_WARNING =
  "project instruction files were not loaded: this host has no project filesystem"

/** Largest instruction file a headless Host reads through its workspace reads. */
const HEADLESS_MAX_FILE_BYTES = 512 * 1024

const CACHE_TTL_MS = 3000
const cache = new Map<string, { at: number; value: ResolvedInstructions }>()

/** Clear the memo cache (call when settings / active workspace change). */
export function clearInstructionCache(): void {
  cache.clear()
}

/** Build the real fs adapter over `lib/file/file-operations.ts`. */
function realFs(): InstructionFs {
  return {
    async exists(path) {
      const { exists } = await import("@/lib/file/file-operations")
      return exists(path)
    },
    async readDir(path) {
      const { readDir } = await import("@/lib/file/file-operations")
      return readDir(path)
    },
    async readText(path) {
      const { readTextFile } = await import("@/lib/file/file-operations")
      return readTextFile(path)
    },
  }
}

/**
 * An adapter over a headless Host's root-confined workspace reads: a path
 * under one of `roots` resolves against the most specific root containing it;
 * anything else does not exist (the Host refuses reads outside its roots).
 */
function workspaceFs(roots: readonly string[]): InstructionFs {
  const slash = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "")
  const locate = (path: string): { root: string; relPath: string } | null => {
    const root = roots
      .filter((r) => r && isDescendant(r, path))
      .sort((x, y) => y.length - x.length)[0]
    if (!root) return null
    return { root, relPath: slash(path).slice(slash(root).length).replace(/^\/+/, "") }
  }
  return {
    async exists(path) {
      const at = locate(path)
      if (!at) return false
      const { statWorkspaceFile } = await import("@/lib/files/workspace-fs")
      try {
        return (await statWorkspaceFile(at.root, at.relPath)).exists
      } catch {
        return false
      }
    },
    async readDir(path) {
      const at = locate(path)
      if (!at) return []
      const { listWorkspaceDir } = await import("@/lib/files/workspace-fs")
      try {
        return (await listWorkspaceDir(at.root, at.relPath || undefined, true)).map(
          (entry) => entry.relPath.split("/").pop() ?? entry.relPath
        )
      } catch {
        return []
      }
    },
    async readText(path) {
      const at = locate(path)
      if (!at) throw new Error(`instruction file outside the workspace roots: ${path}`)
      const { readWorkspaceFile } = await import("@/lib/files/workspace-fs")
      return readWorkspaceFile(at.root, at.relPath, HEADLESS_MAX_FILE_BYTES)
    },
  }
}

/** The filesystem this host reads instruction files through, or null when it has none. */
function hostFs(input: Omit<LoadInstructionsInput, "now">): InstructionFs | null {
  if (input.fs) return input.fs
  if (input.isTauriEnv ?? isTauri()) return realFs()
  if (input.isHeadlessEnv ?? isHeadlessHost()) return workspaceFs(input.roots)
  return null
}

async function resolveHome(input: LoadInstructionsInput): Promise<string | undefined> {
  if (input.homeDir !== undefined) return input.homeDir ?? undefined
  try {
    const { homeDir } = await import("@tauri-apps/api/path")
    return await homeDir()
  } catch {
    return undefined
  }
}

/** Pick the first existing `~/.cognia/<name>` global instruction file. */
async function resolveGlobalPath(
  explicit: string | undefined,
  home: string | undefined,
  fileNames: string[],
  fs: InstructionFs
): Promise<string | undefined> {
  if (explicit) return explicit
  if (!home) return undefined
  for (const name of fileNames) {
    const abs = joinPath(home, joinPath(".cognia", name))
    try {
      if (await fs.exists(abs)) return abs
    } catch {
      // ignore
    }
  }
  return undefined
}

async function discoverWithHome(
  input: LoadInstructionsInput,
  config: ReturnType<typeof resolveInstructionsConfig>,
  fs: InstructionFs,
  home: string | undefined
): Promise<DiscoveredPath[]> {
  const globalPath = config.includeGlobal
    ? await resolveGlobalPath(config.globalPath, home, config.fileNames, fs)
    : undefined
  return discoverInstructionPaths({
    cwd: input.cwd,
    roots: input.roots,
    globalPath,
    config,
    fs,
  })
}

/**
 * The instruction files a turn in `roots` would load, in load order, without
 * reading them. The Prompt Center lists and edits these files through the
 * checked workspace-file writes; the send path reads them with
 * {@link loadProjectInstructions}. Same discovery, so the two cannot disagree
 * about which files apply. Empty off-Tauri and when instruction loading is off.
 */
export async function discoverProjectInstructionFiles(
  input: Omit<LoadInstructionsInput, "now">
): Promise<DiscoveredPath[]> {
  const config = resolveInstructionsConfig(input.config)
  if (!config.enabled) return []
  const fs = hostFs(input)
  if (!fs) return []
  return discoverWithHome(input, config, fs, await resolveHome(input))
}

/**
 * The markdown agent files a turn in `roots` would load, in load order, without
 * reading them. Same directories and order as the send path. Empty off-Tauri
 * (without an injected fs) and when project agents are off.
 */
export async function discoverProjectAgentFiles(
  input: Omit<LoadInstructionsInput, "now" | "cwd">
): Promise<MarkdownAgentPath[]> {
  const config = resolveInstructionsConfig(input.config)
  if (!config.enabled || !config.loadProjectAgents) return []
  const fs = hostFs(input)
  if (!fs) return []
  const home = await resolveHome(input)
  return discoverMarkdownAgentPaths({
    roots: input.roots,
    globalAgentsDir: home ? joinPath(home, joinPath(".cognia", "agents")) : undefined,
    fs,
  })
}

export async function loadProjectInstructions(
  input: LoadInstructionsInput
): Promise<ResolvedInstructions> {
  const config = resolveInstructionsConfig(input.config)
  if (!config.enabled) return EMPTY

  const fs = hostFs(input)
  // Only worth saying when the turn had somewhere to look.
  if (!fs)
    return input.cwd || input.roots.length > 0
      ? { ...EMPTY, warnings: [NO_INSTRUCTION_FS_WARNING] }
      : EMPTY
  const now = input.now ?? Date.now

  const key = JSON.stringify({ cwd: input.cwd ?? null, roots: input.roots, config })
  const hit = cache.get(key)
  if (hit && now() - hit.at < CACHE_TTL_MS) return hit.value

  const warnings: string[] = []
  const home = await resolveHome(input)
  const discovered = await discoverWithHome(input, config, fs, home)

  const seen = new Set<string>()
  const files: InstructionFile[] = []
  for (const d of discovered) {
    const k = pathKey(d.absPath)
    if (seen.has(k)) continue // already inlined as an @import of an earlier file
    seen.add(k)
    let raw: string
    try {
      raw = await fs.readText(d.absPath)
    } catch {
      warnings.push(`could not read instruction file: ${d.label}`)
      continue
    }
    const expanded = await expandImports(raw, dirname(d.absPath), fs, {
      maxDepth: config.maxImportDepth,
      seen,
    })
    warnings.push(...expanded.warnings)
    files.push({ absPath: d.absPath, label: d.label, source: d.source, content: expanded.content })
  }

  const rendered = renderInstructions(files, config)
  warnings.push(...rendered.warnings)

  const markdownAgentFiles = config.loadProjectAgents
    ? await discoverMarkdownAgentFiles({
        roots: input.roots,
        globalAgentsDir: home ? joinPath(home, joinPath(".cognia", "agents")) : undefined,
        fs,
      })
    : []

  const value: ResolvedInstructions = {
    section: rendered.section,
    files: rendered.files,
    markdownAgentFiles,
    warnings,
  }
  cache.set(key, { at: now(), value })
  return value
}
