/**
 * `/plugin` controller — discover, inspect, toggle, reload, install, uninstall
 * plugins, and browse a Claude-Code-style GitHub marketplace.
 *
 * Source of truth is the live `PluginManager` store (the SAME one the desktop
 * uses), which the CLI bootstraps with both builtins and disk plugins
 * (`cli/src/plugin/host.ts`). enable/disable/reload/install/uninstall all go
 * through the manager so a plugin's tools actually reach the model; the file
 * overlay (`plugin-state.json`) persists the disabled set across launches. The
 * App fires `agent.invalidate()` after every `plugin` runtime request, so a
 * change reaches the next turn's tool manifest.
 */
import type { PluginInfo, PluginToolInfo } from "../../plugin/discover-plugins"
import { readDisabledPlugins, setPluginDisabled } from "../../plugin/plugin-state"
import {
  readSources,
  addSource as addSourceToStore,
  removeSource as removeSourceFromStore,
} from "../../plugin/marketplace-sources"
import {
  readOrigins,
  getOrigin as getOriginFromStore,
  recordOrigin as recordOriginToStore,
  removeOrigin as removeOriginFromStore,
  type PluginOrigin,
} from "../../plugin/plugin-origins"
import {
  readTrustedOwners,
  isOwnerTrusted,
  addTrustedOwner,
  removeTrustedOwner,
} from "../../plugin/plugin-trust"
import { openDocument } from "./shared"
import { buildToolsDocument } from "./tool-doc"
import { annotateInstallState, type MarketplaceBrowseEntry } from "./marketplace-filter"
import {
  DANGEROUS_PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
} from "@/lib/plugin/security/permission-guard"
import { compareVersions } from "@/lib/plugin/package/dependency-resolver"
import { formatGithubPluginRef, parseGithubPluginRef } from "@/lib/plugin/package/github-source"
import type { TuiAction } from "../state/types"
import type { PluginManifest, PluginPermission } from "@/types/plugin"

export interface PluginDeps {
  /** Suppress late results and new work after the runtime request is cancelled. */
  signal?: AbortSignal
  dispatch: (action: TuiAction) => void
  roots: string[]
  home: string
  /** Unified plugin list (manager store). Default reads `usePluginStore`. */
  list?: () => Promise<PluginInfo[]>
  getDisabled?: () => Set<string>
  /** Persist the disabled-set overlay. Default writes `plugin-state.json`. */
  setEnabled?: (id: string, disabled: boolean) => void
  /** Flip the LIVE manager so the change reaches the next turn. */
  setLive?: (id: string, enabled: boolean) => Promise<void>
  /** Hot-reload a plugin via the manager. */
  reload?: (id: string) => Promise<void>
  /** Uninstall a plugin (unload + remove dir). */
  uninstall?: (id: string) => Promise<void>
  /**
   * Fetch a GitHub install preview (manifest + README) for consent / preview.
   * `pinnedRef` is the reviewed commit (`owner/repo@<sha>[/subdir]`); consent
   * installs exactly it, never the mutable ref the user typed.
   */
  preview?: (ref: string) => Promise<PluginPreview>
  /** Whether a plugin id is already installed (for the conflict note). */
  isInstalled?: (id: string) => boolean
  /** Perform the real install (download + register + enable) of a pinned ref. */
  install?: (
    pinnedRef: string,
    opts: { signal?: AbortSignal }
  ) => Promise<{ id: string; version?: string; fingerprint?: string }>
  /**
   * Update an installed plugin from its recorded ref: download it staged,
   * refuse another plugin id, then swap it in under a stopped runtime and
   * return the runtime to its previous state. Honours `signal` until the swap.
   */
  applyUpdate?: (
    ref: string,
    opts: { expectedId: string; signal?: AbortSignal }
  ) => Promise<{ id: string; version: string; fingerprint: string }>
  /** Provenance store — where each plugin was installed from. */
  getOrigin?: (id: string) => PluginOrigin | undefined
  getOrigins?: () => Record<string, PluginOrigin>
  recordOrigin?: (
    id: string,
    entry: { repoRef: string; version: string; fingerprint: string }
  ) => void
  removeOrigin?: (id: string) => void
  /** Trusted-publisher store (GitHub owners). */
  isTrusted?: (owner: string) => boolean
  getTrusted?: () => string[]
  addTrusted?: (owner: string) => void
  removeTrusted?: (owner: string) => void
  /** Marketplace source list. */
  getSources?: () => string[]
  addSource?: (ref: string) => void
  removeSource?: (ref: string) => void
  /** The live manager the default seams drive. Default wraps `getPluginManager()`. */
  host?: () => Promise<CliHost>
  /** Fetch merged catalog entries from the configured sources. */
  browse?: (sources: string[]) => Promise<{
    entries: MarketplaceBrowseEntry[]
    errors: Array<{ repoRef: string; message: string }>
  }>
}

