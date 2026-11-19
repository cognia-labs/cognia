/**
 * LSP registry — renderer-side orchestrator for the standalone-LSP
 * pathway (Phase B of the LSP reuse work, plan
 * `~/.claude/plans/vscode-lsp-mighty-robin.md`).
 *
 * Roles:
 *
 *   1. Track every running LSP server keyed by `${ownerId}:${serverId}`.
 *      `ownerId` is either a `pluginId` (when the server was contributed
 *      via `PluginManifest.lspServers`) or the literal `"user"` (when
 *      the user added it through Settings → Language Servers).
 *
 *   2. Drive the LSP-binary policy gate on every spawn — never let an
 *      unsigned binary run without going through
 *      `lib/plugin/vscode-shim/lsp-binary-policy.ts:evaluateLspBinary`.
 *
 *   3. Bridge `publishDiagnostics` notifications from the LSP into the
 *      `monaco-bridge.setDiagnostics` API so red squigglies actually
 *      appear in the Skills/Canvas/Artifact editors.
 *
 *   4. Register Monaco providers (completion, hover, ...) for every
 *      declared `language` so the editor proxies its provider calls into
 *      the LSP via the registered `CogniaLspClient`.
 *
 * The actual LSP client process runs in the Node sidecar; the registry
 * talks to it via an injectable adapter so unit tests stay
 * deterministic and don't need a real Tauri runtime. Production code
 * wires the adapter to the `vscode-ext-host` sidecar (see B3
 * integration).
 */

import { loggers } from "@cognia/logging"
import { getRemoteLspTransport, subscribeRemoteLspTransport } from "@/lib/lsp/host-transport"
import type { PluginLspServerDef } from "@/types/plugin"
import {
  evaluateLspBinary,
  type LspBinaryEvaluation,
} from "@/lib/plugin/vscode-shim/lsp-binary-policy"
import {
  flushMaterializedDocument,
  resolveMaterializedDocumentUri,
  resolveMonacoDocumentUri,
  onWorkspaceFoldersChanged,
} from "@/lib/plugin/vscode-shim/lsp-workspace-manager"
import { registerLspMonacoProviders } from "./lsp-monaco-runtime"
import { lspServerKey } from "@cognia/plugin-contract/lib/plugin/lsp/lsp-registry"
export { lspServerKey } from "@cognia/plugin-contract/lib/plugin/lsp/lsp-registry"
import type {
  LspServerOwner,
  LspServerRecord,
  LspClientAdapter,
  LspBridgeAdapter,
} from "@cognia/plugin-contract/lib/plugin/lsp/lsp-registry"
export type {
  LspServerOwner,
  LspServerState,
  LspServerRecord,
  LspClientAdapter,
  LspServerRequestEvent,
  LspServerNotificationEvent,
  LspBridgeAdapter,
} from "@cognia/plugin-contract/lib/plugin/lsp/lsp-registry"

const lspRegistryLogger = loggers.plugin.child("lsp-registry")

interface RegistryDeps {
  client: LspClientAdapter
  bridge: LspBridgeAdapter
  /**
   * Resolve workspace folders the LSP should see (typically the
   * synthetic per-surface workspaces from `lsp-workspace-manager`).
   * Returning an empty array is fine when no surface is active yet.
   */
  resolveWorkspaceFolders: () => Array<{ uri: string; name: string }>
  /** Override `Date.now` for deterministic tests. */
  now: () => number
}

let deps: RegistryDeps | null = null
const records = new Map<string, LspServerRecord>()
const recordHosts = new Map<string, ReturnType<typeof getRemoteLspTransport>>()
const providerDisposables = new Map<string, { dispose(): void }>()
const documentServers = new Map<string, { recordKey: string; fileUri: string }>()
const diagnosticUris = new Map<string, Set<string>>()
const openEditors = new Map<
  string,
  { editorId: string; host: ReturnType<typeof getRemoteLspTransport> }
>()
let nextRegistrationOrder = 0
let unsubscribeEditorChanges: (() => void) | null = null
let unsubscribeServerState: (() => void) | null = null
let unsubscribeWorkspaceFolders: (() => void) | null = null
let unsubscribeHost: (() => void) | null = null
const documentQueues = new Map<string, Promise<void>>()

