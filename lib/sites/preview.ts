"use client"

import { getSiteEnvironmentRevision, getSiteProject } from "@/lib/db/sites"
import { readTextFile } from "@/lib/file/file-operations"
import { proxyFetch } from "@/lib/network/proxy-fetch"
import { detectOsFamily, type OsFamily } from "@/lib/platform/os"
import { killFromDock, spawnFromDock, type SpawnOutcome } from "@/lib/terminal/spawn-orchestrator"
import { parseSiteHostingManifest } from "./manifest"
import { resolveSiteManifestPath, resolveSiteSourceDir } from "./manifest-file"
import { assertSiteAuthoringCapability } from "./authoring-policy"
import { useTerminalStore } from "@/stores/terminal/terminal-store"

export interface SitePreviewSession {
  siteId: string
  terminalSessionId: string
  url: string
}

interface SitePreviewDeps {
  join: (...parts: string[]) => Promise<string>
  readText: typeof readTextFile
  spawn: (input: Parameters<typeof spawnFromDock>[0]) => Promise<SpawnOutcome>
  stop: (sessionId: string) => Promise<void>
  waitUntilReady: (url: string) => Promise<void>
  actorAccountId: string
  storage: PreviewStorage | undefined
  osFamily: () => OsFamily
}

const sessions = new Map<string, SitePreviewSession>()

/**
 * Which terminal each running preview is, by exact id, across a reload.
 *
 * The module map dies with the renderer while the PTY lives on and is
 * reattached by id (`lib/terminal/boot-reattach.ts`). Resume used to rebuild
 * the pairing from `projectId` + `cwd`, which an ordinary terminal the user
 * opened in the Site's folder also matches — and "Stop preview" then killed
 * that terminal. Ownership is now recorded when Sites spawns the preview and
 * nothing else is ever adopted.
 */
const OWNERSHIP_KEY = "cognia:sites:preview-terminals"

type PreviewStorage = Pick<Storage, "getItem" | "setItem">

interface PreviewOwnership {
  terminalSessionId: string
  url: string
}

function browserStorage(): PreviewStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

function readOwnership(storage: PreviewStorage | undefined): Record<string, PreviewOwnership> {
  if (!storage) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(storage.getItem(OWNERSHIP_KEY) ?? "{}")
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  const owned: Record<string, PreviewOwnership> = {}
  for (const [siteId, value] of Object.entries(parsed)) {
    const record = value as Partial<PreviewOwnership> | null
    if (
      record &&
      typeof record.terminalSessionId === "string" &&
      record.terminalSessionId &&
      typeof record.url === "string" &&
      record.url
    ) {
      owned[siteId] = { terminalSessionId: record.terminalSessionId, url: record.url }
    }
  }
  return owned
}

function writeOwnership(
  storage: PreviewStorage | undefined,
  siteId: string,
  record: PreviewOwnership | undefined
): void {
  if (!storage) return
  const owned = readOwnership(storage)
  if (record) owned[siteId] = record
  else delete owned[siteId]
  try {
    storage.setItem(OWNERSHIP_KEY, JSON.stringify(owned))
  } catch {
    // A full or disabled store only costs the reload case: the preview is
    // then reported as not running rather than adopted wrongly.
  }
}

async function defaultWaitUntilReady(url: string): Promise<void> {
  const deadline = Date.now() + 30_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      // `proxyFetch`, even though the target is loopback: the packaged shell's
      // `connect-src` does not list `http://localhost:<port>` any more than it
      // lists a public host, so a renderer `fetch` here never reached the dev
      // server it was polling. Loopback is in the default bypass list, so the
      // native side still dials direct.
      const response = await proxyFetch(url, { method: "GET", cache: "no-store" })
      if (response.ok || response.type === "opaque") return
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(
    `Site preview did not become ready: ${lastError instanceof Error ? lastError.message : "timeout"}`
  )
}

function defaults(): SitePreviewDeps {
  return {
    join: async (...parts) => {
      const path = await import("@tauri-apps/api/path")
      return path.join(...parts)
    },
    readText: readTextFile,
    spawn: spawnFromDock,
    stop: (sessionId) => killFromDock(sessionId, useTerminalStore.getState()),
    waitUntilReady: defaultWaitUntilReady,
    actorAccountId: "local-user",
    storage: browserStorage(),
    osFamily: detectOsFamily,
  }
}

