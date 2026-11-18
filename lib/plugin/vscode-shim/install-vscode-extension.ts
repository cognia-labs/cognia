/**
 * The single place a `.vsix` becomes an installed cognia plugin.
 *
 * Both entry points — the drag-drop dialog and the Open VSX marketplace —
 * funnel through here so the manifest adaptation cannot be skipped again.
 *
 * ## Why this module exists
 *
 * The install dialog used to persist the raw VS Code `package.json` as the
 * cognia manifest. That broke two ways at once:
 *
 * 1. **Legitimate extensions never activated.** `loadVscodeDefinition` requires
 *    `manifest.vscodeMain` and `manifest.vscodeExtension.identifier`; only
 *    `adaptVscodeManifest` produces them. A real `package.json` has `main`, no
 *    `vscodeExtension` block, and therefore always threw at activate time —
 *    the error text even said "manifest adapter must populate this at install".
 *
 * 2. **Hostile extensions activated _and_ escalated.** Because the raw object
 *    was persisted verbatim, a crafted `package.json` could self-declare
 *    `vscodeExtension.publisherKeyFingerprint`. `manager.ts` forwards that
 *    field to `lsp-binary-policy`, which matched it against the
 *    `trustedPublishers` ledger by plain string equality and then granted
 *    prompt-free `child_process.spawn`.
 *
 * `adaptVscodeManifest` rebuilds the `vscodeExtension` block from scratch and
 * never copies a fingerprint out of the source manifest, so routing every
 * install through it closes both holes with one change.
 *
 * ## Two phases, on purpose
 *
 * `prepare` does no I/O beyond parsing; `commit` touches disk and Dexie. The
 * split lets callers show real, inferred permissions *before* the user
 * consents — the dialog previously read `pkgJson.permissions`, a field VS Code
 * manifests do not have, so its permission review was always empty.
 */

import { recordInstallOrigin } from "@/lib/plugin/origin/install-origin"
import type {
  CogpackProvenance,
  PluginInstallOrigin,
  PluginInstallOriginRecord,
} from "@/types/plugin/plugin-cogset"
import { loggers } from "@cognia/logging"
import { deletePlugin, getPlugin, upsertPlugin } from "@/lib/db/plugins"
import { getInstallOrigin } from "@/lib/db/plugin-install-origins"
import { removeFile } from "@/lib/file/file-operations"
import { canUseTauriInvoke } from "@/lib/native/utils"
import { dispatchPluginError } from "@/lib/plugin/error-bus"
import {
  quiesceRuntime,
  restoreRuntimeState,
  runtimeResumeStateOf,
  type RuntimeResumeState,
} from "@/lib/plugin/lifecycle/runtime-state"
import { usePluginStore } from "@/stores/plugin-runtime"
// `PluginRow` lives in `plugin-types`; `schema.ts` imports it for its table
// declarations but does not re-export it.
import type { PluginRow } from "@/lib/db/plugin-types"
import type { Plugin, PluginManifest, PluginSource } from "@/types/plugin/plugin"
import type {
  VsCodeExtensionAdapterResult,
  VsCodeExtensionBlock,
} from "@/types/plugin/plugin-vscode"
import { adaptVscodeManifest } from "./manifest-adapter"
import { inferPermissions } from "./permission-inference"
import { installVsix, type VsixInstallResult } from "./vsix-installer"

/** A parsed + adapted `.vsix`, ready to review and then commit. */
export interface PreparedVscodeExtension {
  /** Raw `.vsix` bytes, retained for the commit step. */
  bytes: Uint8Array
  /** Parsed archive — themes, files, sha256, LSP binary candidates. */
  vsix: VsixInstallResult
  /** The cognia manifest plus inference, warnings, and binary candidates. */
  adapted: VsCodeExtensionAdapterResult
  /**
   * Path to a `.vsix` the Rust downloader already staged and checksum-verified
   * (`plugin_vscode_download_vsix`). Present only on the Open VSX path.
   *
   * When set, the commit installs from that path instead of shipping the bytes
   * back over IPC as base64. On an 80 MB extension the base64 round trip means
   * a ~107 MB JS string alongside the Rust `Vec` — the difference between
   * installing and OOMing the webview. The bytes still had to reach JS (that is
   * where permission inference runs); this only avoids re-encoding them to hand
   * back something Rust already has on disk.
   *
   * Rust consumes the file: it is deleted whether the install succeeds or not.
   */
  stagedPath?: string
}

