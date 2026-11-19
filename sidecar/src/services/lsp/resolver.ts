// Agent-side LSP resolver.
//
// This is the thin layer that turns "the agent touched a file" into the
// right `LspService.start(...)` + document-sync calls. It owns NO
// transport or lifecycle of its own — `LspService` (reused from
// vscode-ext-host) does spawning, dedupe, request dispatch, and
// diagnostics. The resolver only:
//   1. picks the candidate server(s) for a file (servers.ts),
//   2. resolves the workspace root,
//   3. ensures the binary exists (PATH probe / Phase 4 install ladder),
//   4. builds LspStartParams and drives the injected LspService,
//   5. caches push-diagnostics so the PostToolUse hook and the `lsp`
//      tool can read them synchronously.
//
// The LspService is injected so unit tests can substitute a fake that
// records calls without spawning a real language server.

import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

import {
  sandboxedProcessTarget,
  sandboxedProcessEnv,
  resolveProcessPortEnv,
} from "../../platform/process/exec.ts"
import type { ProcessSandboxScope } from "../../platform/process/exec.ts"
import { assertPathInside, canonicalisePartial, resolveToolPath } from "../../platform/fs/paths.ts"
import { isSecretPath } from "../../platform/fs/secret-paths.ts"
import { buildServers, languageIdForFile, serversForFile } from "./servers.ts"
import type { LspInstallSpec, ServerInfo } from "./servers.ts"

/** Identifies one open document on one server. */
interface DocumentParams {
  ownerId: string
  serverId: string
  uri: string
  languageId: string
  text: string
}

/** The vscode-ext-host `LspService` surface the resolver drives. */
export interface LspServiceLike {
  start(params: Record<string, unknown>): Promise<unknown>
  didOpen(params: DocumentParams): void
  didChange(params: DocumentParams): void
  request(params: {
    ownerId: string
    serverId: string
    method: string
    payload: Record<string, unknown>
  }): Promise<unknown>
  stop(ownerId: string, serverId: string): unknown
}

export interface LspLogger {
  info?(message: string, details?: unknown): void
  warn?(message: string, details?: unknown): void
  error?(message: string, details?: unknown): void
}

/** Resolve a server binary: a path, or null when it is unavailable. */
export type EnsureCommand = (
  command: string,
  ctx: { serverId: string; root: string; install?: LspInstallSpec | undefined }
) => Promise<string | null> | string | null

export interface LspResolverOptions {
  service: LspServiceLike
  /** Agent working directory (root boundary). */
  cwd: string
  additionalDirectories?: readonly string[] | undefined
  /** Resolved LSP config list (from `sendOptions.lsp.servers`). */
  servers?: unknown
  ensureCommand?: EnsureCommand | undefined
  logger?: LspLogger | undefined
  diagnosticsWaitMs?: number
  now?: () => number
  builtinProcessSandbox?: ProcessSandboxScope | undefined
}

/** A published diagnostics notification, as `lsp:publishDiagnostics` carries it. */
export interface PublishDiagnosticsParams {
  uri?: string
  serverId?: string
  version?: number
  diagnostics?: unknown[]
}

export interface LspResolver {
  touchFile(absPath: string, text?: string): Promise<string[]>
  getDiagnostics(absPath: string, opts?: { text?: string; waitMs?: number }): Promise<unknown[]>
  request(absPath: string, method: string, payload?: Record<string, unknown>): Promise<unknown>
  ingestDiagnostics(params: PublishDiagnosticsParams | null | undefined): void
  forgetDiagnostics?(serverId: string): void
  dispose(): Promise<void>
}

const OWNER = "agent"
const DEFAULT_DIAGNOSTICS_WAIT_MS = 800
const SERVER_RETRY_MS = 15_000

/** Stable, short, dependency-free hash for serverId disambiguation. */
function djb2(str: string): string {
  let h = 5381
  for (let i = 0; i < str.length; i++) h = (h * 33) ^ str.charCodeAt(i)
  return (h >>> 0).toString(36)
}

/** Default binary check: resolve `command` against PATH (sync). */
function defaultEnsureCommand(command: string): string | null {
  if (!command) return null
  // Explicit path — trust it if it exists.
  if (command.includes(path.sep) || command.includes("/")) {
    return fs.existsSync(command) ? command : null
  }
  const envPath = process.env.PATH || process.env.Path || ""
  const dirs = envPath.split(path.delimiter).filter(Boolean)
  const exts =
    process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";") : [""]
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext)
      try {
        if (fs.existsSync(candidate)) return candidate
      } catch {
        /* ignore */
      }
    }
  }
  return null
}

function normalizeUri(uri: string): string {
  return process.platform === "win32" ? uri.toLowerCase() : uri
}

