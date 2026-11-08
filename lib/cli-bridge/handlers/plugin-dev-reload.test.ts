import type { PluginLifecycleCoordinatorSnapshot } from "@/lib/plugin/core/lifecycle-coordinator"

import {
  pluginDevReload,
  resolvePluginDevCapability,
  type PluginDevReloadDependencies,
} from "./plugin-dev-reload"

const mockProductionIsTauri = jest.fn(() => false)
let mockProductionSnapshots: PluginLifecycleCoordinatorSnapshot[] = []
const mockProductionManager = {
  scanPlugins: jest.fn(async () => []),
  reloadPlugin: jest.fn(async () => undefined),
  enablePlugin: jest.fn(async () => undefined),
  disablePlugin: jest.fn(async () => undefined),
  unloadPlugin: jest.fn(async () => undefined),
  hasUnresolvedActivationResources: jest.fn(() => false),
  withPluginPackageMutation: async <T>(_id: string, operation: () => Promise<T>) => operation(),
  getPluginLifecycleSnapshots: jest.fn(() => mockProductionSnapshots),
}
const mockProductionPlugins: Record<string, unknown> = {}
jest.mock("@/lib/tauri", () => ({ isTauri: () => mockProductionIsTauri() }))
jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: () => mockProductionManager,
}))
jest.mock("@/lib/plugin/devtools/developer-mode", () => ({
  isDeveloperModeEnabled: () => true,
}))
jest.mock("@/stores/plugin-runtime/plugin-store", () => ({
  usePluginStore: { getState: () => ({ plugins: mockProductionPlugins }) },
}))

const baseSnapshot = (
  overrides: Partial<PluginLifecycleCoordinatorSnapshot> = {}
): PluginLifecycleCoordinatorSnapshot => ({
  managerId: "manager-1",
  pluginId: "demo.plugin",
  generation: 3,
  intent: "enabled",
  actual: "active",
  stateSince: 1,
  requiredServices: [],
  providedServices: [],
  currentProviders: [],
  effects: { active: 0, pending: 0, failed: 0, labels: [] },
  packageRevision: "1.2.3",
  source: "dev",
  configRevision: 1,
  ...overrides,
})

function createDependencies(
  options: {
    status?: "enabled" | "installed" | "disabled" | "suspended"
    before?: PluginLifecycleCoordinatorSnapshot
    after?: PluginLifecycleCoordinatorSnapshot
    developerMode?: boolean
    pluginMissing?: boolean
    version?: string
    pluginType?: string
    activationError?: unknown
    scanError?: Error
    delayedAfter?: PluginLifecycleCoordinatorSnapshot
    dirtyOnActivationError?: PluginLifecycleCoordinatorSnapshot
    afterUnload?: PluginLifecycleCoordinatorSnapshot
    unloadError?: Error
    unresolvedResources?: boolean
  } = {}
) {
  let snapshot = options.before ?? baseSnapshot()
  let status = options.status ?? "enabled"
  const reloadPlugin = jest.fn(async () => {
    if (options.activationError) {
      if (options.dirtyOnActivationError) snapshot = options.dirtyOnActivationError
      throw options.activationError
    }
    snapshot =
      options.after ?? (options.delayedAfter ? baseSnapshot() : baseSnapshot({ generation: 4 }))
  })
  const enablePlugin = jest.fn(async () => {
    if (options.activationError) {
      if (options.dirtyOnActivationError) snapshot = options.dirtyOnActivationError
      throw options.activationError
    }
    snapshot =
      options.after ?? (options.delayedAfter ? baseSnapshot() : baseSnapshot({ generation: 4 }))
  })
  const scanPlugins = jest.fn(async () => {
    if (options.scanError) throw options.scanError
    return []
  })
  const disablePlugin = jest.fn(async () => {
    status = "disabled"
  })
  const unloadPlugin = jest.fn(async () => {
    snapshot = options.afterUnload ?? baseSnapshot({ actual: "inactive" })
    status = "installed"
    if (options.unloadError) throw options.unloadError
  })
  const deps: PluginDevReloadDependencies = {
    isDesktop: () => true,
    isDeveloperModeEnabled: () => options.developerMode ?? true,
    getPlugin: () =>
      options.pluginMissing
        ? undefined
        : ({
            status,
            manifest: {
              id: "demo.plugin",
              version: options.version ?? "1.2.3",
              type: options.pluginType ?? "frontend",
            },
          } as never),
    manager: {
      scanPlugins,
      reloadPlugin,
      enablePlugin,
      disablePlugin,
      unloadPlugin,
      hasUnresolvedActivationResources: () => options.unresolvedResources ?? false,
      withPluginPackageMutation: async <T>(_id: string, operation: () => Promise<T>) => operation(),
      getPluginLifecycleSnapshots: () => [snapshot],
    },
    sleep: async () => {
      if (options.delayedAfter) snapshot = options.delayedAfter
    },
    timeoutMs: options.delayedAfter ? 100 : 0,
  }
  return { deps, reloadPlugin, enablePlugin, scanPlugins, disablePlugin, unloadPlugin }
}

