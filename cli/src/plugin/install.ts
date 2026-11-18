/**
 * Node-side GitHub plugin installer for the CLI. The desktop installs via the
 * Rust `plugin_install_from_github` command; the standalone CLI has no Tauri,
 * so this fetches the plugin's directory tree over the public GitHub contents
 * API (reusing `github-source.ts`) and installs it as `~/.cognia/plugins/<id>/`.
 *
 * Frontend-only — non-frontend manifests are rejected (they need the Tauri host).
 *
 * ## Staged, then swapped
 *
 * The tree is written into a private staging directory and only then swapped
 * in for the live one with two renames. Writing file by file into the live
 * directory meant a failure halfway left a new `plugin.json` beside old code,
 * and a successful update kept every file the new version had dropped. The
 * staged tree is the whole installed tree, so its fingerprint describes what
 * is on disk afterwards, not just what this download fetched.
 */
import nodeFs from "node:fs/promises"
import path from "node:path"

import {
  parseGithubPluginRef,
  fetchGithubPluginPreview,
  type GithubPluginRef,
} from "@/lib/plugin/package/github-source"
import { isValidPluginId } from "@/lib/plugin/core/validation"
import type { PluginManifest } from "@/types/plugin"

import { createRuntimeHasher } from "../runtime/crypto-hasher"

const GITHUB_API = "https://api.github.com"

export interface InstallFs {
  mkdir: (p: string, opts?: { recursive?: boolean }) => Promise<unknown>
  writeFile: (p: string, data: string | Uint8Array) => Promise<void>
  /** A fresh, empty directory whose name starts with `prefix`. */
  mkdtemp: (prefix: string) => Promise<string>
  rename: (from: string, to: string) => Promise<void>
  rm: (p: string, opts: { recursive: boolean; force: boolean }) => Promise<void>
  exists: (p: string) => Promise<boolean>
}

export interface InstallDeps {
  home: string
  fs?: InstallFs
  /**
   * The plugin id the caller expects. A source whose manifest names another
   * plugin is refused before anything is written, so an update of `a` can
   * never install `b` (or overwrite it).
   */
  expectedId?: string
  /** Cancels the install up to the swap; once the swap starts it completes. */
  signal?: AbortSignal
}

export interface InstallResult {
  id: string
  dir: string
  manifest: PluginManifest
  /** SHA-256 of the installed tree (rel-path-sorted contents), lowercase hex. */
  fingerprint: string
}

/** A downloaded tree waiting to replace the live install. */
export interface StagedInstall extends InstallResult {
  /** Swap the staged tree in for the live directory. Runs at most once. */
  commit: () => Promise<void>
  /** Remove the staged tree. A no-op after a commit. */
  discard: () => Promise<void>
}

const defaultFs: InstallFs = {
  mkdir: (p, o) => nodeFs.mkdir(p, o),
  writeFile: (p, d) => nodeFs.writeFile(p, d),
  mkdtemp: (prefix) => nodeFs.mkdtemp(prefix),
  rename: (from, to) => nodeFs.rename(from, to),
  rm: (p, o) => nodeFs.rm(p, o),
  exists: async (p) => {
    try {
      await nodeFs.lstat(p)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
      throw error
    }
  },
}

interface ContentNode {
  type?: string
  path?: string
  content?: string
}

function refQuery(ref?: string): string {
  return ref ? `?ref=${encodeURIComponent(ref)}` : ""
}