export function createLspResolver(args: LspResolverOptions): LspResolver {
  const { service, cwd } = args
  const ensureCommand: EnsureCommand = args.ensureCommand ?? defaultEnsureCommand
  const logger: LspLogger = args.logger ?? {}
  const diagnosticsWaitMs = args.diagnosticsWaitMs ?? DEFAULT_DIAGNOSTICS_WAIT_MS
  const now = args.now ?? Date.now
  const workspaceRoots = [cwd, ...(args.additionalDirectories ?? [])]
  // The runnable server list is built once from the injected config. The
  // sidecar no longer owns a hard-coded registry — it consumes whatever the
  // renderer resolved (builtin ← user ← project).
  const builtServers = buildServers(args.servers ?? [])

  /** server and normalized URI -> latest diagnostics for the current text */
  const diagnostics = new Map<string, unknown[]>()
  /** serverId -> { server, root } */
  const servers = new Map<string, { server: ServerInfo; root: string }>()
  const openDocs = new Map<string, string>()
  const retryAt = new Map<string, number>()
  const starting = new Map<string, Promise<string | null>>()
  let disposed = false

  const docKey = (serverId: string, uri: string) => `${serverId}\n${normalizeUri(uri)}`

  /** Feed a `lsp:publishDiagnostics` notification payload into the cache. */
  function ingestDiagnostics(params: PublishDiagnosticsParams | null | undefined): void {
    if (!params || !params.uri) return
    const uri = params.uri
    // Older host bundles did not always stamp the server id. Accept their
    // frames only if there is exactly one matching open document.
    const keys = params.serverId
      ? [docKey(params.serverId, uri)]
      : [...openDocs.keys()].filter((key) => key.endsWith(`\n${normalizeUri(uri)}`))
    const key = keys.length === 1 ? keys[0] : undefined
    if (key && openDocs.has(key)) diagnostics.set(key, params.diagnostics ?? [])
  }

  function forgetDiagnostics(serverId: string): void {
    for (const key of diagnostics.keys())
      if (key.startsWith(`${serverId}\n`)) diagnostics.delete(key)
  }

  function serverIdFor(server: ServerInfo, root: string): string {
    return `${server.id}#${djb2(root)}`
  }

  async function ensureServer(server: ServerInfo, root: string): Promise<string | null> {
    const serverId = serverIdFor(server, root)
    if (disposed) throw new Error("lsp: session is closed")
    if (servers.has(serverId)) return serverId
    if ((retryAt.get(serverId) ?? -Infinity) > now()) return null
    let pending = starting.get(serverId)
    if (!pending) {
      pending = startServer(server, root, serverId).finally(() => starting.delete(serverId))
      starting.set(serverId, pending)
    }
    return pending
  }

  async function startServer(
    server: ServerInfo,
    root: string,
    serverId: string
  ): Promise<string | null> {
    const portEnv = await resolveProcessPortEnv(root)
    const spawn = server.resolveCommand(root, { cwd })
    const resolved = await ensureCommand(spawn.command, { serverId, root, install: server.install })
    if (!resolved) {
      retryAt.set(serverId, now() + SERVER_RETRY_MS)
      logger.warn?.(`[lsp] binary not found for ${server.id}: ${spawn.command} (skipping)`)
      return null
    }
    const folderUri = pathToFileURL(root.endsWith(path.sep) ? root : root + path.sep).href
    try {
      if (disposed) return null
      if (
        server.transport === "socket" &&
        args.builtinProcessSandbox &&
        args.builtinProcessSandbox.network !== true
      ) {
        throw new Error("lsp: socket transport requires sandbox network permission")
      }
      const target = sandboxedProcessTarget(
        resolved,
        spawn.args ?? [],
        root,
        args.builtinProcessSandbox
      )
      await service.start({
        ownerId: OWNER,
        serverId,
        command: target.command,
        args: target.args,
        env: sandboxedProcessEnv(
          args.builtinProcessSandbox ? process.env : {},
          args.builtinProcessSandbox,
          spawn.env,
          portEnv
        ),
        ...(args.builtinProcessSandbox ? { inheritEnv: false } : {}),
        cwd: root,
        transport: server.transport ?? "stdio",
        endpoint: server.endpoint,
        startupTimeout: server.startupTimeout,
        memoryLimitMb: server.memoryLimitMb,
        workspaceFolders: [{ uri: folderUri, name: path.basename(root) || root }],
        initializationOptions: spawn.initializationOptions,
        // Per-server `settings` drive the LSP `workspace/configuration` pull
        // and the post-init `didChangeConfiguration` push (lsp-client).
        settings: server.settings,
      })
    } catch (err) {
      retryAt.set(serverId, now() + SERVER_RETRY_MS)
      logger.warn?.(`[lsp] failed to start ${server.id}`, {
        err: err instanceof Error ? err.message : String(err),
      })
      return null
    }
    servers.set(serverId, { server, root })
    retryAt.delete(serverId)
    return serverId
  }

  /**
   * Open/sync a file with every applicable server. Returns the serverIds
   * that were touched (running). Lazy: spawns a server only on first
   * matching touch. `text` is the current contents; read from disk when omitted.
   */
  async function touchFile(absPath: string, text?: string): Promise<string[]> {
    if (disposed) throw new Error("lsp: session is closed")
    absPath = resolveToolPath(cwd, absPath)
    const real = canonicalisePartial(absPath)
    const inside = (root: string) => {
      try {
        assertPathInside(root, real)
        return true
      } catch {
        return false
      }
    }
    if (isSecretPath(absPath) || isSecretPath(real))
      throw new Error("lsp: protected credential path")
    const workspace = workspaceRoots.find(inside)
    const scope = args.builtinProcessSandbox
    if (
      !workspace ||
      (scope && ![...(scope.writableRoots ?? []), ...(scope.readableRoots ?? [])].some(inside))
    ) {
      throw new Error("lsp: file is outside authorized workspace roots")
    }
    // A symlink outside the workspace can resolve to an authorized file.
    // Do not let its lexical parent choose the server's workspace/cwd.
    const lexicalRoot = [workspace, canonicalisePartial(workspace)].find((root) => {
      const relative = path.relative(root, absPath)
      return (
        relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      )
    })
    if (!lexicalRoot) throw new Error("lsp: file is outside authorized workspace roots")
    const candidates = serversForFile(absPath, builtServers)
    if (candidates.length === 0) return []
    let content = text
    if (content == null) {
      try {
        content = fs.readFileSync(real, "utf-8")
      } catch {
        return []
      }
    }
    const uri = pathToFileURL(absPath).href
    const touched: string[] = []
    for (const server of candidates) {
      const root = server.root(absPath, { cwd: lexicalRoot })
      if (!root) continue
      try {
        assertPathInside(workspace, root)
      } catch {
        continue
      }
      const serverId = await ensureServer(server, root)
      if (!serverId || disposed) continue
      const key = docKey(serverId, uri)
      const previous = openDocs.get(key)
      try {
        if (previous !== content) {
          diagnostics.delete(key)
          openDocs.set(key, content)
          const params = {
            ownerId: OWNER,
            serverId,
            uri,
            languageId: languageIdForFile(absPath, server),
            text: content,
          }
          if (previous === undefined) service.didOpen(params)
          else service.didChange(params)
        }
        touched.push(serverId)
      } catch (err) {
        if (previous === undefined) openDocs.delete(key)
        else openDocs.set(key, previous)
        logger.warn?.(`[lsp] didOpen/didChange failed for ${serverId}`, {
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return touched
  }

  /**
   * touchFile then wait briefly for push-diagnostics to land, returning
   * the cached diagnostics for the file (possibly empty).
   */
  async function getDiagnostics(
    absPath: string,
    opts: { text?: string; waitMs?: number } = {}
  ): Promise<unknown[]> {
    const touched = await touchFile(absPath, opts.text)
    if (touched.length === 0) throw new Error(`lsp: no language server available for ${absPath}`)
    const uri = pathToFileURL(resolveToolPath(cwd, absPath)).href
    const keys = touched.map((id) => docKey(id, uri))
    if (keys.some((key) => !diagnostics.has(key))) await delay(opts.waitMs ?? diagnosticsWaitMs)
    const current = keys.flatMap((key) => diagnostics.get(key) ?? [])
    if (current.length === 0 && keys.some((key) => !diagnostics.has(key))) {
      throw new Error(`lsp: diagnostics not yet available for ${absPath}`)
    }
    return current
  }

  /**
   * Run an LSP provider request for a file. Ensures a server is running,
   * then reuses `LspService.request`. Position is LSP-shaped (0-based).
   * `method` is e.g. "definition" | "references" | "hover" | "documentSymbol";
   * `payload` must include the per-method fields (position, etc.).
   */
  async function request(
    absPath: string,
    method: string,
    payload: Record<string, unknown> = {}
  ): Promise<unknown> {
    const touched = await touchFile(absPath, payload.text as string | undefined)
    if (touched.length === 0) {
      throw new Error(`lsp: no language server available for ${absPath}`)
    }
    const uri = pathToFileURL(resolveToolPath(cwd, absPath)).href
    let empty: unknown
    let supported = false
    for (const serverId of touched) {
      try {
        const result = await service.request({
          ownerId: OWNER,
          serverId,
          method,
          payload: { ...payload, uri },
        })
        if (result != null && (!Array.isArray(result) || result.length > 0)) return result
        empty = result
        supported = true
      } catch (error) {
        if (
          (error as { code?: number })?.code !== -32601 &&
          !/method not found/i.test(String(error))
        )
          throw error
      }
    }
    if (supported) return empty
    throw new Error(`lsp: no applicable server supports ${method}`)
  }

  /** Stop all servers this resolver started. */
  async function dispose(): Promise<void> {
    disposed = true
    await Promise.allSettled([...starting.values()])
    for (const serverId of servers.keys()) {
      try {
        await service.stop(OWNER, serverId)
      } catch {
        /* swallow */
      }
    }
    servers.clear()
    openDocs.clear()
    diagnostics.clear()
    retryAt.clear()
  }

  return { touchFile, getDiagnostics, request, ingestDiagnostics, forgetDiagnostics, dispose }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