export interface PluginPreview {
  manifest: PluginManifest
  readme?: string
  pinnedRef?: string
}

/**
 * The new tree is installed, but returning the plugin to its previous runtime
 * state failed. Provenance still has to describe what is on disk.
 */
export class PluginUpdateActivationError extends Error {
  constructor(
    readonly installed: { id: string; version: string; fingerprint: string },
    readonly activationError: unknown
  ) {
    super(activationError instanceof Error ? activationError.message : String(activationError))
    this.name = "PluginUpdateActivationError"
  }
}

async function defaultPreview(ref: string): Promise<PluginPreview> {
  const { fetchGithubPluginPreview } = await import("@/lib/plugin/package/github-source")
  const preview = await fetchGithubPluginPreview(parseGithubPluginRef(ref))
  return {
    manifest: preview.manifest,
    readme: preview.readme ?? undefined,
    pinnedRef: formatGithubPluginRef(preview.ref),
  }
}

/** Whether `ref` names an exact commit, which is what a consent may install. */
function isPinnedCommitRef(ref: string): boolean {
  try {
    return /^[0-9a-f]{40}$/i.test(parseGithubPluginRef(ref).ref ?? "")
  } catch {
    return false
  }
}

/** The command a consent overlay runs: install the reviewed commit, track `ref`. */
function confirmedInstallCommand(ref: string, pinnedRef: string | undefined): string {
  if (!pinnedRef || !isPinnedCommitRef(pinnedRef)) {
    throw new Error("the preview did not resolve the source to a commit")
  }
  return `plugin install ${ref} --confirmed --pinned ${pinnedRef}`
}

// ── unified list (manager store) ──────────────────────────────────────────────

/** Map a store plugin row to the `PluginInfo` the list/show/tools render. */
export function toPluginInfo(p: { manifest: PluginManifest; path: string }): PluginInfo {
  const m = p.manifest
  const rawTools = (m as { tools?: unknown }).tools
  const tools: PluginToolInfo[] = Array.isArray(rawTools)
    ? rawTools
        .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
        .filter((t) => typeof t.name === "string")
        .map((t) => ({
          name: t.name as string,
          description: typeof t.description === "string" ? t.description : "",
          ...(typeof t.category === "string" ? { category: t.category } : {}),
          ...(t.parametersSchema && typeof t.parametersSchema === "object"
            ? { parametersSchema: t.parametersSchema as Record<string, unknown> }
            : {}),
        }))
    : []
  return {
    id: m.id,
    name: m.name ?? m.id,
    version: m.version ?? "0.0.0",
    description: typeof m.description === "string" ? m.description : "",
    type: m.type,
    dir: p.path,
    supported: m.type === "frontend",
    tools,
    mcpServerPresets: [],
  }
}

async function defaultListPlugins(): Promise<PluginInfo[]> {
  const { usePluginStore } = await import("@/stores/plugin-runtime")
  const plugins = usePluginStore.getState().plugins as unknown as Record<
    string,
    { manifest: PluginManifest; path: string }
  >
  return Object.values(plugins).map(toPluginInfo)
}

const loadPlugins = (deps: PluginDeps) => (deps.list ?? defaultListPlugins)()
const disabledOf = (deps: PluginDeps) =>
  (deps.getDisabled ?? (() => readDisabledPlugins(deps.home)))()

const getOriginOf = (deps: PluginDeps, id: string) =>
  (deps.getOrigin ?? ((i: string) => getOriginFromStore(deps.home, i)))(id)
const getOriginsOf = (deps: PluginDeps) => (deps.getOrigins ?? (() => readOrigins(deps.home)))()
const recordOriginOf = (deps: PluginDeps) =>
  deps.recordOrigin ?? ((id, e) => recordOriginToStore(deps.home, id, e))
const removeOriginOf = (deps: PluginDeps) =>
  deps.removeOrigin ?? ((id: string) => removeOriginFromStore(deps.home, id))
const isTrustedOf = (deps: PluginDeps, owner: string) =>
  (deps.isTrusted ?? ((o: string) => isOwnerTrusted(deps.home, o)))(owner)

/** Owner segment of a GitHub ref (`owner/repo[@ref][/subdir]`), best-effort. */
function ownerOfRef(ref: string): string {
  return ref.split("/")[0]?.split("@")[0]?.trim() ?? ""
}

// ── default live-manager wiring (lazy; injected in tests) ───────────────────────

type CliHost = import("../../plugin/host").HostManager & {
  pluginDir: (id: string) => string | undefined
}

const hostOf = (deps: PluginDeps): Promise<CliHost> => (deps.host ?? realHost)()

