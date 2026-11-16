/**
 * Codex memory/instruction discovery.
 *
 * Verified locations (docs: developers.openai.com/codex/guides/agents-md, /memories):
 *   - global    ~/.codex/AGENTS.override.md (preferred), then ~/.codex/AGENTS.md (editable)
 *   - project   root→cwd per dir: AGENTS.override.md, then AGENTS.md            (editable)
 *   - memories  ~/.codex/memories_v2/**.md and ~/.codex/memories/**.md         (read-only)
 *               (current layouts nest `rollout_summaries/` and
 *               `extensions/<name>/instructions.md` under each root)
 *
 * Pure + fs-injected (see {@link DiscoverCtx}); no real disk access here.
 */

import { ancestorChain, joinPath, pathKey, relLabel } from "@/lib/agents/instructions/paths"
import type { DiscoverCtx, ExternalMemoryFile, ExternalFs } from "../types"

/** Same-dir precedence: override wins, but we surface both so either can be edited. */
const AGENTS_FILES = ["AGENTS.override.md", "AGENTS.md"] as const

async function bytesOf(fs: ExternalFs, path: string): Promise<number | undefined> {
  try {
    return (await fs.stat(path)).size
  } catch {
    return undefined
  }
}

async function fileEntry(
  fs: ExternalFs,
  scope: ExternalMemoryFile["scope"],
  editable: boolean,
  absPath: string,
  label: string,
  { includeAbsent = false }: { includeAbsent?: boolean } = {}
): Promise<ExternalMemoryFile | null> {
  const exists = await fs.exists(absPath).catch(() => false)
  if (!exists && !includeAbsent) return null
  return {
    id: pathKey(absPath),
    agent: "codex",
    scope,
    absPath,
    label,
    editable,
    exists,
    bytes: exists ? await bytesOf(fs, absPath) : undefined,
  }
}

/** `$CODEX_HOME` relocates the whole tree; `vendorRoots` carries it. Otherwise `<home>/.codex`. */
export function codexHomeDir(ctx: Pick<DiscoverCtx, "home" | "vendorRoots">): string {
  return ctx.vendorRoots?.codexHome || joinPath(ctx.home, ".codex")
}

/** Enumerate Codex memory files for the given context. */
export async function discoverCodex(ctx: DiscoverCtx): Promise<ExternalMemoryFile[]> {
  const { roots, cwd, fs } = ctx
  const out: ExternalMemoryFile[] = []
  const codexDir = codexHomeDir(ctx)

  // 1. Global — surface AGENTS.md slot even when absent; override only when present.
  const override = await fileEntry(
    fs,
    "global",
    true,
    joinPath(codexDir, "AGENTS.override.md"),
    "~/.codex/AGENTS.override.md"
  )
  if (override) out.push(override)
  const global = await fileEntry(
    fs,
    "global",
    true,
    joinPath(codexDir, "AGENTS.md"),
    "~/.codex/AGENTS.md",
    { includeAbsent: true }
  )
  if (global) out.push(global)

  // 2. Project — walk each containing root from root→cwd.
  const seen = new Set<string>()
  for (const root of roots) {
    const chain = ancestorChain(cwd && pathKey(cwd).startsWith(pathKey(root)) ? cwd : root, root)
    for (const dir of [...chain].reverse()) {
      for (const name of AGENTS_FILES) {
        const abs = joinPath(dir, name)
        if (seen.has(pathKey(abs))) continue
        seen.add(pathKey(abs))
        const entry = await fileEntry(fs, "project", true, abs, relLabel(root, abs))
        if (entry) out.push(entry)
      }
    }
  }

  // 3. Codex-managed memories — read-only.
  out.push(...(await discoverMemories(fs, codexDir)))

  return out
}

/** Codex memory roots under `$CODEX_HOME`, newest layout first. */
const MEMORY_ROOTS = ["memories_v2", "memories"] as const

/**
 * Directories below a memory root that are walked. Current layouts reach
 * `extensions/<name>/notes/<file>.md`; the bound also stops a symlink cycle.
 */
const MAX_MEMORY_DEPTH = 6

/**
 * Every Markdown file under each Codex memory root, read-only. Codex writes
 * its memory as Markdown (`MEMORY.md`, `raw_memories.md`, rollout summaries,
 * extension instructions); everything else under the roots (extension
 * resources, sqlite side files) is not memory text and is skipped, as are
 * dot entries such as the `.codex-baseline` git dir. Directories are walked,
 * never listed as files: the viewer can only open a file.
 */
async function discoverMemories(fs: ExternalFs, codexDir: string): Promise<ExternalMemoryFile[]> {
  const out: ExternalMemoryFile[] = []
  for (const root of MEMORY_ROOTS) {
    await walkMemoryDir(fs, joinPath(codexDir, root), root, 0, out)
  }
  return out
}

async function walkMemoryDir(
  fs: ExternalFs,
  dir: string,
  label: string,
  depth: number,
  out: ExternalMemoryFile[]
): Promise<void> {
  let names: string[]
  try {
    names = await fs.readDir(dir)
  } catch {
    return
  }
  for (const name of [...names].sort()) {
    if (name.startsWith(".")) continue
    const abs = joinPath(dir, name)
    const childLabel = `${label}/${name}`
    let stat: { size: number; isFile: boolean } | undefined
    try {
      stat = await fs.stat(abs)
    } catch {
      stat = undefined
    }
    if (stat?.isFile) {
      if (!name.toLowerCase().endsWith(".md")) continue
      out.push({
        id: pathKey(abs),
        agent: "codex",
        scope: "memories",
        absPath: abs,
        label: childLabel,
        editable: false,
        exists: true,
        bytes: stat.size,
      })
    } else if (depth < MAX_MEMORY_DEPTH) {
      // Not a readable file: a directory, or an entry stat cannot describe.
      await walkMemoryDir(fs, abs, childLabel, depth + 1, out)
    }
  }
}
