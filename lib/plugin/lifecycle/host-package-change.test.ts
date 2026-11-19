/** @jest-environment node */

import { HOST_PACKAGE_CHANGE_COMMANDS, transportCommandTimeoutMs } from "@/lib/tauri/transport-types"

import { contractViolations, scenariosFor } from "./contract"
import {
  __resetExpectedRuntimeEventsForTests,
  applyHostPackageChange,
  expectRuntimeEvent,
  HOST_PACKAGE_COMMANDS,
  isHostPackageCommand,
  takeExpectedRuntimeEvent,
  type HostPackageChangeDeps,
} from "./host-package-change"
import { runtimeResumeStateOf, type RuntimeResumeState } from "./runtime-state"

type Status = "installed" | "loaded" | "enabled" | "disabled" | "suspended"

const TX = "8f14e45f-ceea-467a-9575-7d1d1a1b2c3d"

/**
 * A Host whose disk, records and runtime move the way the real ones do: the
 * native commit swaps the version on disk, registration copies it into the
 * records, and lifecycle calls move the status.
 */
function host(
  options: {
    status?: Status
    intent?: "auto" | "enabled" | "disabled"
    disk?: string
    staged?: string
  } = {}
) {
  const world = {
    status: options.status as Status | undefined,
    disk: options.disk ?? "1.0.0",
    recorded: options.status === undefined ? undefined : (options.disk ?? "1.0.0"),
    staged: options.staged ?? "2.0.0",
    events: [] as string[],
  }
  const native = jest.fn(async (command: string, args: Record<string, unknown>): Promise<unknown> => {
    world.events.push(`native:${command}`)
    switch (command) {
      case "plugin_commit_staged_update":
        if (args.expectedVersion !== world.staged) {
          throw new Error(
            `staged update is v${world.staged}, not the reviewed v${String(args.expectedVersion)}`
          )
        }
        world.disk = world.staged
        return { pluginId: args.pluginId, version: world.disk }
      case "plugin_backup_restore":
      case "plugin_install":
        world.disk = world.staged
        return null
      case "plugin_install_from_github":
        return {
          manifest: { id: "demo", version: world.staged },
          transactionId: TX,
          repo: args.repo,
        }
      default:
        return null
    }
  })
  const manager = {
    getPlugin: jest.fn(() => (world.status === undefined ? undefined : { status: world.status })),
    getPluginLifecycleState: jest.fn(async () => ({ intent: options.intent ?? "auto" })),
    enablePlugin: jest.fn(async () => {
      world.events.push("enable")
      world.status = "enabled"
    }),
    disablePlugin: jest.fn(async () => {
      world.events.push("disable")
      if (world.status !== undefined) world.status = "disabled"
    }),
    suspendPlugin: jest.fn(async () => {
      world.events.push("suspend")
      world.status = "suspended"
    }),
    loadPlugin: jest.fn(async () => {
      world.events.push("load")
      world.status = "loaded"
    }),
    unloadPlugin: jest.fn(async () => {
      world.events.push("unload")
      if (world.status !== undefined) world.status = "installed"
    }),
    uninstallPlugin: jest.fn(async () => {
      world.events.push("uninstall")
      world.status = undefined
      world.recorded = undefined
    }),
    reservePluginRuntimeGraph: jest.fn(() => ({}) as never),
    releasePluginRuntimeGraph: jest.fn(() => true),
    withPluginPackageMutation: <T>(_id: string, operation: () => Promise<T>): Promise<T> =>
      operation(),
  }
  const register = jest.fn(async () => {
    world.events.push("register")
    world.recorded = world.disk
    if (world.status === undefined) world.status = "installed"
  })
  const deps: HostPackageChangeDeps = {
    manager,
    native: native as HostPackageChangeDeps["native"],
    register,
  }
  return { world, deps, native, manager, register }
}

beforeEach(() => __resetExpectedRuntimeEventsForTests())