async function realHost(): Promise<CliHost> {
  const { getPluginManager } = await import("@/lib/plugin/core/manager")
  const { usePluginStore } = await import("@/stores/plugin-runtime")
  const { makeHostManager } = await import("../../plugin/host-manager")
  const getPlugins = () =>
    usePluginStore.getState().plugins as unknown as Record<
      string,
      { manifest: PluginManifest; path: string; status: string }
    >
  const hm = makeHostManager({ manager: getPluginManager() as never, getPlugins })
  return { ...hm, pluginDir: (id) => getPlugins()[id]?.path }
}

// ── list / show / tools ─────────────────────────────────────────────────────────

export async function pluginList(deps: PluginDeps): Promise<void> {
  if (deps.signal?.aborted) return
  const plugins = await loadPlugins(deps)
  if (deps.signal?.aborted) return
  if (plugins.length === 0) {
    deps.dispatch({
      type: "NOTICE",
      message:
        "No plugins installed. Try /plugin marketplace or drop a folder under .cognia/plugins/.",
    })
    return
  }
  const disabled = disabledOf(deps)
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: {
      kind: "select",
      title: "Plugins (Enter inspects)",
      items: plugins.map((p) => ({
        id: p.id,
        label: p.name,
        hint: `${p.type}${p.supported ? "" : " · unsupported"} · ${
          disabled.has(p.id) ? "off" : "on"
        }`,
      })),
      index: 0,
      onSelectCommand: "plugin show",
    },
  })
}

/** Render a plugin's detail as a markdown document. Pure (unit-tested raw). */
export function buildPluginDocument(plugin: PluginInfo, enabled: boolean): string {
  const support = plugin.supported
    ? "runnable in CLI"
    : `not runnable in CLI (${plugin.type} needs the desktop host)`
  const lines: string[] = [
    `# ${plugin.name}`,
    "",
    `\`${plugin.id}\` · v${plugin.version} · ${plugin.type} · ${enabled ? "enabled" : "disabled"}`,
    "",
    `_${support}_`,
    "",
  ]
  if (plugin.description) lines.push(`> ${plugin.description}`, "")
  if (plugin.tools.length > 0) {
    lines.push(
      `**Tools (${plugin.tools.length}):** ${plugin.tools.map((t) => t.name).join(", ")}`,
      "",
      `_Run \`/plugin tools ${plugin.id}\` to see each tool's schema._`
    )
  } else {
    lines.push("_This plugin declares no agent tools._")
  }
  return lines.join("\n")
}

export async function pluginShow(id: string, deps: PluginDeps): Promise<void> {
  if (deps.signal?.aborted) return
  const plugins = await loadPlugins(deps)
  if (deps.signal?.aborted) return
  const plugin = plugins.find((p) => p.id === id)
  if (!plugin) {
    deps.dispatch({ type: "NOTICE", message: `Plugin ${id} not found.` })
    return
  }
  const enabled = !disabledOf(deps).has(plugin.id)
  openDocument(deps.dispatch, {
    title: `Plugin · ${plugin.name}`,
    body: buildPluginDocument(plugin, enabled),
    format: "markdown",
  })
}

/** `/plugin tools <id>` — show each declared tool's description + schema. */
export async function pluginTools(id: string, deps: PluginDeps): Promise<void> {
  if (deps.signal?.aborted) return
  const plugins = await loadPlugins(deps)
  if (deps.signal?.aborted) return
  const plugin = plugins.find((p) => p.id === id)
  if (!plugin) {
    deps.dispatch({ type: "NOTICE", message: `Plugin ${id} not found.` })
    return
  }
  if (plugin.tools.length === 0) {
    deps.dispatch({
      type: "NOTICE",
      message: `Plugin "${plugin.name}" declares no agent tools.`,
    })
    return
  }
  openDocument(deps.dispatch, {
    title: `Tools · ${plugin.name} (${plugin.tools.length})`,
    body: buildToolsDocument(
      plugin.tools.map((t) => ({
        name: t.name,
        description: t.description,
        category: t.category,
        schema: t.parametersSchema,
      })),
      `${plugin.tools.length} tool${plugin.tools.length === 1 ? "" : "s"} declared by \`${plugin.id}\`.`
    ),
    format: "markdown",
  })
}

// ── enable / disable (persist overlay + flip live manager) ──────────────────────