/** Shape returned by the Rust `plugin_vscode_install_vsix` command. */
interface RustInstallResult {
  extensionId: string
  installPath: string
  sha256Hex: string
  packageJson: unknown
}

/**
 * Parse a `.vsix` and derive its cognia manifest. No disk or Dexie writes.
 *
 * @throws when the archive is malformed, over the size cap, or its
 * `publisher` / `name` cannot form a safe id (see `./extension-id`).
 */
export async function prepareVscodeExtension(
  bytes: Uint8Array,
  source: VsCodeExtensionBlock["source"],
  /**
   * The Open VSX `targetPlatform` this build was resolved for. Only the
   * marketplace path knows it (the platform is a registry fact, not something
   * the archive declares); drag-drop leaves it undefined.
   */
  targetPlatform?: string,
  /**
   * Whether the download's Open VSX signature was verified host-side. Only
   * the marketplace path knows; the host also records it in the receipt the
   * install gets, which is what enabling checks.
   */
  signedByOpenVsx = false
): Promise<PreparedVscodeExtension> {
  const vsix = await installVsix(bytes)
  const inference = inferPermissions({ vsix })
  const adapted = adaptVscodeManifest({ vsix, inference, source, targetPlatform, signedByOpenVsx })
  return { bytes, vsix, adapted }
}

/** Raised when an extension is installed where VS Code extensions cannot run. */
export class VscodeExtensionsUnavailableError extends Error {
  constructor() {
    super("VS Code extensions can only be installed in the desktop app")
    this.name = "VscodeExtensionsUnavailableError"
  }
}

/** One committed extension, and the way to take it back. */
export interface VscodeExtensionCommit {
  row: PluginRow
  /**
   * Undo this commit: a fresh install is removed (row first, then the
   * directory), a replaced one gets its previous package, row, store entry,
   * install origin and runtime state back.
   */
  revert: () => Promise<void>
}

type PluginManagerHandle = Awaited<ReturnType<typeof loadPluginManager>>

async function loadPluginManager() {
  const { getPluginManager } = await import("@/lib/plugin/core/manager")
  return getPluginManager()
}

async function loadBackupManager() {
  const { getPluginBackupManager } = await import("@/lib/plugin/lifecycle/backup")
  return getPluginBackupManager()
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** What was installed under an id before this commit replaced it. */
interface ReplacedInstall {
  /** The runtime entry; set exactly when an installed copy is being replaced. */
  entry: Plugin | undefined
  row: PluginRow | undefined
  origin: PluginInstallOriginRecord | undefined
  /** The pre-replacement snapshot, when there was a package to snapshot. */
  backupId: string | undefined
}

/**
 * Put back what this commit replaced, or remove what it installed fresh. Runs
 * with the runtime stopped, inside the package mutation. Collects failures instead of stopping at the first:
 * each step that can still run brings the install closer to where it was.
 */
async function undoPackage(
  manager: PluginManagerHandle,
  id: string,
  installPath: string,
  replaced: ReplacedInstall
): Promise<string[]> {
  const failures: string[] = []
  const step = async (what: string, run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      failures.push(`${what}: ${messageOf(error)}`)
    }
  }
  if (replaced.entry) {
    await step("restore the previous package", async () => {
      if (!replaced.backupId) throw new Error("no snapshot of the previous package was taken")
      const restored = await (await loadBackupManager()).restore(replaced.backupId, manager)
      if (!restored.success) throw new Error(restored.error ?? "backup restore failed")
    })
    const previousRow = replaced.row
    await step("restore the previous row", () =>
      previousRow ? upsertPlugin(previousRow) : deletePlugin(id)
    )
    await step("restore the previous runtime entry", () =>
      manager.restorePluginEntry(id, replaced.entry)
    )
    if (replaced.origin) {
      const { pluginId, version, origin, viaCogpack } = replaced.origin
      await recordInstallOrigin({ pluginId, version, origin, viaCogpack })
    }
  } else {
    // A row pointing at a deleted directory is a plugin the manager will try
    // to load and fail on; a directory with no row is inert. Row first.
    await step("drop the row", () => deletePlugin(id))
    await step("drop the runtime entry", () => manager.restorePluginEntry(id, undefined))
    await step("remove the unpacked extension", () => removeFile(installPath, { recursive: true }))
  }
  return failures
}