async function ghJson(ref: GithubPluginRef, repoPath: string): Promise<unknown> {
  const url = `${GITHUB_API}/repos/${ref.owner}/${ref.repo}/contents/${repoPath}${refQuery(ref.ref)}`
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${repoPath || "/"}`)
  return res.json()
}

/** Recursively collect files (relative to `base`) under a repo directory. */
async function walk(
  ref: GithubPluginRef,
  dir: string,
  base: string,
  out: Array<{ rel: string; repoPath: string }>,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  const listing = await ghJson(ref, dir)
  if (!Array.isArray(listing)) return
  for (const node of listing as ContentNode[]) {
    if (!node.path) continue
    if (node.type === "file") {
      const rel = base ? node.path.slice(base.length).replace(/^\/+/, "") : node.path
      out.push({ rel, repoPath: node.path })
    } else if (node.type === "dir") {
      await walk(ref, node.path, base, out, signal)
    }
  }
}

async function fetchFileContent(ref: GithubPluginRef, repoPath: string): Promise<Uint8Array> {
  const json = (await ghJson(ref, repoPath)) as ContentNode | null
  if (!json || json.type !== "file" || typeof json.content !== "string") {
    throw new Error(`not a file: ${repoPath}`)
  }
  return Buffer.from(json.content.replace(/\s/g, ""), "base64")
}

/** A plugin-relative path, refused if it would leave the plugin directory. */
function containedRel(rel: string, what: string): string {
  const slashed = rel.replaceAll("\\", "/")
  const normalized = path.posix.normalize(slashed)
  if (
    !normalized ||
    normalized === "." ||
    normalized !== slashed ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`${what} escapes the plugin directory: ${rel}`)
  }
  return normalized
}

function pluginsRoot(home: string): string {
  return path.join(home, ".cognia", "plugins")
}

/** Staging lives beside, not inside, the plugins root: discovery never sees it. */
function stagingRoot(home: string): string {
  return path.join(home, ".cognia", "plugin-staging")
}

/**
 * Download a plugin from a GitHub reference (`owner/repo[@ref][/subdir]`) into
 * a staging directory. Nothing under `~/.cognia/plugins/` changes until
 * {@link StagedInstall.commit}.
 */
export async function stageFromGithubRef(
  repoRef: string,
  deps: InstallDeps
): Promise<StagedInstall> {
  const fs = deps.fs ?? defaultFs
  const { signal } = deps
  signal?.throwIfAborted()
  const parsed = parseGithubPluginRef(repoRef)

  // Resolve manifest + the dir it actually lives in (handles monorepo probing).
  const preview = await fetchGithubPluginPreview(parsed)
  signal?.throwIfAborted()
  const manifest = preview.manifest
  if (manifest.type !== "frontend") {
    throw new Error(
      `Plugin "${manifest.id}" type "${manifest.type}" is unsupported in CLI (needs the desktop host).`
    )
  }
  if (!isValidPluginId(manifest.id)) {
    throw new Error(`Plugin id "${manifest.id}" is not a valid plugin id`)
  }
  if (deps.expectedId !== undefined && manifest.id !== deps.expectedId) {
    throw new Error(
      `${repoRef} now provides plugin "${manifest.id}", not "${deps.expectedId}"; nothing was installed`
    )
  }
  const baseDir = preview.ref.subdir ?? ""

  const files: Array<{ rel: string; repoPath: string }> = []
  await walk(preview.ref, baseDir, baseDir, files, signal)

  await fs.mkdir(stagingRoot(deps.home), { recursive: true })
  const staging = await fs.mkdtemp(path.join(stagingRoot(deps.home), `${manifest.id}-`))
  const destRoot = path.join(pluginsRoot(deps.home), manifest.id)
  const installed = new Map<string, string | Uint8Array>()
  const write = async (rel: string, content: string | Uint8Array) => {
    installed.set(rel, content)
    const destPath = path.join(staging, ...rel.split("/"))
    await fs.mkdir(path.dirname(destPath), { recursive: true })
    await fs.writeFile(destPath, content)
  }
  try {
    for (const file of files) {
      signal?.throwIfAborted()
      await write(
        containedRel(file.rel, "repository file"),
        await fetchFileContent(preview.ref, file.repoPath)
      )
    }
    for (const [rel, content] of Object.entries(preview.generatedFiles)) {
      await write(containedRel(rel, "generated conversion file"), content)
    }
    signal?.throwIfAborted()
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }

  let state: "staged" | "committed" | "discarded" = "staged"
  return {
    id: manifest.id,
    dir: destRoot,
    manifest,
    fingerprint: bundleFingerprint(Array.from(installed, ([rel, content]) => ({ rel, content }))),
    async commit() {
      if (state !== "staged") throw new Error(`staged install of ${manifest.id} is ${state}`)
      await fs.mkdir(pluginsRoot(deps.home), { recursive: true })
      const previous = `${staging}.previous`
      const hadPrevious = await fs.exists(destRoot)
      if (hadPrevious) await fs.rename(destRoot, previous)
      try {
        await fs.rename(staging, destRoot)
      } catch (error) {
        if (hadPrevious) await fs.rename(previous, destRoot)
        throw error
      }
      state = "committed"
      // The new tree is live; a leftover copy of the old one is only garbage.
      if (hadPrevious) await fs.rm(previous, { recursive: true, force: true }).catch(() => {})
    },
    async discard() {
      if (state !== "staged") return
      state = "discarded"
      await fs.rm(staging, { recursive: true, force: true })
    },
  }
}

/**
 * Install a plugin from a GitHub reference (`owner/repo[@ref][/subdir]`) into
 * `~/.cognia/plugins/<id>/`. Returns the installed id, dir, and manifest.
 */
export async function installFromGithubRef(
  repoRef: string,
  deps: InstallDeps
): Promise<InstallResult> {
  const staged = await stageFromGithubRef(repoRef, deps)
  try {
    deps.signal?.throwIfAborted()
    await staged.commit()
  } finally {
    await staged.discard()
  }
  return {
    id: staged.id,
    dir: staged.dir,
    manifest: staged.manifest,
    fingerprint: staged.fingerprint,
  }
}

/**
 * Stable SHA-256 over a bundle's contents — sorts by rel path so the order in
 * which GitHub lists files never changes the hash. Used to detect whether an
 * update actually changed anything ("content changed" vs "already up to date").
 */
export function bundleFingerprint(
  files: Array<{ rel: string; content: string | Uint8Array }>
): string {
  const hash = createRuntimeHasher("sha256")
  for (const f of [...files].sort((a, b) => a.rel.localeCompare(b.rel))) {
    hash.update(f.rel)
    hash.update("\0")
    hash.update(f.content)
    hash.update("\0")
  }
  return hash.digest("hex")
}