export async function pluginSetEnabled(
  id: string,
  enabled: boolean,
  deps: PluginDeps
): Promise<void> {
  if (deps.signal?.aborted) return
  id = id.trim()
  if (!id) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /plugin enable|disable <id>" })
    return
  }
  try {
    const setLive =
      deps.setLive ??
      (async (pid: string, on: boolean) => {
        const host = await hostOf(deps)
        await host.setPluginIntent(pid, on ? "enabled" : "disabled")
      })
    await setLive(id, enabled)
  } catch (err) {
    deps.dispatch({
      type: "NOTICE",
      message: `Plugin "${id}" ${enabled ? "enable" : "disable"} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    })
    return
  }
  try {
    ;(deps.setEnabled ?? ((i, d) => setPluginDisabled(deps.home, i, d)))(id, !enabled)
  } catch (err) {
    deps.dispatch({
      type: "NOTICE",
      message: `Plugin "${id}" is ${enabled ? "enabled" : "disabled"} now, but saving that setting failed: ${err instanceof Error ? err.message : String(err)}`,
    })
    return
  }
  deps.dispatch({
    type: "NOTICE",
    message: `Plugin "${id}" ${enabled ? "enabled" : "disabled"}.`,
  })
}

// ── reload ──────────────────────────────────────────────────────────────────────

export async function pluginReload(id: string, deps: PluginDeps): Promise<void> {
  if (deps.signal?.aborted) return
  if (!id) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /plugin reload <id>" })
    return
  }
  try {
    const reload =
      deps.reload ??
      (async (pid: string) => {
        const { reloadPlugin } = await import("../../plugin/host")
        await reloadPlugin(pid, { manager: await hostOf(deps) })
      })
    await reload(id)
    deps.dispatch({ type: "NOTICE", message: `Plugin "${id}" reloaded.` })
  } catch (err) {
    deps.dispatch({
      type: "NOTICE",
      message: `Reload failed: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
}

// ── install (consent summary → confirmed install) ───────────────────────────────

/** Markdown lines for a manifest's permission / network grants. Reused by the
 *  install consent summary and the marketplace preview. */
function isDangerous(p: PluginPermission): boolean {
  return DANGEROUS_PERMISSIONS.includes(p)
}

/** One permission bullet — dangerous perms get a ⚠️ marker + description. */
function permLine(p: PluginPermission): string {
  const desc = PERMISSION_DESCRIPTIONS[p]
  const suffix = desc ? ` — ${desc}` : ""
  return isDangerous(p) ? `- ⚠️ \`${p}\`${suffix}` : `- \`${p}\`${suffix}`
}

export function buildPermissionsBlock(manifest: PluginManifest): string[] {
  const declared = (manifest.permissions ?? []) as PluginPermission[]
  const optional = (manifest.optionalPermissions ?? []) as PluginPermission[]
  const net = manifest.networkAccess
  const dangerous = declared.filter(isDangerous)
  const lines: string[] = []
  if (dangerous.length) {
    lines.push(
      `⚠️ **This plugin requests ${dangerous.length} dangerous permission${dangerous.length === 1 ? "" : "s"}** (${dangerous.map((p) => `\`${p}\``).join(", ")}).`,
      ""
    )
  }
  lines.push(
    "**Permissions requested:**",
    declared.length ? declared.map(permLine).join("\n") : "- _none_",
    ""
  )
  if (optional.length) {
    lines.push("**Optional permissions:**", optional.map(permLine).join("\n"), "")
  }
  if (net?.allowedDomains?.length) {
    lines.push(
      "**Network egress allowlist:**",
      net.allowedDomains.map((d) => `- \`${d}\``).join("\n"),
      ...(net.reasoning ? ["", `_${net.reasoning}_`] : []),
      ""
    )
  }
  return lines
}

/** Publisher trust line for the consent / preview. Empty when owner unknown. */
export function buildPublisherLines(owner?: string, trusted?: boolean): string[] {
  if (!owner) return []
  if (trusted) return [`**Publisher:** \`${owner}\` · trusted ✓`, ""]
  return [
    `**Publisher:** \`${owner}\` · ⚠️ **untrusted**`,
    `_Run \`/plugin trust add ${owner}\` to trust this publisher's plugins._`,
    "",
  ]
}

/** Build a markdown consent summary surfacing every grant before install. */
export function buildConsentSummary(
  manifest: PluginManifest,
  opts: { ref: string; alreadyInstalled: boolean; owner?: string; trusted?: boolean }
): string {
  const lines: string[] = [
    `# Install ${manifest.name ?? manifest.id}?`,
    "",
    `\`${manifest.id}\` · v${manifest.version ?? "?"} · from \`${opts.ref}\``,
    "",
  ]
  if (manifest.type !== "frontend") {
    lines.push(
      `⚠️ Type \`${manifest.type}\` is **unsupported in CLI** (needs the desktop host).`,
      ""
    )
  }
  if (opts.alreadyInstalled) {
    lines.push(`⚠️ \`${manifest.id}\` is already installed — installing will overwrite it.`, "")
  }
  lines.push(...buildPublisherLines(opts.owner, opts.trusted))
  lines.push(...buildPermissionsBlock(manifest))
  lines.push("Press **Enter** to install, **Esc** to cancel.")
  return lines.join("\n")
}

/**
 * Strip the internal `--confirmed` / `--pinned <ref>` flags a consent overlay
 * adds and return `{ ref, confirmed, pinned }`.
 */