const payload = {
  schemaVersion: 1 as const,
  sessionId: "550e8400-e29b-41d4-a716-446655440000",
  attempt: 2,
  pluginId: "demo.plugin",
  packageVersion: "1.2.3",
  artifactRevision: "sha256:abc123",
  activate: true,
}

describe("pluginDevReload", () => {
  beforeEach(() => {
    mockProductionIsTauri.mockReturnValue(false)
    mockProductionSnapshots = []
    mockProductionManager.scanPlugins.mockClear()
    mockProductionManager.reloadPlugin.mockReset()
    mockProductionManager.reloadPlugin.mockResolvedValue(undefined)
    mockProductionManager.enablePlugin.mockReset()
    mockProductionManager.enablePlugin.mockResolvedValue(undefined)
    mockProductionManager.getPluginLifecycleSnapshots.mockClear()
    for (const pluginId of Object.keys(mockProductionPlugins))
      delete mockProductionPlugins[pluginId]
  })

  it("prepares the old package without checking the candidate version or activating it", async () => {
    const { deps, disablePlugin, unloadPlugin, enablePlugin, reloadPlugin } = createDependencies({
      version: "1.2.2",
    })
    const result = await pluginDevReload({ ...payload, phase: "prepare" }, deps)
    expect(result).toMatchObject({ ok: true, stage: "quiesce", runtimeQuiesced: true })
    expect(result.activationProof).toBeUndefined()
    expect(result.quiescenceProof).toEqual({ previousGeneration: 3, generation: 3 })
    expect(disablePlugin).toHaveBeenCalledWith("demo.plugin", "cli-dev")
    expect(unloadPlugin).toHaveBeenCalledWith("demo.plugin")
    expect(enablePlugin).not.toHaveBeenCalled()
    expect(reloadPlugin).not.toHaveBeenCalled()
    await pluginDevReload({ ...payload, phase: "rescan" }, deps)
  })

  it("activates only the generation admitted by prepare, preserving reload intent", async () => {
    const { deps, enablePlugin, reloadPlugin } = createDependencies()
    await pluginDevReload({ ...payload, activate: false, phase: "prepare" }, deps)
    const result = await pluginDevReload({ ...payload, activate: false, phase: "activate" }, deps)
    expect(result.ok).toBe(true)
    expect(result.activationProof).toMatchObject({ previousGeneration: 3, generation: 4 })
    expect(enablePlugin).toHaveBeenCalledWith("demo.plugin", "cli-dev")
    expect(reloadPlugin).not.toHaveBeenCalled()
  })

  it("rejects activation without matching admission", async () => {
    const { deps, enablePlugin } = createDependencies()
    const result = await pluginDevReload({ ...payload, phase: "activate" }, deps)
    expect(result.error?.code).toBe("prepare_required")
    expect(enablePlugin).not.toHaveBeenCalled()
  })

  it("does not let a retried attempt release another transaction's package fence", async () => {
    const { deps, enablePlugin } = createDependencies()
    const first = { ...payload, transactionId: "transaction-1" }
    const retry = { ...payload, transactionId: "transaction-2" }
    await pluginDevReload({ ...first, phase: "prepare" }, deps)
    expect((await pluginDevReload({ ...retry, phase: "prepare" }, deps)).ok).toBe(false)
    expect((await pluginDevReload({ ...retry, phase: "rescan" }, deps)).ok).toBe(false)
    expect((await pluginDevReload({ ...retry, phase: "activate" }, deps)).ok).toBe(false)
    expect(enablePlugin).not.toHaveBeenCalled()
    expect((await pluginDevReload({ ...first, phase: "activate" }, deps)).ok).toBe(true)
  })

  it("rejects a changed attempt and a changed runtime generation after prepare", async () => {
    const { deps, enablePlugin } = createDependencies()
    await pluginDevReload({ ...payload, phase: "prepare" }, deps)
    const otherAttempt = await pluginDevReload({ ...payload, attempt: 3, phase: "activate" }, deps)
    expect(otherAttempt.error?.code).toBe("prepare_required")
    deps.manager!.getPluginLifecycleSnapshots = () => [baseSnapshot({ generation: 9 })]
    const changed = await pluginDevReload({ ...payload, phase: "activate" }, deps)
    expect(changed).toMatchObject({ outcome: "restart_required", runtimeQuiesced: false })
    expect(changed.error?.code).toBe("runtime_generation_mismatch")
    expect(enablePlugin).not.toHaveBeenCalled()
    await pluginDevReload({ ...payload, phase: "rescan" }, deps)
  })

  it.each([
    { afterUnload: baseSnapshot({ actual: "dirty" }) },
    { afterUnload: baseSnapshot({ actual: "stopping" }) },
    { afterUnload: baseSnapshot({ actual: "inactive", pendingTransition: "unload" }) },
    { unresolvedResources: true },
    { unloadError: new Error("teardown rejected") },
  ])("never admits unconfirmed teardown: %j", async (options) => {
    const { deps, enablePlugin } = createDependencies(options)
    const result = await pluginDevReload({ ...payload, phase: "prepare" }, deps)
    expect(result.ok).toBe(false)
    expect(result.runtimeQuiesced).not.toBe(true)
    expect(enablePlugin).not.toHaveBeenCalled()
  })

  it("cleans a failed activation before authorizing rollback and rescans without enabling", async () => {
    const { deps, scanPlugins, enablePlugin, unloadPlugin } = createDependencies({
      activationError: new Error("loader crashed"),
    })
    await pluginDevReload({ ...payload, phase: "prepare" }, deps)
    const result = await pluginDevReload({ ...payload, phase: "activate" }, deps)
    expect(result).toMatchObject({ ok: false, runtimeQuiesced: true, stage: "activate" })
    expect(result.error?.code).toBe("activation_failed")
    expect(unloadPlugin).toHaveBeenCalledTimes(2)
    await pluginDevReload({ ...payload, phase: "rescan" }, deps)
    expect(scanPlugins).toHaveBeenCalledTimes(3)
    expect(enablePlugin).toHaveBeenCalledTimes(1)
  })

  it("retains an uncertain activation for restart when cleanup is dirty", async () => {
    const options: Parameters<typeof createDependencies>[0] = {
      activationError: new Error("loader crashed"),
    }
    const { deps } = createDependencies(options)
    await pluginDevReload({ ...payload, phase: "prepare" }, deps)
    options.afterUnload = baseSnapshot({ actual: "dirty" })
    const result = await pluginDevReload({ ...payload, phase: "activate" }, deps)
    expect(result).toMatchObject({ outcome: "restart_required", runtimeQuiesced: false })
    expect(result.error?.action).toContain("Restart Cognia")
  })

  it("holds package mutation until the restored projection has been rescanned", async () => {
    const { deps } = createDependencies()
    let locked = false
    deps.manager!.withPluginPackageMutation = async (_id, operation) => {
      locked = true
      try {
        return await operation()
      } finally {
        locked = false
      }
    }
    await pluginDevReload({ ...payload, phase: "prepare" }, deps)
    expect(locked).toBe(true)
    deps.manager!.scanPlugins = async () => {
      expect(locked).toBe(true)
      return []
    }
    const result = await pluginDevReload({ ...payload, phase: "rescan" }, deps)
    expect(result.ok).toBe(true)
    expect(locked).toBe(false)
  })

  it("cancels a late prepare before releasing its reservation for another reload", async () => {
    const { deps, unloadPlugin, enablePlugin } = createDependencies()
    const unload = unloadPlugin.getMockImplementation()!
    let finishUnload!: () => void
    const teardown = new Promise<void>((resolve) => {
      finishUnload = resolve
    })
    let started!: () => void
    const unloading = new Promise<void>((resolve) => {
      started = resolve
    })
    unloadPlugin.mockImplementationOnce(async () => {
      started()
      await teardown
      await unload()
    })
    const prepare = pluginDevReload({ ...payload, phase: "prepare" }, deps)
    await unloading
    const rescan = pluginDevReload({ ...payload, phase: "rescan" }, deps)
    finishUnload()
    expect((await prepare).ok).toBe(false)
    expect((await rescan).ok).toBe(true)
    expect(enablePlugin).not.toHaveBeenCalled()
    expect((await pluginDevReload({ ...payload, phase: "prepare" }, deps)).ok).toBe(true)
    await pluginDevReload({ ...payload, phase: "rescan" }, deps)
  })

  it("admits a first install using the staged type without inventing a live runtime", async () => {
    const { deps } = createDependencies({ pluginMissing: true })
    deps.manager!.getPluginLifecycleSnapshots = () => []
    const request = { ...payload, pluginType: "frontend" as const }
    const result = await pluginDevReload({ ...request, phase: "prepare" }, deps)
    expect(result).toMatchObject({
      ok: true,
      runtimeQuiesced: true,
      quiescenceProof: { previousGeneration: 0, generation: 0 },
    })
    await pluginDevReload({ ...request, phase: "rescan" }, deps)
  })

  it.each([
    { developerMode: false, code: "developer_mode_required" },
    { pluginType: "unknown-runtime", code: "unsupported_runtime" },
    { before: baseSnapshot({ actual: "dirty" }), code: "runtime_dirty" },
  ])("rejects admission before unloading: $code", async ({ code, ...options }) => {
    const { deps, unloadPlugin } = createDependencies(options)
    const result = await pluginDevReload({ ...payload, phase: "prepare" }, deps)
    expect(result.error?.code).toBe(code)
    expect(unloadPlugin).not.toHaveBeenCalled()
  })

  test.each(["frontend", "python", "hybrid", "wasm", "vscode-extension"] as const)(
    "reports controlled Desktop reload capability for %s plugins",
    (pluginType) => {
      expect(resolvePluginDevCapability(pluginType, { desktop: true, dirty: false })).toEqual({
        reloadMode: "hot",
        logMode: "structured",
      })
    }
  )

  it("makes host and dirty runtime limits explicit", () => {
    expect(resolvePluginDevCapability("frontend", { desktop: false, dirty: false })).toEqual(
      expect.objectContaining({ reloadMode: "unsupported", reasonCode: "desktop_required" })
    )
    expect(resolvePluginDevCapability("python", { desktop: true, dirty: true })).toEqual(
      expect.objectContaining({ reloadMode: "restart-required", reasonCode: "runtime_dirty" })
    )
  })

  it("reloads an active plugin and returns a generation-backed activation proof", async () => {
    const { deps, reloadPlugin, enablePlugin } = createDependencies()

    await expect(pluginDevReload(payload, deps)).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        outcome: "activated",
        stage: "verify",
        pluginId: "demo.plugin",
        pluginType: "frontend",
        activationProof: {
          previousGeneration: 3,
          generation: 4,
          actualState: "active",
          packageVersion: "1.2.3",
          artifactRevision: "sha256:abc123",
          reloadMode: "hot",
        },
      })
    )
    expect(reloadPlugin).toHaveBeenCalledWith("demo.plugin", "cli-dev")
    expect(enablePlugin).not.toHaveBeenCalled()
  })

  it("does not treat discovery alone as a successful reload", async () => {
    const { deps } = createDependencies({ after: baseSnapshot({ generation: 3 }) })

    const result = await pluginDevReload(payload, deps)

    expect(result.ok).toBe(false)
    expect(result.outcome).toBe("failed")
    expect(result.error?.code).toBe("activation_timeout")
    expect(result.activationProof).toBeUndefined()
  })

  it("waits for a lifecycle transition that stabilizes after activation returns", async () => {
    const { deps } = createDependencies({ delayedAfter: baseSnapshot({ generation: 4 }) })

    const result = await pluginDevReload(payload, deps)

    expect(result.ok).toBe(true)
    expect(result.activationProof?.generation).toBe(4)
  })

  it("enables an inactive plugin when the dev request explicitly activates it", async () => {
    const { deps, reloadPlugin, enablePlugin } = createDependencies({ status: "disabled" })

    const result = await pluginDevReload(payload, deps)

    expect(result.ok).toBe(true)
    expect(enablePlugin).toHaveBeenCalledWith("demo.plugin", "cli-dev")
    expect(reloadPlugin).not.toHaveBeenCalled()
  })

  it("returns restart_required for an unresolved dirty runtime", async () => {
    const dirty = baseSnapshot({
      actual: "dirty",
      dirty: {
        runtime: "frontend",
        reason: "timeout",
        at: 1,
        message: "worker did not stop",
        labels: ["worker"],
      },
    })
    const { deps, reloadPlugin, enablePlugin } = createDependencies({ before: dirty })

    const result = await pluginDevReload(payload, deps)

    expect(result.ok).toBe(false)
    expect(result.outcome).toBe("restart_required")
    expect(result.error?.code).toBe("runtime_dirty")
    expect(reloadPlugin).not.toHaveBeenCalled()
    expect(enablePlugin).not.toHaveBeenCalled()
  })

  it("fails closed when global developer mode is disabled", async () => {
    const { deps, scanPlugins } = createDependencies({ developerMode: false })

    const result = await pluginDevReload(payload, deps)

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("developer_mode_required")
    expect(scanPlugins).not.toHaveBeenCalled()
  })

  it("returns a retriable error while the desktop runtime manager is starting", async () => {
    const { deps } = createDependencies()
    deps.manager = null

    const result = await pluginDevReload(payload, deps)

    expect(result.error).toEqual(
      expect.objectContaining({ code: "runtime_manager_unavailable", retriable: true })
    )
  })

  it("reports discovery failures for missing, stale, and unsupported installs", async () => {
    const scanFailure = await pluginDevReload(
      payload,
      createDependencies({ scanError: new Error("manifest index unavailable") }).deps
    )
    expect(scanFailure.error).toEqual(
      expect.objectContaining({ code: "discovery_failed", message: "manifest index unavailable" })
    )

    const missing = await pluginDevReload(payload, createDependencies({ pluginMissing: true }).deps)
    expect(missing.error?.code).toBe("plugin_not_found")

    const stale = await pluginDevReload(payload, createDependencies({ version: "1.2.2" }).deps)
    expect(stale.error?.code).toBe("plugin_version_mismatch")

    const unsupported = await pluginDevReload(
      payload,
      createDependencies({ pluginType: "unknown-runtime" }).deps
    )
    expect(unsupported.error?.code).toBe("unsupported_runtime")
    expect(unsupported.error?.retriable).toBe(false)
  })

  it("refuses to enable an inactive plugin unless activation is explicit", async () => {
    const { deps, enablePlugin } = createDependencies({ status: "installed" })

    const result = await pluginDevReload({ ...payload, activate: false }, deps)

    expect(result.error?.code).toBe("activation_not_requested")
    expect(enablePlugin).not.toHaveBeenCalled()
  })

  it("returns structured activation and runtime errors", async () => {
    const activationFailure = await pluginDevReload(
      payload,
      createDependencies({ activationError: new Error("loader crashed") }).deps
    )
    expect(activationFailure).toEqual(
      expect.objectContaining({
        ok: false,
        stage: "activate",
        error: expect.objectContaining({ code: "activation_failed", message: "loader crashed" }),
      })
    )

    const dirty = baseSnapshot({
      actual: "dirty",
      dirty: {
        runtime: "frontend",
        reason: "error",
        at: 2,
        message: "worker survived unload",
        labels: ["worker"],
      },
    })
    const dirtyFailure = await pluginDevReload(
      payload,
      createDependencies({
        activationError: new Error("unload failed"),
        dirtyOnActivationError: dirty,
      }).deps
    )
    expect(dirtyFailure).toEqual(
      expect.objectContaining({
        outcome: "restart_required",
        stage: "quiesce",
        error: expect.objectContaining({
          code: "runtime_dirty",
          message: "worker survived unload",
        }),
      })
    )

    const runtimeFailure = await pluginDevReload(
      payload,
      createDependencies({
        after: baseSnapshot({ actual: "error", lastError: "entrypoint rejected" }),
      }).deps
    )
    expect(runtimeFailure.error).toEqual(
      expect.objectContaining({ code: "activation_failed", message: "entrypoint rejected" })
    )
  })

  it("normalizes non-Error loader failures and accepts a host payload without a version hint", async () => {
    const activationFailure = await pluginDevReload(
      { ...payload, packageVersion: undefined },
      createDependencies({ activationError: "loader rejected" }).deps
    )

    expect(activationFailure.error).toEqual(
      expect.objectContaining({ code: "activation_failed", message: "loader rejected" })
    )
  })

  it("makes a non-desktop host unsupported before discovery", async () => {
    const { deps, scanPlugins } = createDependencies()
    deps.isDesktop = () => false

    const result = await pluginDevReload(payload, deps)

    expect(result.error?.code).toBe("unsupported_runtime")
    expect(result.error?.retriable).toBe(false)
    expect(scanPlugins).not.toHaveBeenCalled()
  })

  it("fails closed with the production host dependencies outside Tauri", async () => {
    const result = await pluginDevReload(payload)

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "unsupported_runtime" }),
      })
    )
  })

  it("uses the production manager, store, and sleep adapter on Desktop", async () => {
    mockProductionIsTauri.mockReturnValue(true)
    mockProductionPlugins["demo.plugin"] = {
      status: "enabled",
      manifest: { id: "demo.plugin", version: "1.2.3", type: "frontend" },
    }
    const before = baseSnapshot()
    const after = baseSnapshot({ generation: 4 })
    mockProductionSnapshots = [before]
    mockProductionManager.reloadPlugin.mockImplementation(async () => {
      setTimeout(() => {
        mockProductionSnapshots = [after]
      }, 1)
    })

    const result = await pluginDevReload(payload)

    expect(result.ok).toBe(true)
    expect(mockProductionManager.scanPlugins).toHaveBeenCalled()
    expect(mockProductionManager.reloadPlugin).toHaveBeenCalledWith("demo.plugin", "cli-dev")
  })
})