describe("the commands it owns", () => {
  it("owns exactly the package mutations the Rust arms hand over", () => {
    expect(HOST_PACKAGE_COMMANDS).toEqual([
      "plugin_install",
      "plugin_install_from_github",
      "plugin_uninstall",
      "plugin_commit_staged_update",
      "plugin_backup_restore",
    ])
    // The transport waits as long as the Host allows for each of them.
    expect([...HOST_PACKAGE_CHANGE_COMMANDS]).toEqual([...HOST_PACKAGE_COMMANDS])
    for (const command of HOST_PACKAGE_COMMANDS) {
      expect(transportCommandTimeoutMs(command)).toBe(330_000)
    }
    expect(isHostPackageCommand("plugin_commit_staged_update")).toBe(true)
    expect(isHostPackageCommand("plugin_set_enabled")).toBe(false)
  })

  it("refuses a malformed request before touching anything", async () => {
    const { deps, native, world } = host({ status: "enabled" })
    await expect(
      applyHostPackageChange(
        "plugin_commit_staged_update",
        { pluginId: "demo", transactionId: TX },
        deps
      )
    ).rejects.toThrow(/^plugin_change_malformed: plugin_commit_staged_update: expectedVersion/)
    expect(native).not.toHaveBeenCalled()
    expect(world.events).toEqual([])
  })

  it("drops the bridge's lease fields before validating", async () => {
    const { deps } = host({ status: "loaded" })
    await expect(
      applyHostPackageChange(
        "plugin_backup_restore",
        { pluginId: "demo", backupId: "b1", adminLease: "lease", callerDeviceId: "phone" },
        deps
      )
    ).resolves.toBeNull()
  })
})

describe("plugin_commit_staged_update", () => {
  it("stops the plugin, commits the reviewed version, registers it and brings it back", async () => {
    const { deps, world } = host({ status: "suspended" })
    await applyHostPackageChange(
      "plugin_commit_staged_update",
      { pluginId: "demo", transactionId: TX, expectedVersion: "2.0.0" },
      deps
    )
    expect(world.events).toEqual([
      "disable",
      "unload",
      "native:plugin_commit_staged_update",
      "register",
      "enable",
      "suspend",
    ])
    expect(world.recorded).toBe("2.0.0")
  })

  it("keeps a disabled plugin stopped", async () => {
    const { deps, world } = host({ status: "disabled", intent: "disabled" })
    await applyHostPackageChange(
      "plugin_commit_staged_update",
      { pluginId: "demo", transactionId: TX, expectedVersion: "2.0.0" },
      deps
    )
    expect(world.events).toEqual(["unload", "native:plugin_commit_staged_update", "register"])
    expect(world.status).toBe("installed")
  })

  it("expects the brain's event for the change it applies, and withdraws it on failure", async () => {
    const ok = host({ status: "enabled" })
    await applyHostPackageChange(
      "plugin_commit_staged_update",
      { pluginId: "demo", transactionId: TX, expectedVersion: "2.0.0" },
      { ...ok.deps, expectRuntimeEvent }
    )
    expect(takeExpectedRuntimeEvent("demo")).toBe(true)

    const refused = host({ status: "enabled", staged: "3.0.0" })
    await expect(
      applyHostPackageChange(
        "plugin_commit_staged_update",
        { pluginId: "demo", transactionId: TX, expectedVersion: "2.0.0" },
        { ...refused.deps, expectRuntimeEvent }
      )
    ).rejects.toThrow("not the reviewed v2.0.0")
    expect(takeExpectedRuntimeEvent("demo")).toBe(false)
  })

  it("keeps the new package and leaves the plugin stopped when it cannot start", async () => {
    const { deps, world, manager } = host({ status: "enabled" })
    manager.enablePlugin.mockImplementationOnce(async () => {
      throw new Error("activation failed")
    })
    await expect(
      applyHostPackageChange(
        "plugin_commit_staged_update",
        { pluginId: "demo", transactionId: TX, expectedVersion: "2.0.0" },
        deps
      )
    ).rejects.toThrow(/^plugin_restart_required: demo: .*activation failed/)
    expect(world.disk).toBe("2.0.0")
    expect(runtimeResumeStateOf(world.status)).toBe("stopped")
  })
})

describe("plugin_install", () => {
  it("refuses a manifest that names another plugin", async () => {
    const { deps, native } = host()
    await expect(
      applyHostPackageChange(
        "plugin_install",
        {
          pluginId: "demo",
          source: "local",
          payload: { manifestJson: JSON.stringify({ id: "other", version: "1.0.0" }) },
        },
        deps
      )
    ).rejects.toThrow("plugin_identity_mismatch: the manifest names other, not demo")
    expect(native).not.toHaveBeenCalled()
  })

  it("starts a new plugin unless its intent is disabled", async () => {
    const request = {
      pluginId: "demo",
      source: "local",
      payload: { manifestJson: JSON.stringify({ id: "demo", version: "2.0.0" }) },
    }
    const fresh = host()
    await applyHostPackageChange("plugin_install", request, fresh.deps)
    expect(fresh.world.events).toEqual(["native:plugin_install", "register", "enable"])

    const off = host({ intent: "disabled" })
    await applyHostPackageChange("plugin_install", request, off.deps)
    expect(off.world.events).toEqual(["native:plugin_install", "register"])
  })
})