export async function startSitePreview(
  siteId: string,
  environmentRevisionId: string,
  dependencies?: Partial<SitePreviewDeps>
): Promise<SitePreviewSession> {
  const existing = sessions.get(siteId)
  if (existing) return existing
  const deps = { ...defaults(), ...dependencies }
  // The preview always runs sandboxed, and the terminal sandbox has no
  // Windows backend yet. Refusing here, not only in the console gate, keeps a
  // caller from spawning an unconfined dev server by going around the UI.
  if (deps.osFamily() === "windows") {
    throw new Error("Site previews need the terminal sandbox, which Windows does not provide yet")
  }
  const site = await getSiteProject(siteId)
  if (
    !site ||
    site.lifecycle !== "active" ||
    (site.executionTarget as { kind?: unknown }).kind !== "local"
  ) {
    throw new Error("active local Site project not found")
  }
  assertSiteAuthoringCapability(site.authoringPolicy, deps.actorAccountId, "edit")
  const environment = await getSiteEnvironmentRevision(environmentRevisionId)
  if (!environment || environment.siteId !== site.id)
    throw new Error("Site environment revision not found")
  const sourceDir = await resolveSiteSourceDir(site, deps.join)
  const manifest = parseSiteHostingManifest(
    await deps.readText(await resolveSiteManifestPath(site, deps.join))
  )
  const [shell, ...args] = manifest.preview.command
  const outcome = await deps.spawn({
    req: {
      shell,
      args,
      cwd: sourceDir,
      env: environment.variables,
      rows: 24,
      cols: 100,
      projectId: site.projectId,
      enableShellIntegration: false,
      forceUtf8: true,
      origin: "local",
      sandboxed: true,
      // A dev server is a network program: it binds a loopback port, which
      // the macOS sandbox profile refuses without network, and its readiness
      // probe below dials that port from the host. Writes stay confined.
      sandboxNetwork: true,
    },
    store: useTerminalStore.getState(),
    // The readiness probe dials this machine's `localhost`, so the server must
    // run here even while the terminal dock is pointed at a remote Host.
    local: true,
  })
  if (outcome.kind !== "spawned") {
    throw new Error(outcome.kind === "error" ? outcome.message : "Site preview spawn was denied")
  }
  try {
    await deps.waitUntilReady(manifest.preview.url)
  } catch (error) {
    await deps.stop(outcome.sessionId)
    throw error
  }
  const session = { siteId, terminalSessionId: outcome.sessionId, url: manifest.preview.url }
  sessions.set(siteId, session)
  writeOwnership(deps.storage, siteId, {
    terminalSessionId: session.terminalSessionId,
    url: session.url,
  })
  return session
}

export async function stopSitePreview(
  siteId: string,
  dependencies?: Partial<Pick<SitePreviewDeps, "stop" | "storage">>
): Promise<void> {
  const session = sessions.get(siteId)
  if (!session) return
  sessions.delete(siteId)
  const base = defaults()
  writeOwnership(dependencies?.storage ?? base.storage, siteId, undefined)
  await (dependencies?.stop ?? base.stop)(session.terminalSessionId)
}

export function getSitePreviewSession(siteId: string): SitePreviewSession | undefined {
  return sessions.get(siteId)
}

interface ResumePreviewDeps {
  storage: PreviewStorage | undefined
  listSessions: () => Array<{
    id: string
    projectId: string | null
    status: "idle" | "running" | "exited"
  }>
}

/**
 * Re-adopt a preview whose in-memory record was lost to a renderer reload.
 *
 * Only the terminal Sites itself spawned for this Site, by exact id, and only
 * while it is still running in the Site's project. A full app restart finds the
 * id gone — the PTY died with the process — so "not started" is then the
 * honest state, and the stale record is dropped.
 *
 * Never throws: a missing site, an unreadable record, or no live terminal all
 * resolve to `undefined`.
 */
export async function resumeSitePreviewSession(
  siteId: string,
  dependencies?: Partial<ResumePreviewDeps>
): Promise<SitePreviewSession | undefined> {
  const existing = sessions.get(siteId)
  if (existing) return existing
  const deps: ResumePreviewDeps = {
    storage: browserStorage(),
    listSessions: () => Object.values(useTerminalStore.getState().sessions),
    ...dependencies,
  }
  try {
    const owned = readOwnership(deps.storage)[siteId]
    if (!owned) return undefined
    const site = await getSiteProject(siteId)
    const terminal = deps.listSessions().find((row) => row.id === owned.terminalSessionId)
    if (
      !site ||
      site.lifecycle !== "active" ||
      !terminal ||
      terminal.status === "exited" ||
      terminal.projectId !== site.projectId
    ) {
      writeOwnership(deps.storage, siteId, undefined)
      return undefined
    }
    const session: SitePreviewSession = {
      siteId,
      terminalSessionId: owned.terminalSessionId,
      url: owned.url,
    }
    sessions.set(siteId, session)
    return session
  } catch {
    return undefined
  }
}

export function __resetSitePreviewsForTesting(): void {
  sessions.clear()
}