export function parseInstallArg(arg: string): {
  ref: string
  confirmed: boolean
  pinned?: string
} {
  const tokens = arg.trim().split(/\s+/).filter(Boolean)
  const rest: string[] = []
  let confirmed = false
  let pinned: string | undefined
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index] === "--confirmed") confirmed = true
    else if (tokens[index] === "--pinned") pinned = tokens[++index]
    else rest.push(tokens[index])
  }
  return { ref: rest.join(" "), confirmed, ...(pinned ? { pinned } : {}) }
}

export async function pluginInstall(arg: string, deps: PluginDeps): Promise<void> {
  if (deps.signal?.aborted) return
  const { ref, confirmed, pinned } = parseInstallArg(arg)
  if (!ref) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /plugin install <owner/repo[@ref][/subdir]>" })
    return
  }

  if (!confirmed) {
    // Phase 1 — fetch the manifest and show a single consent summary. Enter
    // re-runs this command with the internal --confirmed flag and the commit
    // the summary was built from, so phase 2 installs what was reviewed.
    try {
      const preview = deps.preview ?? defaultPreview
      const isInstalled = deps.isInstalled ?? (() => false)
      const { manifest, pinnedRef } = await preview(ref)
      if (deps.signal?.aborted) return
      const onConfirmCommand = confirmedInstallCommand(ref, pinnedRef)
      const owner = ownerOfRef(ref)
      deps.dispatch({
        type: "OVERLAY_OPEN",
        overlay: {
          kind: "confirm",
          title: `Install ${manifest.name ?? manifest.id}?`,
          body: buildConsentSummary(manifest, {
            ref,
            alreadyInstalled: isInstalled(manifest.id),
            owner,
            trusted: isTrustedOf(deps, owner),
          }),
          format: "markdown",
          onConfirmCommand,
        },
      })
    } catch (err) {
      deps.dispatch({
        type: "NOTICE",
        message: `Could not read plugin "${ref}": ${err instanceof Error ? err.message : String(err)}`,
      })
    }
    return
  }

  // Phase 2 — user confirmed: download + register + enable the reviewed
  // commit. A mutable ref here would resolve again and could install a
  // version nobody reviewed.
  if (!pinned || !isPinnedCommitRef(pinned)) {
    deps.dispatch({
      type: "NOTICE",
      message: `Install of "${ref}" was not confirmed against a reviewed commit. Run /plugin install ${ref} to review it first.`,
    })
    return
  }
  try {
    const install =
      deps.install ??
      (async (r: string, opts: { signal?: AbortSignal }) => {
        const { installFromGithubRef } = await import("../../plugin/install")
        const { registerDiskPlugins } = await import("../../plugin/host")
        const result = await installFromGithubRef(r, { home: deps.home, signal: opts.signal })
        const host = await hostOf(deps)
        await registerDiskPlugins({
          manager: host,
          discover: async () => [
            { id: result.id, dir: result.dir, manifest: result.manifest, supported: true },
          ],
          disabled: disabledOf(deps),
          notify: (m) => deps.dispatch({ type: "NOTICE", message: m }),
        })
        return {
          id: result.id,
          version: result.manifest.version ?? "0.0.0",
          fingerprint: result.fingerprint,
        }
      })
    const { id, version, fingerprint } = await install(pinned, { signal: deps.signal })
    // The ref the user typed is what `/plugin update` follows later.
    recordOriginOf(deps)(id, {
      repoRef: ref,
      version: version ?? "0.0.0",
      fingerprint: fingerprint ?? "",
    })
    if (deps.signal?.aborted) return
    deps.dispatch({ type: "NOTICE", message: `Installed "${id}".` })
  } catch (err) {
    if (deps.signal?.aborted) return
    deps.dispatch({
      type: "NOTICE",
      message: `Install failed: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
}

// ── marketplace preview (README + permissions → install) ────────────────────────

const README_PREVIEW_LINES = 40

/** Truncate a README to a small excerpt for the terminal preview overlay. */
export function readmeExcerpt(readme: string | undefined, max = README_PREVIEW_LINES): string {
  if (!readme) return ""
  const lines = readme.replace(/\r\n/g, "\n").split("\n")
  const slice = lines.slice(0, max).join("\n").trimEnd()
  return lines.length > max ? `${slice}\n\n_…README truncated._` : slice
}

/** Capabilities / tools / signature / dependency summary from the manifest. */
export function buildCapabilitiesBlock(manifest: PluginManifest): string[] {
  const lines: string[] = []
  const caps = (manifest.capabilities ?? []) as string[]
  const toolCount = Array.isArray(manifest.tools) ? manifest.tools.length : 0
  const summary: string[] = []
  if (caps.length) summary.push(`${caps.length} capabilit${caps.length === 1 ? "y" : "ies"}`)
  if (toolCount) summary.push(`${toolCount} tool${toolCount === 1 ? "" : "s"}`)
  if (summary.length) {
    lines.push(`**Capabilities:** ${summary.join(" · ")}`)
    if (caps.length) lines.push(caps.map((c) => `\`${c}\``).join(" "))
    lines.push("")
  }
  // Signature presence — the CLI can't verify Ed25519 (Tauri-only), so it only
  // reports that a publisher key is present, never claims a verified signature.
  if (manifest.author?.publicKey) {
    lines.push("**Signature:** 🔑 publisher key present _(verified on desktop only)_", "")
  }
  const deps = manifest.dependencies ? Object.keys(manifest.dependencies) : []
  if (deps.length) {
    lines.push(`**Dependencies:** ${deps.map((d) => `\`${d}\``).join(", ")}`, "")
  }
  return lines
}

/** Footer line of external metadata (homepage / repo / license / keywords). */
export function buildMetadataFooter(manifest: PluginManifest): string[] {
  const bits: string[] = []
  if (manifest.author?.name) bits.push(`by ${manifest.author.name}`)
  if (manifest.license) bits.push(manifest.license)
  if (manifest.homepage) bits.push(manifest.homepage)
  else if (manifest.repository) bits.push(manifest.repository)
  const lines: string[] = []
  if (bits.length) lines.push(`_${bits.join(" · ")}_`, "")
  if (manifest.keywords?.length) {
    lines.push(`**Keywords:** ${manifest.keywords.map((k) => `\`${k}\``).join(" ")}`, "")
  }
  return lines
}

/** Build the marketplace preview document (shown before the install consent). */
export function buildPreviewDocument(
  manifest: PluginManifest,
  opts: { ref: string; owner?: string; trusted?: boolean; readme?: string }
): string {
  const lines: string[] = [
    `# ${manifest.name ?? manifest.id}`,
    "",
    `\`${manifest.id}\` · v${manifest.version ?? "?"} · ${manifest.type} · from \`${opts.ref}\``,
    "",
  ]
  if (manifest.type !== "frontend") {
    lines.push(
      `⚠️ Type \`${manifest.type}\` is **unsupported in CLI** (needs the desktop host).`,
      ""
    )
  }
  if (typeof manifest.description === "string" && manifest.description) {
    lines.push(`> ${manifest.description}`, "")
  }
  lines.push(...buildPublisherLines(opts.owner, opts.trusted))
  lines.push(...buildCapabilitiesBlock(manifest))
  lines.push(...buildPermissionsBlock(manifest))
  // Full README — the confirm overlay scrolls, so no truncation is needed.
  const readme = opts.readme ? opts.readme.replace(/\r\n/g, "\n").trimEnd() : ""
  if (readme) lines.push("---", "", readme, "", "---", "")
  lines.push(...buildMetadataFooter(manifest))
  lines.push("Press **Enter** to install, **Esc** to cancel.")
  return lines.join("\n")
}

