/**
 * Aggregate external agent-memory discovery: run every provider, de-dupe by
 * path, and order the results agent→scope for stable display. Pure +
 * fs-injected — the renderer hook (`hooks/memory/use-external-memory.ts`)
 * supplies the real fs + home + roots.
 */

import { pathKey } from "@/lib/agents/instructions/paths"
import { claudeConfigDir, discoverClaudeCode } from "./providers/claude-code"
import { codexHomeDir, discoverCodex } from "./providers/codex"
import { discoverOpencode, opencodeConfigDir } from "./providers/opencode"
import { discoverPi, piAgentDir } from "./providers/pi"
import type { DiscoverCtx, ExternalAgentId, ExternalMemoryFile, ExternalMemoryScope } from "./types"

/**
 * Display + de-dupe order for every agent a provider can return. Exported so
 * the `/memory` external tab groups by the same list this module discovers —
 * it used to keep a private copy naming only `claude-code` and `codex`, which
 * silently dropped every OpenCode and Pi file that discovery had already read
 * off disk.
 */
export const EXTERNAL_AGENT_ORDER: readonly ExternalAgentId[] = [
  "claude-code",
  "codex",
  "opencode",
  "pi",
]
const AGENT_ORDER = EXTERNAL_AGENT_ORDER
const SCOPE_ORDER: ExternalMemoryScope[] = [
  "user",
  "global",
  "managed",
  "project",
  "auto",
  "memories",
]

/** Discover every external memory file, de-duped and ordered. */
export async function discoverExternalMemory(ctx: DiscoverCtx): Promise<ExternalMemoryFile[]> {
  const [claude, codex, opencode, pi] = await Promise.all([
    discoverClaudeCode(ctx),
    discoverCodex(ctx),
    discoverOpencode(ctx),
    discoverPi(ctx),
  ])
  const byKey = new Map<string, ExternalMemoryFile>()
  // Order matters: a project `AGENTS.md` is read by BOTH Codex and OpenCode,
  // so whichever provider comes first claims the single row for that one file.
  // Codex wins because it also owns the `AGENTS.override.md` sibling.
  // Pi is last: it reads the same AGENTS.md/CLAUDE.md the others do, but only
  // contributes its own SYSTEM.md / APPEND_SYSTEM.md, so it can never steal a
  // shared row from the provider that owns it. Losing claimants are not
  // dropped — they accumulate into `consumers` so the row still records every
  // runtime the file feeds.
  for (const file of [...claude, ...codex, ...opencode, ...pi]) {
    const existing = byKey.get(file.id)
    if (!existing) {
      // First writer wins; providers already emit precedence-ordered entries.
      byKey.set(file.id, file.consumers ? file : { ...file, consumers: [file.agent] })
      continue
    }
    const consumers = existing.consumers ?? [existing.agent]
    if (!consumers.includes(file.agent)) existing.consumers = [...consumers, file.agent]
  }
  return [...byKey.values()].sort(compareFiles)
}

/**
 * The directories the guarded editor may write under: the active workspace
 * roots plus every agent's global config dir, resolved by the SAME functions
 * discovery uses. A provider that marks a global file editable must have its
 * dir here, or the save guard refuses the file it just offered (OpenCode's
 * `AGENTS.md`, Pi's `SYSTEM.md` used to). Editability is still decided per
 * file by the provider; this list only bounds where any write may land.
 */
export function externalMemoryWriteRoots(
  ctx: Pick<DiscoverCtx, "home" | "roots" | "vendorRoots">
): string[] {
  const agentDirs = ctx.home
    ? [claudeConfigDir(ctx), codexHomeDir(ctx), opencodeConfigDir(ctx), piAgentDir(ctx)]
    : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const dir of [...ctx.roots, ...agentDirs]) {
    if (!dir) continue
    const key = pathKey(dir)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(dir)
  }
  return out
}

function compareFiles(a: ExternalMemoryFile, b: ExternalMemoryFile): number {
  const agent = AGENT_ORDER.indexOf(a.agent) - AGENT_ORDER.indexOf(b.agent)
  if (agent !== 0) return agent
  const scope = SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope)
  if (scope !== 0) return scope
  return pathKey(a.absPath).localeCompare(pathKey(b.absPath))
}