/**
 * Unpack a prepared extension to disk, record it in Dexie and register it
 * with the runtime, as one transaction. Desktop only: elsewhere there is no
 * extension host to run it, so the install is refused instead of recording a
 * row nothing can load.
 *
 * An extension already installed under the same id is stopped first and
 * snapshotted, so a failure after the host replaced its files puts the old
 * package, row and runtime entry back, and a success brings the runtime back
 * to the state it was in (enabled, suspended, loaded or stopped). The host
 * installs only the bytes whose sha256 the user reviewed.
 */
export async function commitVscodeExtension(
  prepared: PreparedVscodeExtension,
  provenance: { viaCogpack?: CogpackProvenance } = {}
): Promise<VscodeExtensionCommit> {
  const { bytes, vsix, adapted, stagedPath } = prepared
  if (!canUseTauriInvoke()) throw new VscodeExtensionsUnavailableError()
  const id = adapted.manifest.id
  const manager = await loadPluginManager()

  const replaced: ReplacedInstall = {
    entry: usePluginStore.getState().plugins[id],
    row: await getPlugin(id),
    origin: await getInstallOrigin(id),
    backupId: undefined,
  }
  for (const existing of [replaced.entry?.manifest.type, replaced.row?.type]) {
    if (existing !== undefined && existing !== "vscode-extension") {
      throw new Error(
        `An installed ${existing} plugin is already named ${id}; nothing was installed`
      )
    }
  }
  if (!replaced.entry && replaced.row?.path) {
    // Installed before installs registered with the runtime: register the
    // copy on disk so it is stopped and snapshotted like any other.
    await manager.registerVscodeExtension(
      replaced.row.manifest as unknown as PluginManifest,
      replaced.row.path,
      replaced.row.source
    )
    replaced.entry = usePluginStore.getState().plugins[id]
  }

  const resume = runtimeResumeStateOf(replaced.entry?.status)
  const reservation = replaced.entry ? manager.reservePluginRuntimeGraph(id) : undefined
  try {
    let row: PluginRow
    try {
      await quiesceRuntime(manager, id, resume, "vscode-install")
      // A disabled extension is inactive but still loaded from the old files.
      if (replaced.entry?.status === "disabled") await manager.unloadPlugin(id)
      if (replaced.entry) {
        const backup = await (await loadBackupManager()).createBackup(id, { reason: "pre-update" })
        if (!backup.success || !backup.backup) {
          throw new Error(`Could not snapshot the installed ${id}: ${backup.error ?? "unknown"}`)
        }
        replaced.backupId = backup.backup.id
      }
      row = await manager.withPluginPackageMutation(id, async () => {
        const { invoke } = await import("@tauri-apps/api/core")
        // Two commands, one installer behind them. `..._from_path` is used when
        // the downloader already put a verified copy on disk; the base64 form is
        // for bytes that only ever existed in the renderer (drag-drop).
        const result = stagedPath
          ? await invoke<RustInstallResult>("plugin_vscode_install_vsix_from_path", {
              tempPath: stagedPath,
              expectedSha256: vsix.sha256,
            })
          : await invoke<RustInstallResult>("plugin_vscode_install_vsix", {
              vsixBase64: bytesToBase64(bytes),
              expectedSha256: vsix.sha256,
            })
        // Rust derives the id under the same strict rule
        // (`sanitize_plugin_id_strict`) before it touches the filesystem. If the
        // two ever disagree, the host wrote another extension's directory: this
        // id's package is untouched, and that directory has no snapshot here to
        // restore, so it is reported rather than deleted.
        if (result.extensionId !== id) {
          throw new Error(
            `VS Code extension id mismatch: renderer derived "${id}", ` +
              `Rust unpacked to "${result.extensionId}" (${result.installPath}). The id rules ` +
              `have drifted — lib/plugin/vscode-shim/extension-id.ts and ` +
              `sanitize_plugin_id_strict must agree.`
          )
        }
        try {
          return await recordCommittedPackage(manager, prepared, result, replaced, provenance)
        } catch (error) {
          const failures = await undoPackage(manager, id, result.installPath, replaced)
          if (failures.length === 0) throw error
          throw new Error(
            `${messageOf(error)}; undoing the install also failed (${failures.join("; ")})`
          )
        }
      })
    } catch (error) {
      try {
        await restoreRuntimeState(manager, id, resume, "vscode-install-restore")
      } catch (restoreError) {
        throw new Error(
          `${messageOf(error)}; restarting the previous ${id} also failed: ${messageOf(restoreError)}`
        )
      }
      throw error
    }

    try {
      await restoreRuntimeState(manager, id, resume, "vscode-install")
    } catch (error) {
      // The new package is installed and recorded; only its restart failed.
      // Report it without calling the install a failure.
      dispatchPluginError({
        pluginId: id,
        pluginName: adapted.manifest.name,
        stage: "activation",
        message: messageOf(error),
        severity: "warning",
        recoverable: true,
      })
    }

    return {
      row,
      revert: () => revertCommit(manager, id, row.path, replaced, resume),
    }
  } finally {
    if (reservation) manager.releasePluginRuntimeGraph(reservation)
  }
}