/**
 * `/plugin preview <ref>` — the marketplace's "see before you install" step.
 * Fetches the manifest + README, shows a rich confirm overlay, and on Enter
 * installs with `--confirmed` (perms were already surfaced here, so the install
 * path skips its own consent).
 */
export async function pluginPreview(ref: string, deps: PluginDeps): Promise<void> {
  if (deps.signal?.aborted) return
  const trimmed = ref.trim()
  if (!trimmed) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /plugin preview <owner/repo[@ref][/subdir]>" })
    return
  }
  try {
    const preview = deps.preview ?? defaultPreview
    const { manifest, readme, pinnedRef } = await preview(trimmed)
    if (deps.signal?.aborted) return
    const onConfirmCommand = confirmedInstallCommand(trimmed, pinnedRef)
    const owner = ownerOfRef(trimmed)
    deps.dispatch({
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "confirm",
        title: `${manifest.name ?? manifest.id}`,
        body: buildPreviewDocument(manifest, {
          ref: trimmed,
          owner,
          trusted: isTrustedOf(deps, owner),
          readme: readme ?? undefined,
        }),
        format: "markdown",
        onConfirmCommand,
      },
    })
  } catch (err) {
    deps.dispatch({
      type: "NOTICE",
      message: `Could not read plugin "${trimmed}": ${err instanceof Error ? err.message : String(err)}`,
    })
  }
}

// ── update (re-fetch + hot-reload, or check-all) ────────────────────────────────

