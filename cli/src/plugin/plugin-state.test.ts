/**
 * @jest-environment node
 */
import { spawn, spawnSync } from "node:child_process"
import nodeFs from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildSync } from "esbuild"
import { fileLockPath, FileLockLostError, withCliFileLockSync } from "./file-lock"
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
    rename: (from, to) => {
      files[to] = files[from]
      delete files[from]
    },
    remove: (p) => {
      delete files[p]
    },
    withLock: (_home, task) => task(() => {}),
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
  it("fences a plugin-state writer replaced before its atomic rename", () => {
    const home = nodeFs.mkdtempSync(path.join(os.tmpdir(), "cognia-plugin-fence-"))
    const original = JSON.stringify({ disabled: ["legacy"] })
    const fs = memFs({ [pluginStatePath(home)]: original })
    try {
      expect(() =>
        setPluginDisabled(home, "late", true, {
          ...fs,
          withLock: (home, task) => withCliFileLockSync(home, "plugin-state", task, "plugin-state"),
          writeText: (file, data) => {
            fs.writeText(file, data)
            nodeFs.writeFileSync(
              fileLockPath(home, "plugin-state", "plugin-state"),
              JSON.stringify({ pid: process.pid, timestamp: Date.now(), token: "replacement" })
            )
          },
        })
      ).toThrow(FileLockLostError)
      expect(fs.readText(pluginStatePath(home))).toBe(original)
    } finally {
      nodeFs.rmSync(home, { recursive: true, force: true })
    }
  })
  it("does not lose lifecycle, disabled, or ownership updates from concurrent Node writers", async () => {
    const home = nodeFs.mkdtempSync(path.join(os.tmpdir(), "cognia-plugin-writers-"))
    try {
      const { outputFiles } = buildSync({
        stdin: {
          resolveDir: process.cwd(),
          contents: `
          import fs from "node:fs"
          import path from "node:path"
          import { claimAuthProviderOwnership, setAuthProviderOwnershipStore } from "./lib/plugin/auth/auth-provider-registry"
          import { setPluginDisabled, createCliAuthProviderOwnershipStore, createCliPluginLifecycleStateAdapter } from "./cli/src/plugin/plugin-state"
          async function run() {
            const [home, writer] = process.argv.slice(2)
            setAuthProviderOwnershipStore(createCliAuthProviderOwnershipStore(home))
            fs.writeFileSync(path.join(home, "ready-" + writer), "")
            while (!fs.existsSync(path.join(home, "go"))) await new Promise(r => setTimeout(r, 2))
            for (let i = 0; i < 20; i++) {
              if (writer.startsWith("owners")) claimAuthProviderOwnership(writer + "-" + i, writer)
              else if (writer === "lifecycle") await createCliPluginLifecycleStateAdapter(home).write("worker", i, { actual: "inactive" })
              else setPluginDisabled(home, writer + "-" + i, true)
            }
          }
          run().catch(error => { console.error(error); process.exitCode = 1 })
        `,
        },
        bundle: true,
        write: false,
        platform: "node",
        format: "cjs",
      })
      const writers = ["a", "b", "owners-a", "owners-b", "lifecycle"]
      const script = path.join(home, "writers-child.cjs")
      nodeFs.writeFileSync(script, outputFiles![0].text)
      const children = writers.map((writer) =>
        spawn(process.execPath, [script, home, writer], {
          stdio: ["ignore", "ignore", "pipe"],
        })
      )
      const results = children.map(
        (child) =>
          new Promise<void>((resolve, reject) => {
            let stderr = ""
            child.stderr!.on("data", (chunk) => {
              stderr += String(chunk)
            })
            const timer = setTimeout(() => {
              child.kill()
              reject(new Error("Concurrent writer timed out"))
            }, 10_000)
            child.once("error", (error) => {
              clearTimeout(timer)
              reject(error)
            })
            child.once("exit", (code) => {
              clearTimeout(timer)
              if (code === 0) resolve()
              else reject(new Error(`Writer failed (${code}): ${stderr}`))
            })
          })
      )
      const completion = Promise.all(results)
      try {
        const deadline = Date.now() + 5000
        while (!writers.every((writer) => nodeFs.existsSync(path.join(home, "ready-" + writer)))) {
          if (Date.now() > deadline) throw new Error("Writers failed to start")
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        nodeFs.writeFileSync(path.join(home, "go"), "")
        await completion
      } finally {
        children.forEach((child) => child.kill())
        await Promise.allSettled(results)
      }
      const document = readPluginState(home)
      expect(document.disabled).toEqual(
        writers
          .slice(0, 2)
          .flatMap((writer) => Array.from({ length: 20 }, (_, i) => `${writer}-${i}`))
          .sort()
      )
      expect(document.lifecycle.worker.revision).toBe(20)
      expect(JSON.parse(document.authProviderOwners!).sort()).toEqual(
        ["owners-a", "owners-b"]
          .flatMap((writer) => Array.from({ length: 20 }, (_, i) => [`${writer}-${i}`, writer]))
          .sort()
      )
      expect(nodeFs.readdirSync(home).filter((file) => file.endsWith(".tmp"))).toEqual([])
    } finally {
      nodeFs.rmSync(home, { recursive: true, force: true })
    }
  }, 15000)

  it("retains the previous plugin document when atomic replacement fails", () => {
    const original = JSON.stringify({
      version: 2,
      disabled: ["legacy"],
      lifecycle: {},
      authProviderOwners: "[]",
    })
    const fs = memFs({ [pluginStatePath("/home")]: original })
    expect(() =>
      setPluginDisabled("/home", "next", true, {
        ...fs,
        rename: () => {
          throw new Error("crash before rename")
        },
      })
    ).toThrow("crash before rename")
    expect(fs.readText(pluginStatePath("/home"))).toBe(original)
  })

  it("protects ownership across Node processes until a CLI uninstall releases it", () => {
    const home = nodeFs.mkdtempSync(path.join(os.tmpdir(), "cognia-auth-processes-"))
    try {
      const { outputFiles } = buildSync({
        stdin: {
          resolveDir: process.cwd(),
          contents: `
            import "fake-indexeddb/auto"
            import assert from "node:assert/strict"
            import fs from "node:fs"
            import path from "node:path"
            import { __enableDbRuntimeForTesting } from "./lib/db/schema"
            import { registerAuthenticationProvider, setAuthProviderOwnershipStore } from "./lib/plugin/auth/auth-provider-registry"
            import { createCliAuthProviderOwnershipStore } from "./cli/src/plugin/plugin-state"
            import { uninstallHostPlugin } from "./cli/src/plugin/host"
            async function run() {
              const [home, action] = process.argv.slice(2)
              __enableDbRuntimeForTesting()
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
      const script = path.join(home, "ownership-child.cjs")
      nodeFs.writeFileSync(script, outputFiles![0].text)
      for (const action of ["claim", "reject", "uninstall", "reclaim"]) {
        const result = spawnSync(process.execPath, [script, home, action], {
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