/**
 * Check the host installed the reviewed bytes, then record them: the Dexie
 * row, the runtime entry and the install origin. Runs inside the package
 * mutation, after the host replaced this id's package.
 */
async function recordCommittedPackage(
  manager: PluginManagerHandle,
  prepared: PreparedVscodeExtension,
  result: RustInstallResult,
  replaced: ReplacedInstall,
  provenance: { viaCogpack?: CogpackProvenance }
): Promise<PluginRow> {
  const { vsix, adapted } = prepared
  if (result.sha256Hex.toLowerCase() !== vsix.sha256.toLowerCase()) {
    throw new Error(
      `The host installed a .vsix hashing to ${result.sha256Hex}, not the reviewed ${vsix.sha256}`
    )
  }

  const source = pluginRowSource(adapted.manifest.vscodeExtension?.source ?? null)
  const row = await upsertPlugin({
    id: adapted.manifest.id,
    name: adapted.manifest.name,
    version: adapted.manifest.version,
    // A replacement keeps the row's status, enabled flag and config; only a
    // fresh install starts out discovered and off.
    ...(replaced.row ? {} : { status: "discovered" as const, enabled: false }),
    source,
    type: "vscode-extension",
    path: result.installPath,
    // The whole point of this module: the *adapted* manifest, never `pkgJson`.
    manifest: adapted.manifest as unknown as Record<string, unknown>,
    capabilities: adapted.manifest.capabilities,
  })
  await manager.registerVscodeExtension(adapted.manifest, result.installPath, source)
  await recordInstallOrigin({
    pluginId: adapted.manifest.id,
    version: adapted.manifest.version,
    origin: vscodeInstallOrigin(adapted.manifest.vscodeExtension, vsix.sha256),
    viaCogpack: provenance.viaCogpack,
  })
  return row
}