export async function pluginUpdate(arg: string, deps: PluginDeps): Promise<void> {
  if (deps.signal?.aborted) return
  const id = arg.trim()
  if (!id) return pluginUpdateCheckAll(deps)

  const origin = getOriginOf(deps, id)
  if (!origin) {
    deps.dispatch({
      type: "NOTICE",
      message: `Plugin "${id}" was not installed from a marketplace/GitHub source — nothing to update.`,
    })
    return
  }
  try {
    const applyUpdate =
      deps.applyUpdate ??
      (async (r: string, opts: { expectedId: string; signal?: AbortSignal }) => {
        const { stageFromGithubRef } = await import("../../plugin/install")
        const { replaceDiskPlugin } = await import("../../plugin/host")
        const staged = await stageFromGithubRef(r, {
          home: deps.home,
          expectedId: opts.expectedId,
          signal: opts.signal,
        })
        const installed = {
          id: staged.id,
          version: staged.manifest.version ?? "0.0.0",
          fingerprint: staged.fingerprint,
        }
        let committed = false
        try {
          opts.signal?.throwIfAborted()
          await replaceDiskPlugin(
            {
              ...staged,
              commit: async () => {
                await staged.commit()
                committed = true
              },
            },
            { manager: await hostOf(deps) }
          )
        } catch (error) {
          if (committed) throw new PluginUpdateActivationError(installed, error)
          throw error
        } finally {
          await staged.discard()
        }
        return installed
      })
    let next: { id: string; version: string; fingerprint: string }
    let activationError: unknown
    try {
      next = await applyUpdate(origin.repoRef, { expectedId: id, signal: deps.signal })
    } catch (error) {
      if (!(error instanceof PluginUpdateActivationError)) throw error
      next = error.installed
      activationError = error.activationError
    }
    if (next.id !== id) {
      throw new Error(`${origin.repoRef} returned plugin "${next.id}", not "${id}"`)
    }
    // From here the new tree is on disk: provenance must describe it even if
    // the request was cancelled after the swap.
    recordOriginOf(deps)(id, {
      repoRef: origin.repoRef,
      version: next.version,
      fingerprint: next.fingerprint,
    })
    if (deps.signal?.aborted) return
    if (activationError !== undefined) {
      deps.dispatch({
        type: "NOTICE",
        message: `Updated "${id}" to v${next.version}, but restarting it failed: ${
          activationError instanceof Error ? activationError.message : String(activationError)
        }`,
      })
      return
    }
    const unchanged = next.fingerprint === origin.fingerprint
    deps.dispatch({
      type: "NOTICE",
      message: unchanged
        ? `Plugin "${id}" is already up to date (v${next.version}).`
        : `Updated "${id}": v${origin.version} → v${next.version}.`,
    })
  } catch (err) {
    if (deps.signal?.aborted) return
    deps.dispatch({
      type: "NOTICE",
      message: `Update failed: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
}

/** `/plugin update` (no id) — report which installed plugins have a newer version upstream. */
async function pluginUpdateCheckAll(deps: PluginDeps): Promise<void> {
  const origins = getOriginsOf(deps)
  const ids = Object.keys(origins)
  if (ids.length === 0) {
    deps.dispatch({
      type: "NOTICE",
      message: "No marketplace/GitHub-installed plugins to check.",
    })
    return
  }
  const preview = deps.preview ?? defaultPreview
  const available: string[] = []
  const failures: string[] = []
  for (const id of ids) {
    try {
      const { manifest } = await preview(origins[id].repoRef)
      if (deps.signal?.aborted) return
      const latest = manifest.version ?? "0.0.0"
      // Only a newer upstream is an update; an older one would be a downgrade.
      if (compareVersions(latest, origins[id].version) > 0)
        available.push(`${id} (v${origins[id].version} → v${latest})`)
    } catch (err) {
      if (deps.signal?.aborted) return
      failures.push(`${id} (${err instanceof Error ? err.message : String(err)})`)
    }
  }
  const result = available.length
    ? `Updates available: ${available.join(", ")}. Run /plugin update <id>.`
    : failures.length === ids.length
      ? "No plugins could be checked."
      : failures.length > 0
        ? "No updates found among successfully checked plugins."
        : "All installed plugins are up to date."
  deps.dispatch({
    type: "NOTICE",
    message:
      failures.length > 0
        ? `${result} Could not check: ${failures.join(", ")}. Update check is incomplete.`
        : result,
  })
}

// ── uninstall ─────────────────────────────────────────────────────────────────

export async function pluginUninstall(id: string, deps: PluginDeps): Promise<void> {
  if (deps.signal?.aborted) return
  if (!id) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /plugin uninstall <id>" })
    return
  }
  try {
    const uninstall =
      deps.uninstall ??
      (async (pid: string) => {
        const { uninstallHostPlugin } = await import("../../plugin/host")
        const host = await hostOf(deps)
        const dir = host.pluginDir(pid)
        if (!dir) throw new Error(`unknown plugin: ${pid}`)
        await uninstallHostPlugin(pid, dir, { manager: host })
      })
    await uninstall(id)
    setPluginDisabled(deps.home, id, false) // clear any stale disabled entry
    removeOriginOf(deps)(id) // drop provenance
    deps.dispatch({ type: "NOTICE", message: `Uninstalled "${id}".` })
  } catch (err) {
    deps.dispatch({
      type: "NOTICE",
      message: `Uninstall failed: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
}

// ── marketplace sources ─────────────────────────────────────────────────────────

export function pluginSourcesList(deps: PluginDeps): void {
  const sources = (deps.getSources ?? (() => readSources(deps.home)))()
  deps.dispatch({
    type: "NOTICE",
    message: sources.length
      ? `Marketplace sources: ${sources.join(", ")}`
      : "No marketplace sources. Add one with /plugin sources add <owner/repo>.",
  })
}

export function pluginSourcesAdd(ref: string, deps: PluginDeps): void {
  if (!ref) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /plugin sources add <owner/repo[@ref]>" })
    return
  }
  ;(deps.addSource ?? ((r) => void addSourceToStore(deps.home, r)))(ref)
  deps.dispatch({ type: "NOTICE", message: `Added marketplace source "${ref}".` })
}

export function pluginSourcesRemove(ref: string, deps: PluginDeps): void {
  if (!ref) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /plugin sources remove <owner/repo[@ref]>" })
    return
  }
  ;(deps.removeSource ?? ((r) => void removeSourceFromStore(deps.home, r)))(ref)
  deps.dispatch({ type: "NOTICE", message: `Removed marketplace source "${ref}".` })
}

// ── trusted publishers (GitHub owners) ──────────────────────────────────────────

export function pluginTrustList(deps: PluginDeps): void {
  const owners = (deps.getTrusted ?? (() => readTrustedOwners(deps.home)))()
  deps.dispatch({
    type: "NOTICE",
    message: owners.length
      ? `Trusted publishers: ${owners.join(", ")}`
      : "No trusted publishers. GitHub installs from any owner show an 'untrusted' warning until you /plugin trust add <owner>.",
  })
}

export function pluginTrustAdd(owner: string, deps: PluginDeps): void {
  const o = owner.trim()
  if (!o) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /plugin trust add <owner>" })
    return
  }
  ;(deps.addTrusted ?? ((x) => void addTrustedOwner(deps.home, x)))(o)
  deps.dispatch({ type: "NOTICE", message: `Trusted publisher "${o.toLowerCase()}".` })
}