describe("plugin_install_from_github", () => {
  it("stages first, so the plugin it turns out to be is stopped before it lands", async () => {
    const { deps, world, native } = host({ status: "enabled" })
    const result = await applyHostPackageChange(
      "plugin_install_from_github",
      { repo: "owner/demo" },
      deps
    )
    expect(world.events).toEqual([
      "native:plugin_install_from_github",
      "disable",
      "unload",
      "native:plugin_commit_staged_update",
      "register",
      "enable",
      "native:plugin_finalize_staged_update",
    ])
    expect(native).toHaveBeenNthCalledWith(1, "plugin_install_from_github", {
      repo: "owner/demo",
      deferCommit: true,
    })
    expect(native).toHaveBeenCalledWith("plugin_commit_staged_update", {
      pluginId: "demo",
      transactionId: TX,
      expectedVersion: "2.0.0",
    })
    expect(result).toMatchObject({ transactionId: null, repo: "owner/demo" })
  })

  it("discards what it staged when the commit is refused", async () => {
    const { deps, native, world } = host({ status: "enabled" })
    native.mockImplementation(async (command: string) => {
      world.events.push(`native:${command}`)
      if (command === "plugin_install_from_github") {
        return { manifest: { id: "demo", version: "2.0.0" }, transactionId: TX }
      }
      if (command === "plugin_commit_staged_update") throw new Error("disk full")
      return null
    })
    await expect(
      applyHostPackageChange("plugin_install_from_github", { repo: "owner/demo" }, deps)
    ).rejects.toThrow("disk full")
    expect(world.events.slice(-2)).toEqual(["enable", "native:plugin_discard_staged_update"])
  })

  it("passes a staging-only request straight through", async () => {
    const { deps, world } = host({ status: "enabled" })
    await applyHostPackageChange(
      "plugin_install_from_github",
      { repo: "owner/demo", deferCommit: true },
      deps
    )
    expect(world.events).toEqual(["native:plugin_install_from_github"])
  })
})

describe("plugin_uninstall", () => {
  it("goes through the manager, which unloads before removing", async () => {
    const { deps, world, native } = host({ status: "enabled" })
    await applyHostPackageChange("plugin_uninstall", { pluginId: "demo" }, deps)
    expect(world.events).toEqual(["uninstall"])
    expect(native).not.toHaveBeenCalled()
  })

  it("removes a package the manager never registered natively", async () => {
    const { deps, world } = host()
    await applyHostPackageChange("plugin_uninstall", { pluginId: "demo" }, deps)
    expect(world.events).toEqual(["native:plugin_uninstall"])
  })
})

describe("ADR-0258 contract: host-package-change", () => {
  const STATUS_OF: Record<RuntimeResumeState, Status> = {
    enabled: "enabled",
    suspended: "suspended",
    loaded: "loaded",
    stopped: "installed",
  }

  it.each(scenariosFor("host-package-change").map((scenario) => [scenario.id, scenario] as const))(
    "%s",
    async (_id, scenario) => {
      const { deps, world, native, manager } = host({
        status: STATUS_OF[scenario.before],
        // The device reviewed v2.0.0; an identity fault stages something else.
        staged: scenario.fault === "identity" ? "2.0.1" : "2.0.0",
      })
      if (scenario.fault === "before-commit") {
        native.mockImplementationOnce(async () => {
          throw new Error("EXDEV")
        })
      }
      if (scenario.fault === "after-commit") {
        manager.enablePlugin.mockImplementationOnce(async () => {
          // The package landed and is registered; starting it fails.
          throw new Error("activation failed")
        })
      }
      let outcome: "succeeded" | "failed" = "succeeded"
      let restartRequired = false
      try {
        await applyHostPackageChange(
          "plugin_commit_staged_update",
          { pluginId: "demo", transactionId: TX, expectedVersion: "2.0.0" },
          deps
        )
      } catch (error) {
        outcome = "failed"
        restartRequired = String(error).includes("plugin_restart_required")
      }
      expect(
        contractViolations(
          scenario,
          { from: "1.0.0", to: "2.0.0" },
          {
            outcome,
            restartRequired,
            packageVersion: world.disk,
            recordedVersion: world.recorded,
            runtime: runtimeResumeStateOf(world.status),
          }
        )
      ).toEqual([])
    }
  )
})
