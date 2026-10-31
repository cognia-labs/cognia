/**
 * @jest-environment node
 */
import { spawnSync } from "node:child_process"
import nodeFs from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildSync } from "esbuild"
import {
  pluginStatePath,
  createCliAuthProviderOwnershipStore,
  createCliPluginLifecycleStateAdapter,
  readPluginState,
  readDisabledPlugins,
  setPluginDisabled,
  type PluginStateFs,
} from "./plugin-state"

function memFs(seed: Record<string, string> = {}): PluginStateFs {
  const files = { ...seed }
  return {
    exists: (p) => p in files,
    readText: (p) => files[p],
    writeText: (p, data) => {
      files[p] = data
    },
  }
}

describe("plugin enable/disable state", () => {
  it("returns empty when no file exists", () => {
    expect(readDisabledPlugins("/home", memFs())).toEqual(new Set())
  })

  it("reads the disabled list", () => {
    const fs = memFs({ [pluginStatePath("/home")]: JSON.stringify({ disabled: ["a", "b"] }) })
    expect([...readDisabledPlugins("/home", fs)].sort()).toEqual(["a", "b"])
  })

  it("tolerates corrupt state", () => {
    const fs = memFs({ [pluginStatePath("/home")]: "nope" })
    expect(readDisabledPlugins("/home", fs)).toEqual(new Set())
  })

  it("adds then removes an id, persisting each change", () => {
    const fs = memFs()
    setPluginDisabled("/home", "p1", true, fs)
    expect(readDisabledPlugins("/home", fs).has("p1")).toBe(true)
    setPluginDisabled("/home", "p1", false, fs)
    expect(readDisabledPlugins("/home", fs).has("p1")).toBe(false)
    expect(readPluginState("/home", fs).lifecycle.p1.intent).toBe("enabled")
  })

  it("migrates legacy disabled entries into canonical intent on first read", async () => {
    const fs = memFs({ [pluginStatePath("/home")]: JSON.stringify({ disabled: ["legacy"] }) })
    const adapter = createCliPluginLifecycleStateAdapter("/home", fs)

    await expect(adapter.read("legacy")).resolves.toMatchObject({
      intent: "disabled",
      actual: "inactive",
      revision: 0,
    })
  })

  it("persists monotonic lifecycle revisions and rejects stale transitions", async () => {
    const fs = memFs()
    const adapter = createCliPluginLifecycleStateAdapter("/home", fs)

    const first = await adapter.write("p1", 0, { intent: "disabled", actual: "stopping" })
    await expect(adapter.write("p1", 0, { actual: "active" })).rejects.toThrow(/state changed/i)
    const second = await adapter.write("p1", first.revision, { actual: "inactive" })

    expect(second.revision).toBeGreaterThan(first.revision)
    expect(readDisabledPlugins("/home", fs)).toEqual(new Set(["p1"]))
  })
})