const onActiveHost = (record: LspServerRecord) =>
  recordHosts.get(record.key) === getRemoteLspTransport()

function diagnosticsFor(input: RegistryDeps, record: LspServerRecord) {
  return (uri: string, markers: Parameters<LspBridgeAdapter["setDiagnostics"]>[0]["markers"]) => {
    if (records.get(record.key) !== record || !onActiveHost(record)) return
    const resolved = resolveMonacoDocumentUri(uri)
    let seen = diagnosticUris.get(record.key)
    if (markers.length > 0) {
      if (!seen) diagnosticUris.set(record.key, (seen = new Set()))
      seen.add(resolved)
    } else {
      seen?.delete(resolved)
    }
    input.bridge.setDiagnostics({ extensionId: record.key, uri: resolved, markers })
  }
}

function clearServerDiagnostics(input: RegistryDeps, serverKey: string): void {
  for (const uri of diagnosticUris.get(serverKey) ?? []) {
    input.bridge.setDiagnostics({ extensionId: serverKey, uri, markers: [] })
  }
  diagnosticUris.delete(serverKey)
}

type EditorEvent = Parameters<Parameters<NonNullable<LspBridgeAdapter["onEditorChange"]>>[0]>[0] & {
  replay?: boolean
}

function enqueueEditorChange(input: RegistryDeps, event: EditorEvent): Promise<void> {
  const host = getRemoteLspTransport()
  const previous = documentQueues.get(event.uri) ?? Promise.resolve()
  const next = previous
    .then(() => {
      if (getRemoteLspTransport() === host) return handleEditorChange(input, event, host)
    })
    .catch((error: unknown) => {
      lspRegistryLogger.warn("lsp-registry document sync failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    })
    .finally(() => {
      if (documentQueues.get(event.uri) === next) documentQueues.delete(event.uri)
    })
  documentQueues.set(event.uri, next)
  return next
}

async function replayOpenEditors(input: RegistryDeps): Promise<void> {
  const host = getRemoteLspTransport()
  await Promise.all(
    [...openEditors].flatMap(([uri, editor]) =>
      editor.host === host
        ? [
            enqueueEditorChange(input, {
              uri,
              editorId: editor.editorId,
              kind: "open",
              replay: true,
            }),
          ]
        : []
    )
  )
}

/**
 * Wire the registry. Called once at app init (or per-test). Returns a
 * dispose function that unregisters every running server.
 */
export function configureLspRegistry(input: RegistryDeps): () => void {
  deps = input
  let activeHost = getRemoteLspTransport()
  unsubscribeHost = subscribeRemoteLspTransport(() => {
    const host = getRemoteLspTransport()
    if (host === activeHost) return
    activeHost = host
    documentServers.clear()
    for (const serverKey of diagnosticUris.keys()) clearServerDiagnostics(input, serverKey)
    reconcileProviderRegistrations(input.client)
  })
  unsubscribeEditorChanges =
    input.bridge.onEditorChange?.((event) => {
      if (event.kind === "change-selection") return
      const previous = openEditors.get(event.uri)
      const host = getRemoteLspTransport()
      if (event.kind === "close") {
        if (previous?.editorId !== event.editorId) return
        openEditors.delete(event.uri)
        if (previous.host !== host) return
      } else {
        if (
          event.kind !== "open" &&
          previous?.editorId === event.editorId &&
          previous.host !== host
        )
          return
        openEditors.set(event.uri, { editorId: event.editorId, host })
      }
      void enqueueEditorChange(input, event)
    }) ?? null
  unsubscribeServerState =
    input.client.onStateChange?.((event) => {
      const record = records.get(key(event.ownerId, event.serverId))
      if (!record || !onActiveHost(record)) return
      record.state = event.state === "broken" ? "crashed" : event.state
      record.lastError = event.lastError
      reconcileProviderRegistrations(input.client)
    }) ?? null
  let previousFolders = input.resolveWorkspaceFolders()
  let folderUpdates = Promise.resolve()
  unsubscribeWorkspaceFolders = onWorkspaceFoldersChanged(() => {
    const nextFolders = input.resolveWorkspaceFolders()
    const before = new Map(previousFolders.map((folder) => [folder.uri, folder]))
    const after = new Map(nextFolders.map((folder) => [folder.uri, folder]))
    const added = nextFolders.filter((folder) => !before.has(folder.uri))
    const removed = previousFolders.filter((folder) => !after.has(folder.uri))
    previousFolders = nextFolders
    if (added.length === 0 && removed.length === 0) return
    folderUpdates = folderUpdates
      .then(() => updateRunningServerWorkspaces(input, added, removed))
      .catch((error: unknown) => {
        lspRegistryLogger.warn("lsp-registry workspace update failed", { error: String(error) })
      })
  })
  return async () => {
    unsubscribeEditorChanges?.()
    unsubscribeEditorChanges = null
    unsubscribeServerState?.()
    unsubscribeServerState = null
    unsubscribeWorkspaceFolders?.()
    unsubscribeWorkspaceFolders = null
    unsubscribeHost?.()
    unsubscribeHost = null
    disposeAllProviders()
    const keys = [...records.keys()]
    for (const k of keys) {
      const rec = records.get(k)
      if (!rec) continue
      try {
        if (onActiveHost(rec)) await input.client.stop(rec.ownerId, rec.serverId)
      } catch {
        /* swallow */
      }
      clearServerDiagnostics(input, k)
      records.delete(k)
      recordHosts.delete(k)
    }
    deps = null
    documentServers.clear()
    openEditors.clear()
    documentQueues.clear()
  }
}

/** Test-only: clear every record and unset the adapter. */
export function __resetLspRegistryForTesting(): void {
  unsubscribeEditorChanges?.()
  unsubscribeEditorChanges = null
  diagnosticUris.clear()
  unsubscribeServerState?.()
  unsubscribeServerState = null
  unsubscribeWorkspaceFolders?.()
  unsubscribeWorkspaceFolders = null
  unsubscribeHost?.()
  unsubscribeHost = null
  disposeAllProviders()
  records.clear()
  recordHosts.clear()
  documentServers.clear()
  openEditors.clear()
  documentQueues.clear()
  nextRegistrationOrder = 0
  deps = null
}

const key = lspServerKey

function assertConfigured(): RegistryDeps {
  if (!deps) {
    throw new Error("lsp-registry: configureLspRegistry must be called before any operation")
  }
  return deps
}

/**
 * Register one LSP server. Runs the binary policy gate; if the policy
 * denies the spawn (no trusted publisher + no dev-mode override), the
 * record is stored with `state: "stopped"` and `consentReason` set —
 * the UI can surface this and offer a one-click consent flow that
 * re-calls `register` with `confirmedConsent: true`.
 */
export async function registerLspServer(input: {
  ownerId: LspServerOwner
  config: PluginLspServerDef
  pluginPath: string
  /** When true, skip the binary policy gate (called from the consent UI). */
  confirmedConsent?: boolean
}): Promise<LspServerRecord> {
  const d = assertConfigured()
  const k = key(input.ownerId, input.config.id)
  if (records.has(k)) {
    throw new Error(`lsp-registry: server ${k} is already registered`)
  }
  const record: LspServerRecord = {
    ownerId: input.ownerId,
    serverId: input.config.id,
    key: k,
    config:
      input.ownerId === "user"
        ? input.config
        : { ...input.config, command: resolveBinaryPath(input.config.command, input.pluginPath) },
    pluginPath: input.pluginPath,
    state: "stopped",
    registrationOrder: nextRegistrationOrder++,
  }
  records.set(k, record)
  recordHosts.set(k, getRemoteLspTransport())

  // Policy gate — skipped only when the consent UI explicitly confirms.
  if (!input.confirmedConsent) {
    let policy: LspBinaryEvaluation
    try {
      policy = await evaluateLspBinary({
        pluginId: input.ownerId,
        binaryPath: record.config.command,
        pluginPath: input.pluginPath,
      })
    } catch (err) {
      record.lastError = err instanceof Error ? err.message : String(err)
      record.state = "crashed"
      lspRegistryLogger.warn("lsp-registry policy evaluation threw", {
        key: k,
        error: record.lastError,
      })
      return record
    }
    if (!policy.allowed) {
      record.consentReason = policy.reason
      lspRegistryLogger.info("lsp-registry server requires consent", {
        key: k,
        reason: policy.reason,
      })
      return record
    }
    if (policy.requiresPrompt) {
      // Allowed but needs prompt (dev-mode override path) — caller can
      // either skip prompting (treats as confirmed already) or surface
      // the reason. We treat allowed+prompt as "spawn now" and surface
      // the reason in the audit.
      record.consentReason = policy.reason
    }
  }

  // Spawn.
  const workspaceFolders = d.resolveWorkspaceFolders()
  if (
    !onActiveHost(record) ||
    (record.config.workspaceFolderRequired && workspaceFolders.length === 0)
  ) {
    return record
  }
  record.state = "starting"
  try {
    const initialized = await d.client.start({
      ownerId: input.ownerId,
      serverId: input.config.id,
      config: record.config,
      workspaceFolders,
      onDiagnostics: diagnosticsFor(d, record),
    })
    if (records.get(k) !== record || !onActiveHost(record)) return record
    record.capabilities =
      initialized && "capabilities" in initialized && initialized.capabilities
        ? (initialized.capabilities as Record<string, unknown>)
        : {}
    record.state = "running"
    record.startedAt = d.now()
    await replayOpenEditors(d)
    reconcileProviderRegistrations(d.client)
  } catch (err) {
    record.state = "crashed"
    record.lastError = err instanceof Error ? err.message : String(err)
    lspRegistryLogger.warn("lsp-registry server start failed", {
      key: k,
      error: record.lastError,
    })
    reconcileProviderRegistrations(d.client)
  }
  return record
}

/**
 * Unregister a single server. Idempotent.
 */
export async function unregisterLspServer(
  ownerId: LspServerOwner,
  serverId: string
): Promise<void> {
  const d = assertConfigured()
  const k = key(ownerId, serverId)
  const record = records.get(k)
  if (!record) return
  try {
    if (onActiveHost(record)) await d.client.stop(ownerId, serverId)
  } catch (err) {
    lspRegistryLogger.warn("lsp-registry stop failed", {
      key: k,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  providerDisposables.get(k)?.dispose()
  providerDisposables.delete(k)
  clearServerDiagnostics(d, k)
  records.delete(k)
  recordHosts.delete(k)
  for (const [uri, route] of documentServers) if (route.recordKey === k) documentServers.delete(uri)
  await replayOpenEditors(d)
  reconcileProviderRegistrations(d.client)
}

/**
 * Unregister every server owned by an id — the plugin-manager calls
 * this on disable.
 */
export async function unregisterByOwner(ownerId: LspServerOwner): Promise<number> {
  const keys = [...records.keys()].filter((k) => k.startsWith(`${ownerId}:`))
  for (const k of keys) {
    const r = records.get(k)
    if (!r) continue
    await unregisterLspServer(r.ownerId, r.serverId)
  }
  return keys.length
}

/** Snapshot of every record. Useful for the Settings → Language Servers UI. */
export function listLspServers(): LspServerRecord[] {
  return [...records.values()]
}

/** Lookup the first record whose `languages` array includes `languageId`. */
export function getLspServerForLanguage(languageId: string): LspServerRecord | undefined {
  return [...records.values()]
    .filter(
      (record) =>
        onActiveHost(record) &&
        record.state === "running" &&
        record.config.languages.includes(languageId)
    )
    .sort(compareServerPriority)[0]
}

/**
 * Convenience for plugin enable: register every entry under
 * `manifest.lspServers[]`. Aggregates errors so a single bad entry
 * doesn't abort the rest.
 */
export async function registerPluginLspServers(input: {
  pluginId: string
  pluginPath: string
  servers: PluginLspServerDef[]
}): Promise<LspServerRecord[]> {
  const out: LspServerRecord[] = []
  for (const cfg of input.servers) {
    try {
      const rec = await registerLspServer({
        ownerId: input.pluginId,
        config: cfg,
        pluginPath: input.pluginPath,
      })
      out.push(rec)
    } catch (err) {
      lspRegistryLogger.warn("registerPluginLspServers: entry failed", {
        pluginId: input.pluginId,
        serverId: cfg.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return out
}

function compareServerPriority(a: LspServerRecord, b: LspServerRecord): number {
  const ownerRank = (record: LspServerRecord) => (record.ownerId === "user" ? 0 : 1)
  return (
    ownerRank(a) - ownerRank(b) ||
    a.registrationOrder - b.registrationOrder ||
    a.serverId.localeCompare(b.serverId)
  )
}

function disposeAllProviders(): void {
  for (const disposable of providerDisposables.values()) disposable.dispose()
  providerDisposables.clear()
}

function reconcileProviderRegistrations(client: LspClientAdapter): void {
  disposeAllProviders()
  const activeLanguages = new Map<string, string[]>()
  const allLanguages = new Set([...records.values()].flatMap((record) => record.config.languages))
  for (const language of allLanguages) {
    const record = getLspServerForLanguage(language)
    if (!record) continue
    const selected = activeLanguages.get(record.key) ?? []
    selected.push(language)
    activeLanguages.set(record.key, selected)
  }
  for (const [recordKey, languages] of activeLanguages) {
    const record = records.get(recordKey)
    if (!record) continue
    try {
      providerDisposables.set(recordKey, registerLspMonacoProviders({ record, client, languages }))
    } catch (error) {
      lspRegistryLogger.warn("lsp-registry provider registration failed", {
        key: recordKey,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

function supportsDynamicWorkspaceFolders(record: LspServerRecord): boolean {
  const workspace = record.capabilities?.workspace
  if (!workspace || typeof workspace !== "object") return false
  const folders = (workspace as Record<string, unknown>).workspaceFolders
  if (!folders || typeof folders !== "object") return false
  return Boolean((folders as Record<string, unknown>).changeNotifications)
}

async function updateRunningServerWorkspaces(
  input: RegistryDeps,
  added: Array<{ uri: string; name: string }>,
  removed: Array<{ uri: string; name: string }>
): Promise<void> {
  for (const record of records.values()) {
    if (!onActiveHost(record)) continue
    if (
      record.state === "stopped" &&
      !record.consentReason &&
      record.config.workspaceFolderRequired &&
      added.length > 0
    ) {
      await restartServerForWorkspaceChange(input, record)
      continue
    }
    if (record.state !== "running") continue
    if (supportsDynamicWorkspaceFolders(record) && input.client.clientNotification) {
      const updated = await input.client.clientNotification({
        ownerId: record.ownerId,
        serverId: record.serverId,
        method: "workspace/didChangeWorkspaceFolders",
        payload: { event: { added, removed } },
      })
      if (updated) continue
    }
    await restartServerForWorkspaceChange(input, record)
  }
}

async function restartServerForWorkspaceChange(
  input: RegistryDeps,
  record: LspServerRecord
): Promise<void> {
  providerDisposables.get(record.key)?.dispose()
  providerDisposables.delete(record.key)
  clearServerDiagnostics(input, record.key)
  record.state = "starting"
  for (const [uri, route] of documentServers) {
    if (route.recordKey === record.key) documentServers.delete(uri)
  }
  try {
    await input.client.stop(record.ownerId, record.serverId)
    const workspaceFolders = input.resolveWorkspaceFolders()
    if (
      !onActiveHost(record) ||
      (record.config.workspaceFolderRequired && workspaceFolders.length === 0)
    ) {
      record.state = "stopped"
      return
    }
    if (record.ownerId !== "user") {
      const policy = await evaluateLspBinary({
        pluginId: record.ownerId,
        pluginPath: record.pluginPath,
        binaryPath: record.config.command,
      })
      if (!policy.allowed) {
        record.state = "stopped"
        record.consentReason = policy.reason
        return
      }
    }
    if (records.get(record.key) !== record || !onActiveHost(record)) return
    const initialized = await input.client.start({
      ownerId: record.ownerId,
      serverId: record.serverId,
      config: record.config,
      workspaceFolders,
      onDiagnostics: diagnosticsFor(input, record),
    })
    if (records.get(record.key) !== record || !onActiveHost(record)) return
    record.capabilities =
      initialized && typeof initialized === "object" && initialized.capabilities
        ? (initialized.capabilities as Record<string, unknown>)
        : {}
    record.state = "running"
    record.startedAt = input.now()
    record.lastError = undefined
    await replayOpenEditors(input)
  } catch (error) {
    record.state = "crashed"
    record.lastError = error instanceof Error ? error.message : String(error)
  }
  reconcileProviderRegistrations(input.client)
}

async function handleEditorChange(
  input: RegistryDeps,
  event: EditorEvent,
  host: ReturnType<typeof getRemoteLspTransport>
): Promise<void> {
  if (getRemoteLspTransport() !== host) return
  if (event.kind === "change-language") {
    // The document may belong to another server now: close it where it was
    // and open it with the server for its new language.
    await handleEditorChange(input, { ...event, kind: "close" }, host)
    await handleEditorChange(input, { ...event, kind: "open" }, host)
    return
  }
  const model = input.bridge.getEditorById?.(event.editorId)?.getModel()
  if (event.kind === "close") {
    const route = documentServers.get(event.uri)
    const record = route ? records.get(route.recordKey) : undefined
    const uri = route?.fileUri ?? resolveMaterializedDocumentUri(event.uri)
    documentServers.delete(event.uri)
    if (record?.state === "running" && onActiveHost(record) && uri && input.client.didClose) {
      await input.client.didClose({
        ownerId: record.ownerId,
        serverId: record.serverId,
        uri,
      })
    }
    return
  }
  if (!model) return
  const record = getLspServerForLanguage(model.language)
  const uri = resolveMaterializedDocumentUri(event.uri)
  if (!record || !uri) return

  const route = documentServers.get(event.uri)
  const routed = route ? records.get(route.recordKey) : undefined
  const sameRoute = route?.recordKey === record.key && route.fileUri === uri
  if (event.kind === "open" && sameRoute) return
  if (event.kind !== "open" && event.kind !== "change-content") return
  const text = model.getValue()
  if (event.uri !== uri && (event.kind === "change-content" || event.replay)) {
    await flushMaterializedDocument(event.uri, text)
  }
  if (getRemoteLspTransport() !== host || records.get(record.key) !== record) return
  if (!sameRoute) {
    if (routed?.state === "running" && onActiveHost(routed) && route && input.client.didClose) {
      await input.client.didClose({
        ownerId: routed.ownerId,
        serverId: routed.serverId,
        uri: route.fileUri,
      })
    }
    if (getRemoteLspTransport() !== host || records.get(record.key) !== record) return
    await input.client.didOpen?.({
      ownerId: record.ownerId,
      serverId: record.serverId,
      uri,
      languageId: model.language,
      text,
    })
    if (getRemoteLspTransport() === host && records.get(record.key) === record) {
      documentServers.set(event.uri, { recordKey: record.key, fileUri: uri })
    }
    return
  }
  await input.client.didChange?.({ ownerId: record.ownerId, serverId: record.serverId, uri, text })
}

/**
 * Resolve the binary path — relative paths anchor against the plugin
 * install directory; absolute paths flow through untouched.
 */
function resolveBinaryPath(command: string, pluginPath: string): string {
  // Strict absolute detection: covers POSIX `/x` and Windows `C:\x`.
  if (/^([a-zA-Z]:[\\/]|[/\\])/.test(command)) return command
  // Defensive normalisation so the inside-dir check stays consistent.
  const joined = `${pluginPath.replace(/[\\/]+$/g, "")}/${command.replace(/^[\\/]+/g, "")}`
  return joined
}

/**
 * Public export of the path resolver for tests that want to assert the
 * exact path the policy sees. Re-exporting keeps `resolveBinaryPath`
 * pure (no test-only flag needed).
 */
export const __testing = { resolveBinaryPath }
