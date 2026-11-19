/**
 * Package changes a paired device, or a caller of the Host's remote API, asks
 * a Host for (ADR-0258 §4, paired client).
 *
 * The companion RPC arms for these commands used to swap the package in Rust
 * and only then tell anyone: a headless Host's brain reconciled afterwards by
 * enabling the plugin whatever state it had been in, and a desktop Host kept
 * running the old runtime over the new files until its next reload. Now the
 * Rust arm hands a device's request to the Host's own TypeScript (the
 * `desktop-write-source` bridge, installed in the desktop renderer and in the
 * headless brain), which runs it through the one replacement every environment
 * shares (`replace-package.ts`): stop the runtime, commit natively, register
 * the manifest on disk, and bring the plugin back to the state it was in, a
 * disabled one staying stopped.
 *
 * The native half is reached as the Host itself: the desktop through its Tauri
 * command, the brain through its service transport, which the Rust arm runs
 * natively because the caller is the service principal.
 *
 * Identity is checked before the package is touched. A staged update commits
 * only at the version the caller reviewed (`expectedVersion`, checked again
 * in Rust against the staged manifest); a manifest install only under the id
 * it names; a GitHub install is staged first so the plugin it turns out to be
 * is known, and stopped, before it lands.
 *
 * A successful answer means applied: the package is on disk and the plugin is
 * back in its state. A failure after the commit answers
 * `plugin_restart_required:` with the new package kept and the plugin stopped.
 */

import { z } from "zod"

import { isHeadlessHost } from "@/lib/platform/detect"
import type { PluginManifest } from "@/types/plugin"

import {
  packageOwnerOf,
  replacePluginPackage,
  type PackageReplacementOwner,
} from "./replace-package"
import type { RuntimeResumeState } from "./runtime-state"

export const HOST_PACKAGE_COMMANDS = [
  "plugin_install",
  "plugin_install_from_github",
  "plugin_uninstall",
  "plugin_commit_staged_update",
  "plugin_backup_restore",
] as const

export type HostPackageCommand = (typeof HOST_PACKAGE_COMMANDS)[number]

export function isHostPackageCommand(command: string): command is HostPackageCommand {
  return (HOST_PACKAGE_COMMANDS as readonly string[]).includes(command)
}

const pluginIdSchema = z.string().min(1).max(200)

const requestSchemas = {
  plugin_install: z
    .object({
      pluginId: pluginIdSchema,
      source: z.string().min(1),
      payload: z.object({ manifestJson: z.string().min(1) }).strict(),
    })
    .strict(),
  plugin_install_from_github: z
    .object({
      repo: z.string().min(1),
      gitRef: z.string().nullish(),
      subdir: z.string().nullish(),
      deferCommit: z.boolean().nullish(),
    })
    .strict(),
  plugin_uninstall: z.object({ pluginId: pluginIdSchema }).strict(),
  plugin_commit_staged_update: z
    .object({
      pluginId: pluginIdSchema,
      transactionId: z.string().uuid(),
      expectedVersion: z.string().min(1),
    })
    .strict(),
  plugin_backup_restore: z.object({ pluginId: pluginIdSchema, backupId: z.string().min(1) }).strict(),
} satisfies Record<HostPackageCommand, z.ZodType>

/** Thrown with a stable code prefix the Rust arm and the caller read. */
export class HostPackageChangeError extends Error {
  constructor(
    readonly code: "plugin_change_malformed" | "plugin_identity_mismatch" | "plugin_restart_required",
    detail: string,
    options?: { cause?: unknown }
  ) {
    super(`${code}: ${detail}`, options)
    this.name = "HostPackageChangeError"
  }
}

/** The plugin manager, as far as these commands use it. `PluginManager` satisfies it. */
export type HostPackageManager = Parameters<typeof packageOwnerOf>[0] & {
  uninstallPlugin(pluginId: string): Promise<void>
}

export interface HostPackageChangeDeps {
  manager: HostPackageManager
  /** Run the native command as this Host. */
  native: <T>(command: string, args: Record<string, unknown>) => Promise<T>
  /** Make the manager hold the manifest now on disk for `pluginId`. */
  register: (pluginId: string) => Promise<void>
  /**
   * Tell the headless brain's reconcile that the `plugin://runtime-changed`
   * event this change publishes is already applied. Returns a cancel for a
   * native call that failed (and so published nothing).
   */
  expectRuntimeEvent?: (pluginId: string) => () => void
}

