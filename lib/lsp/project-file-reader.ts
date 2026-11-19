/**
 * Host-injectable reader for a project-local `.cognia/lsp.json`.
 *
 * Injected into `resolveLspServers` (`lib/lsp/resolve-config.ts`) as the
 * `readProjectFile` dependency. Kept out of the pure resolver so that module
 * stays filesystem-free and unit-testable. Returns `null` whenever the file
 * is absent, unreadable, or malformed, or when not running under Tauri (web /
 * mobile shells have no project filesystem) — the project layer is then empty.
 *
 * Reads through the root-confined `fs_read_workspace_file`, not the raw
 * absolute-path read: the root can be a character's or a session's working
 * directory that was never registered as a project root, and the raw read
 * refuses anything outside the registered roots.
 */

import { isTauri } from "@/lib/tauri"
import { isHeadlessHost } from "@/lib/platform/detect"
import { getRemoteLspTransport } from "@/lib/lsp/host-transport"
import { readWorkspaceFile } from "@/lib/files/workspace-fs"
import type { LspProjectFile, LspServerConfig } from "@/types/lsp/config"

/** Relative path of the project-local config under a workspace root. */
export const PROJECT_LSP_CONFIG_RELPATH = ".cognia/lsp.json"

/**
 * Read `<rootDir>/.cognia/lsp.json`. Returns the parsed file, or `null` on any
 * failure (missing file, parse error, or non-Tauri host without an injected reader).
 */
export async function readProjectLspFile(
  rootDir: string,
  read?: (rootDir: string, relPath: string) => Promise<string>
): Promise<LspProjectFile | null> {
  if (!read && !isTauri() && !isHeadlessHost() && !getRemoteLspTransport()) return null
  let raw: string
  try {
    raw = await (read ?? ((root, rel) => readWorkspaceFile(root, rel, 256 * 1024)))(
      rootDir,
      PROJECT_LSP_CONFIG_RELPATH
    )
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    const servers = (parsed as LspProjectFile | null)?.servers
    if (!Array.isArray(servers)) return null
    return { servers: servers.filter(isServerOverride) }
  } catch {
    return null
  }
}

function isServerOverride(value: unknown): value is LspServerConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  if (typeof entry.id !== "string" || !entry.id.trim()) return false
  for (const key of [
    "languages",
    "args",
    "extensions",
    "filenames",
    "rootMarkers",
    "excludeRootMarkers",
  ]) {
    const values = entry[key]
    if (
      values !== undefined &&
      (!Array.isArray(values) || values.some((item) => typeof item !== "string"))
    )
      return false
  }
  for (const key of ["name", "command", "endpoint"]) {
    if (entry[key] !== undefined && typeof entry[key] !== "string") return false
  }
  if (entry.transport !== undefined && entry.transport !== "stdio" && entry.transport !== "socket")
    return false
  for (const key of ["startupTimeout", "memoryLimitMb"]) {
    const number = entry[key]
    if (
      number !== undefined &&
      (typeof number !== "number" || !Number.isFinite(number) || number <= 0)
    )
      return false
  }
  return true
}