export function pluginTrustRemove(owner: string, deps: PluginDeps): void {
  const o = owner.trim()
  if (!o) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /plugin trust remove <owner>" })
    return
  }
  ;(deps.removeTrusted ?? ((x) => void removeTrustedOwner(deps.home, x)))(o)
  deps.dispatch({ type: "NOTICE", message: `Revoked trust for "${o.toLowerCase()}".` })
}

// ── marketplace browse ──────────────────────────────────────────────────────────

export async function pluginMarketplace(deps: PluginDeps): Promise<void> {
  if (deps.signal?.aborted) return
  const sources = (deps.getSources ?? (() => readSources(deps.home)))()
  if (sources.length === 0) {
    deps.dispatch({
      type: "NOTICE",
      message: "No marketplace sources. Add one with /plugin sources add <owner/repo>.",
    })
    return
  }
  const browse =
    deps.browse ??
    (async (srcs: string[]) => {
      const { fetchAllSourceEntries } = await import("@/lib/plugin/package/github-marketplace")
      const { entries, errors } = await fetchAllSourceEntries(srcs)
      return {
        // Carry the catalog's rich metadata (author/version/rating/downloads/
        // signature) through to the overlay so it can search + section + show it.
        entries: entries.map((e): MarketplaceBrowseEntry => {
          const g = e.github
          const ref = g.ref ? `@${g.ref}` : ""
          const sub = g.subdir ? `/${g.subdir}` : ""
          return {
            name: e.name,
            installRef: `${g.owner}/${g.repo}${ref}${sub}`,
            description: e.description,
            author: e.author,
            version: e.version,
            rating: e.rating,
            downloads: e.downloads,
            signed: e.signed,
          }
        }),
        errors,
      }
    })
  let result: {
    entries: MarketplaceBrowseEntry[]
    errors: Array<{ repoRef: string; message: string }>
  }
  try {
    result = await browse(sources)
    if (deps.signal?.aborted) return
  } catch (err) {
    deps.dispatch({
      type: "NOTICE",
      message: `Marketplace fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    })
    return
  }
  if (result.errors.length) {
    deps.dispatch({
      type: "NOTICE",
      message: `Some sources failed: ${result.errors.map((e) => e.repoRef).join(", ")}`,
    })
  }
  if (result.entries.length === 0) {
    deps.dispatch({ type: "NOTICE", message: "No plugins found in the configured sources." })
    return
  }
  // Cross-reference the install provenance (where each installed plugin came
  // from + its version) with the disabled set so each catalog row can show an
  // installed / disabled / update badge and offer in-place actions.
  const origins = getOriginsOf(deps)
  const disabled = disabledOf(deps)
  const installed = Object.entries(origins).map(([id, o]) => ({
    id,
    repoRef: o.repoRef,
    version: o.version,
    enabled: !disabled.has(id),
  }))
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: { kind: "marketplace", entries: annotateInstallState(result.entries, installed) },
  })
}