// ── Events this Host applied itself ─────────────────────────────────────────

/** How long an expected event is waited for before a later one is treated as foreign. */
const EXPECTED_EVENT_TTL_MS = 5 * 60_000
const expectedEvents = new Map<string, number[]>()

function pruneExpected(pluginId: string, now: number): number[] {
  const live = (expectedEvents.get(pluginId) ?? []).filter((deadline) => deadline > now)
  if (live.length > 0) expectedEvents.set(pluginId, live)
  else expectedEvents.delete(pluginId)
  return live
}

/** Record that this Host will publish one runtime-changed event for `pluginId` that it already applied. */
export function expectRuntimeEvent(pluginId: string, now = Date.now()): () => void {
  const deadline = now + EXPECTED_EVENT_TTL_MS
  expectedEvents.set(pluginId, [...pruneExpected(pluginId, now), deadline])
  return () => {
    const live = expectedEvents.get(pluginId) ?? []
    const index = live.indexOf(deadline)
    if (index >= 0) live.splice(index, 1)
    if (live.length === 0) expectedEvents.delete(pluginId)
  }
}

/** Consume one expected event: true when this Host already applied the change it reports. */
export function takeExpectedRuntimeEvent(pluginId: string, now = Date.now()): boolean {
  const live = pruneExpected(pluginId, now)
  if (live.length === 0) return false
  live.shift()
  if (live.length === 0) expectedEvents.delete(pluginId)
  return true
}

/** @internal */
export function __resetExpectedRuntimeEventsForTests(): void {
  expectedEvents.clear()
}

// ── Registration on a headless Host ─────────────────────────────────────────

let headlessRegistration: ((pluginId: string) => Promise<void>) | undefined

/**
 * The headless brain discovers disk plugins in Node (`cli/src/plugin/host.ts`),
 * which this module cannot import; its plugin runtime provides the lookup.
 */
export function provideHeadlessPackageRegistration(
  register: (pluginId: string) => Promise<void>
): () => void {
  headlessRegistration = register
  return () => {
    if (headlessRegistration === register) headlessRegistration = undefined
  }
}

/** This Host's manager, native commands and registration: the desktop's or the headless brain's. */
export async function hostPackageChangeDeps(): Promise<HostPackageChangeDeps> {
  const [{ getPluginManager }, { isTauri }] = await Promise.all([
    import("@/lib/plugin/core/manager"),
    import("@/lib/tauri"),
  ])
  const manager = getPluginManager()
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core")
    return {
      manager,
      native: (command, args) => invoke(command, args),
      register: async (pluginId) => {
        const discovered = await manager.scanPlugins()
        if (!discovered.some((entry) => entry.manifest.id === pluginId)) {
          throw new Error(`plugin_not_discovered: ${pluginId} is on disk but discovery refused it`)
        }
      },
    }
  }
  if (isHeadlessHost()) {
    const { transport } = await import("@/lib/tauri")
    return {
      manager,
      native: (command, args) => transport.call(command, args),
      register: async (pluginId) => {
        if (!headlessRegistration) throw new Error("headless plugin runtime has not started")
        await headlessRegistration(pluginId)
      },
      expectRuntimeEvent,
    }
  }
  throw new Error("headless_host: only a desktop or headless host changes plugin packages")
}

// ── The commands ────────────────────────────────────────────────────────────

const REASON = "host-package-change"

function strip(raw: unknown): Record<string, unknown> {
  const {
    adminLease: _lease,
    admin_lease: _leaseSnake,
    callerDeviceId: _caller,
    ...rest
  } = (raw ?? {}) as Record<string, unknown>
  return rest
}

function parse<C extends HostPackageCommand>(
  command: C,
  raw: unknown
): z.infer<(typeof requestSchemas)[C]> {
  const parsed = requestSchemas[command].safeParse(strip(raw))
  if (!parsed.success) {
    throw new HostPackageChangeError(
      "plugin_change_malformed",
      `${command}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`
    )
  }
  return parsed.data as z.infer<(typeof requestSchemas)[C]>
}