describe("durable auth provider ownership", () => {
  it("protects ownership across Node processes until a CLI uninstall releases it", () => {
    const home = nodeFs.mkdtempSync(path.join(os.tmpdir(), "cognia-auth-processes-"))
    try {
      const { outputFiles } = buildSync({
        stdin: {
          resolveDir: process.cwd(),
          contents: `
            import assert from "node:assert/strict"
            import fs from "node:fs"
            import path from "node:path"
            import { registerAuthenticationProvider, setAuthProviderOwnershipStore } from "./lib/plugin/auth/auth-provider-registry"
            import { createCliAuthProviderOwnershipStore } from "./cli/src/plugin/plugin-state"
            import { uninstallHostPlugin } from "./cli/src/plugin/host"
            async function run() {
              const [home, action] = process.argv.slice(1)
              setAuthProviderOwnershipStore(createCliAuthProviderOwnershipStore(home))
              const provider = {
                id: "acme", label: "Acme", pluginId: action === "claim" ? "owner" : "squatter",
                getSessions: async () => [], removeSession: async () => {},
                createSession: async () => { throw new Error("Not interactive") },
              }
              if (action === "reject") {
                assert.throws(() => registerAuthenticationProvider(provider), /owned by another plugin/)
              } else if (action === "uninstall") {
                const dir = path.join(home, "plugins", "owner")
                fs.mkdirSync(dir, { recursive: true })
                await uninstallHostPlugin("owner", dir, { manager: { unloadPlugin: async () => {} } })
                assert.equal(fs.existsSync(dir), false)
              } else {
                assert.equal(typeof registerAuthenticationProvider(provider), "function")
              }
            }
            run().catch((error) => { console.error(error); process.exitCode = 1 })
          `,
        },
        bundle: true,
        write: false,
        platform: "node",
        format: "cjs",
      })
      for (const action of ["claim", "reject", "uninstall", "reclaim"]) {
        const result = spawnSync(process.execPath, ["-e", outputFiles![0].text, home, action], {
          encoding: "utf8",
          timeout: 10000,
        })
        expect({
          action,
          status: result.status,
          error: result.error,
          stderr: result.stderr,
        }).toEqual({
          action,
          status: 0,
          error: undefined,
          stderr: "",
        })
      }
    } finally {
      nodeFs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("reads legacy state and preserves lifecycle and ownership across independent writers", async () => {
    const fs = memFs({ [pluginStatePath("/home")]: JSON.stringify({ disabled: ["legacy"] }) })
    const first = createCliAuthProviderOwnershipStore("/home", fs)
    expect(first.read()).toBeNull()
    first.write(JSON.stringify([["acme", "owner"]]))

    const restarted = createCliAuthProviderOwnershipStore("/home", fs)
    expect(restarted.read()).toBe(JSON.stringify([["acme", "owner"]]))
    setPluginDisabled("/home", "owner", true, fs)
    const adapter = createCliPluginLifecycleStateAdapter("/home", fs)
    await adapter.write("owner", 1, { actual: "inactive" })
    expect(restarted.read()).toBe(JSON.stringify([["acme", "owner"]]))
    expect(readDisabledPlugins("/home", fs)).toEqual(new Set(["legacy", "owner"]))

    restarted.write("[]")
    expect(first.read()).toBe("[]")
    expect(readPluginState("/home", fs).lifecycle.owner).toMatchObject({
      intent: "disabled",
      actual: "inactive",
      revision: 2,
    })
  })

  it.each(["nope", "null", "[]", "42"])(
    "refuses corrupt state %s without letting lifecycle mutations erase ownership",
    async (raw) => {
      const fs = memFs({ [pluginStatePath("/home")]: raw })
      const owners = createCliAuthProviderOwnershipStore("/home", fs)
      expect(() => owners.read()).toThrow()
      expect(() => owners.write("[]")).toThrow()
      expect(() => setPluginDisabled("/home", "owner", true, fs)).toThrow()
      await expect(
        createCliPluginLifecycleStateAdapter("/home", fs).write("owner", 0, { intent: "disabled" })
      ).rejects.toThrow()
      expect(fs.readText(pluginStatePath("/home"))).toBe(raw)
    }
  )

  it.each([null, 42, [], {}])("rejects an invalid ownership payload %j", (authProviderOwners) => {
    const fs = memFs({
      [pluginStatePath("/home")]: JSON.stringify({ authProviderOwners }),
    })
    expect(() => createCliAuthProviderOwnershipStore("/home", fs).read()).toThrow(
      "Auth provider ownership storage is invalid"
    )
  })

  it("propagates read and write failures instead of falling back to memory", () => {
    const fs = memFs()
    const readError = new Error("Read denied")
    const writeError = new Error("Disk full")
    const read = createCliAuthProviderOwnershipStore("/home", {
      ...fs,
      exists: () => true,
      readText: () => {
        throw readError
      },
    })
    expect(() => read.read()).toThrow(readError)
    const write = createCliAuthProviderOwnershipStore("/home", {
      ...fs,
      writeText: () => {
        throw writeError
      },
    })
    expect(() => write.write("[]")).toThrow(writeError)
    expect(fs.exists(pluginStatePath("/home"))).toBe(false)
  })
})