/** Take a committed extension back out, for a graph whose later node failed. */
async function revertCommit(
  manager: PluginManagerHandle,
  id: string,
  installPath: string,
  replaced: ReplacedInstall,
  previousState: RuntimeResumeState
): Promise<void> {
  const current = runtimeResumeStateOf(usePluginStore.getState().plugins[id]?.status)
  const reservation = manager.reservePluginRuntimeGraph(id)
  try {
    await quiesceRuntime(manager, id, current, "vscode-install-revert")
    if (usePluginStore.getState().plugins[id]?.status === "disabled") await manager.unloadPlugin(id)
    const failures = await manager.withPluginPackageMutation(id, () =>
      undoPackage(manager, id, installPath, replaced)
    )
    if (failures.length > 0) {
      throw new Error(`Could not undo the install of ${id}: ${failures.join("; ")}`)
    }
    if (replaced.entry) {
      await restoreRuntimeState(manager, id, previousState, "vscode-install-revert")
    }
  } finally {
    manager.releasePluginRuntimeGraph(reservation)
  }
}

/**
 * The origin of a committed extension (ADR-0209). An Open VSX install is pinned
 * by namespace, name, version and the verified VSIX hash; the namespace is the
 * `publisher` half of the `publisher.name` identifier. A dropped `.vsix` has
 * nothing to fetch again, so it exports embedded.
 */
export function vscodeInstallOrigin(
  block: VsCodeExtensionBlock | undefined,
  sha256: string
): PluginInstallOrigin {
  if (block?.source === "openvsx") {
    const [namespace, ...rest] = block.identifier.split(".")
    const name = rest.join(".")
    if (namespace && name) {
      return {
        kind: "openvsx",
        namespace,
        name,
        version: block.version,
        sha256,
        ...(block.targetPlatform ? { targetPlatform: block.targetPlatform } : {}),
      }
    }
  }
  return { kind: "local", via: block?.source === "dev" ? "directory" : "vsix" }
}

/** Parse, adapt, unpack, and record in one call. */
export async function installVscodeExtensionFromBytes(input: {
  bytes: Uint8Array
  source: VsCodeExtensionBlock["source"]
}): Promise<{ row: PluginRow; prepared: PreparedVscodeExtension }> {
  const prepared = await prepareVscodeExtension(input.bytes, input.source)
  if (prepared.adapted.warnings.length > 0) {
    loggers.plugin.warn("VS Code manifest adapted with warnings", {
      extension: prepared.adapted.manifest.id,
      warnings: prepared.adapted.warnings,
    })
  }
  const { row } = await commitVscodeExtension(prepared)
  return { row, prepared }
}

/**
 * Map the manifest-level install source onto `PluginRow.source`.
 *
 * These are two different vocabularies that happen to share a field name.
 * `VsCodeExtensionBlock["source"]` records *how the extension reached us*
 * (`"openvsx" | "vsix-upload" | "dev" | null`), while `PluginSource` is the
 * generic plugin origin (`"builtin" | "local" | "marketplace" | "git" | "dev"`)
 * and has no `"openvsx"` member. Conflating them is a type error at best and a
 * mislabelled row at worst.
 */
function pluginRowSource(source: VsCodeExtensionBlock["source"]): PluginSource {
  switch (source) {
    case "openvsx":
      return "marketplace"
    case "dev":
      return "dev"
    default:
      return "local"
  }
}

/**
 * Encode bytes as base64 for the Tauri IPC boundary.
 *
 * Chunked because `String.fromCharCode(...bytes)` blows the argument limit on
 * anything but a toy extension. The `Buffer` fallback keeps this usable under
 * the Jest node environment, where `btoa` is not guaranteed.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 32 * 1024
  let binary = ""
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length))
    binary += String.fromCharCode.apply(null, Array.from(slice) as number[])
  }
  return typeof btoa !== "undefined"
    ? btoa(binary)
    : Buffer.from(binary, "binary").toString("base64")
}