/** Commit natively with the runtime stopped, then bring the plugin back. */
async function replace<T>(
  owner: PackageReplacementOwner,
  deps: HostPackageChangeDeps,
  pluginId: string,
  commit: () => Promise<T>
): Promise<{ result: T; runtime: RuntimeResumeState }> {
  let cancelExpectation: (() => void) | undefined
  let committed = false
  try {
    return await replacePluginPackage(owner, {
      pluginId,
      commit: async () => {
        cancelExpectation = deps.expectRuntimeEvent?.(pluginId)
        try {
          const result = await commit()
          committed = true
          return result
        } catch (error) {
          cancelExpectation?.()
          throw error
        }
      },
      register: () => deps.register(pluginId),
      // A device installing a plugin on its Host means it to run, as the
      // headless reconcile always did; a disabled intent still wins.
      whenNew: "enabled",
      reason: REASON,
    })
  } catch (error) {
    if (!committed) throw error
    // The new package stays; leave its runtime stopped and say so.
    await owner.disablePlugin(pluginId, `${REASON}-failed`).catch(() => undefined)
    await owner.unloadPlugin(pluginId).catch(() => undefined)
    throw new HostPackageChangeError(
      "plugin_restart_required",
      `${pluginId}: the package was replaced but could not be started: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }
}

interface StagedGithubInstall {
  manifest: PluginManifest
  transactionId?: string | null
  [key: string]: unknown
}

async function installFromGithub(
  owner: PackageReplacementOwner,
  deps: HostPackageChangeDeps,
  request: z.infer<(typeof requestSchemas)["plugin_install_from_github"]>
): Promise<unknown> {
  // Staging only: nothing on disk under a plugin changes.
  if (request.deferCommit) return deps.native("plugin_install_from_github", request)
  const staged = await deps.native<StagedGithubInstall>("plugin_install_from_github", {
    ...request,
    deferCommit: true,
  })
  const transactionId = staged.transactionId
  const pluginId = staged.manifest?.id
  const version = staged.manifest?.version
  if (!transactionId || !pluginId || !version) {
    throw new Error("plugin_install_from_github: the Host returned an invalid staged install")
  }
  let committed = false
  try {
    await replace(owner, deps, pluginId, async () => {
      await deps.native("plugin_commit_staged_update", {
        pluginId,
        transactionId,
        expectedVersion: version,
      })
      committed = true
    })
  } catch (error) {
    if (!committed) {
      await deps
        .native("plugin_discard_staged_update", { pluginId, transactionId })
        .catch(() => undefined)
    }
    throw error
  }
  await deps
    .native("plugin_finalize_staged_update", { pluginId, transactionId })
    .catch(() => undefined)
  return { ...staged, transactionId: null }
}

/** The `desktop-write-source` arm for every {@link HOST_PACKAGE_COMMANDS} command. */
export async function applyHostPackageChange(
  command: HostPackageCommand,
  raw: unknown,
  deps?: HostPackageChangeDeps
): Promise<unknown> {
  const d = deps ?? (await hostPackageChangeDeps())
  const owner = packageOwnerOf(d.manager)
  switch (command) {
    case "plugin_install": {
      const request = parse(command, raw)
      let manifest: { id?: unknown; version?: unknown }
      try {
        manifest = JSON.parse(request.payload.manifestJson) as typeof manifest
      } catch (error) {
        throw new HostPackageChangeError(
          "plugin_change_malformed",
          `plugin_install.payload.manifestJson: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      if (manifest.id !== request.pluginId) {
        throw new HostPackageChangeError(
          "plugin_identity_mismatch",
          `the manifest names ${String(manifest.id)}, not ${request.pluginId}`
        )
      }
      return (await replace(owner, d, request.pluginId, () => d.native(command, request))).result
    }
    case "plugin_install_from_github":
      return installFromGithub(owner, d, parse(command, raw))
    case "plugin_commit_staged_update": {
      const request = parse(command, raw)
      return (await replace(owner, d, request.pluginId, () => d.native(command, request))).result
    }
    case "plugin_backup_restore": {
      const request = parse(command, raw)
      return (await replace(owner, d, request.pluginId, () => d.native(command, request))).result
    }
    case "plugin_uninstall": {
      const request = parse(command, raw)
      // Through the manager, which unloads the runtime before removing the
      // package and drops its records afterwards. The brain's reconcile of the
      // event that follows finds nothing left to do.
      if (owner.statusOf(request.pluginId) === undefined) {
        await d.native(command, request)
      } else {
        await d.manager.uninstallPlugin(request.pluginId)
      }
      return null
    }
  }
}
