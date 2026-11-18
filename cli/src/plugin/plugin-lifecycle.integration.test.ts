/**
 * @jest-environment node
 *
 * Headless integration for the `/plugin update` path: drives the controller's
 * REAL default `applyUpdate` seam (staged download + `replaceDiskPlugin`)
 * against a mocked GitHub contents API, a real plugin directory and a real
 * `plugin-origins.json` on a tmpdir — the part unit tests stub out. Verifies
 * the tree is replaced whole, the fingerprint changes when content changes,
 * provenance is persisted, and the runtime returns to the state it was in.
 *
 * The live manager is injected (`host`) because the singleton PluginManager
 * needs the Ink runtime; it records the lifecycle calls it receives.
 */
import os from "node:os"
import path from "node:path"
import nodeFs from "node:fs"
import nodeFsP from "node:fs/promises"

import {
  contractViolations,
  scenariosFor,
  type ReplacementObservation,
  type ReplacementScenario,
} from "@/lib/plugin/lifecycle/contract"
import { runtimeResumeStateOf } from "@/lib/plugin/lifecycle/runtime-state"

import { pluginUpdate } from "../tui/runtime/plugin-controller"
import { recordOrigin, getOrigin } from "./plugin-origins"
import type { HostManager } from "./host"
import type { TuiAction } from "../tui/state/types"
import type { PluginManifest } from "@/types/plugin"

/** A live manager that holds `demo.plugin` at `status` and records calls. */
function recordingHost(home: string, status: string) {
  const events: string[] = []
  const record =
    (name: string) =>
    async (id: string): Promise<void> =>
      void events.push(`${name}:${id}`)
  const host: HostManager & { pluginDir: (id: string) => string | undefined } = {
    registerDiskPlugin: async (manifest: PluginManifest) =>
      void events.push(`register:${manifest.id}@${manifest.version}`),
    loadPlugin: record("load"),
    enablePlugin: record("enable"),
    disablePlugin: record("disable"),
    suspendPlugin: record("suspend"),
    setPluginIntent: async () => undefined,
    unloadPlugin: record("unload"),
    reloadPlugin: record("reload"),
    withPluginPackageMutation: (_id, operation) => operation(),
    reservePluginRuntimeGraph: (id) =>
      ({ managerId: "m", pluginId: id, token: Symbol(id) }) as never,
    releasePluginRuntimeGraph: () => undefined,
    list: () => [
      {
        id: "demo.plugin",
        name: "Demo",
        version: "1.0.0",
        type: "frontend",
        path: path.join(home, ".cognia", "plugins", "demo.plugin"),
        status,
      },
    ],
    pluginDir: () => path.join(home, ".cognia", "plugins", "demo.plugin"),
  }
  return { host, events }
}

type Node = string | Array<{ type: "file" | "dir"; path: string }>

/** Any valid 40-hex sha; the preview pins the install to the resolved commit. */
const HEAD_SHA = "a".repeat(40)

function installFetch(getTree: () => Record<string, Node>): void {
  ;(globalThis as { fetch: unknown }).fetch = jest.fn(async (url: string) => {
    // The preview resolves the requested ref to a commit before reading any
    // contents, so provenance records an immutable sha rather than a branch.
    if (/\/commits\//.test(String(url))) {
      return { status: 200, ok: true, json: async () => ({ sha: HEAD_SHA }) } as unknown as Response
    }
    const m = String(url).match(/contents\/(.*?)(\?|$)/)
    const p = decodeURIComponent(m ? m[1] : "")
    const node = getTree()[p]
    if (node === undefined)
      return { status: 404, ok: false, json: async () => ({}) } as unknown as Response
    if (typeof node === "string") {
      return {
        status: 200,
        ok: true,
        json: async () => ({
          type: "file",
          encoding: "base64",
          content: Buffer.from(node).toString("base64"),
        }),
      } as unknown as Response
    }
    return { status: 200, ok: true, json: async () => node } as unknown as Response
  })
}

const manifestText = (version: string) =>
  JSON.stringify({ id: "demo.plugin", name: "Demo", version, type: "frontend", main: "main.js" })

describe("plugin update — real refetch + origins store", () => {
  const realFetch = globalThis.fetch
  let home: string
  beforeEach(() => {
    home = nodeFs.mkdtempSync(path.join(os.tmpdir(), "cognia-update-"))
  })
  afterEach(async () => {
    ;(globalThis as { fetch: unknown }).fetch = realFetch
    await nodeFsP.rm(home, { recursive: true, force: true })
  })

  it("re-downloads a changed bundle, bumps the version, and persists provenance", async () => {
    // Seed: pretend v1.0.0 was installed earlier (record an origin with a stale fingerprint).
    recordOrigin(home, "demo.plugin", {
      repoRef: "owner/repo",
      version: "1.0.0",
      fingerprint: "stale",
    })

    // Upstream now serves v2.0.0 with new file content.
    const version = "2.0.0"
    installFetch(() => ({
      "plugin.json": manifestText(version),
      "": [
        { type: "file", path: "plugin.json" },
        { type: "file", path: "main.js" },
      ],
      "main.js": `export default { v: "${version}" }`,
    }))

    // v1 on disk carries a file v2 no longer ships.
    const dir = path.join(home, ".cognia", "plugins", "demo.plugin")
    nodeFs.mkdirSync(dir, { recursive: true })
    nodeFs.writeFileSync(path.join(dir, "plugin.json"), manifestText("1.0.0"))
    nodeFs.writeFileSync(path.join(dir, "legacy.js"), "export {}")

    const actions: TuiAction[] = []
    const { host, events } = recordingHost(home, "enabled")
    await pluginUpdate("demo.plugin", {
      roots: [home],
      home,
      dispatch: (a) => actions.push(a),
      host: async () => host,
    })

    // The tree was replaced whole: the new files, nothing left over.
    expect(nodeFs.readdirSync(dir).sort()).toEqual(["main.js", "plugin.json"])
    // Stopped, swapped, re-registered with the new manifest, then re-enabled.
    expect(events).toEqual([
      "disable:demo.plugin",
      "unload:demo.plugin",
      "register:demo.plugin@2.0.0",
      "enable:demo.plugin",
    ])
    // Provenance updated to the new version + a real fingerprint (not "stale").
    const origin = getOrigin(home, "demo.plugin")
    expect(origin?.version).toBe("2.0.0")
    expect(origin?.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    // Notice reports the bump.
    expect((actions[0] as { message: string }).message).toContain("v1.0.0 → v2.0.0")
  })

  it("check-all reports an available update for a stale origin", async () => {
    recordOrigin(home, "demo.plugin", { repoRef: "owner/repo", version: "1.0.0", fingerprint: "x" })
    installFetch(() => ({
      "plugin.json": manifestText("3.0.0"),
      "": [{ type: "file", path: "plugin.json" }],
    }))
    const actions: TuiAction[] = []
    await pluginUpdate("", { roots: [home], home, dispatch: (a) => actions.push(a) })
    expect((actions[0] as { message: string }).message).toMatch(
      /Updates available.*demo\.plugin.*3\.0\.0/
    )
  })
})

describe("lifecycle contract (ADR-0258)", () => {
  const VERSIONS = { from: "1.0.0", to: "2.0.0" }
  const STATUS_OF = {
    enabled: "enabled",
    suspended: "suspended",
    loaded: "loaded",
    stopped: "installed",
  } as const
  const realFetch = globalThis.fetch
  let home: string
  beforeEach(() => {
    home = nodeFs.mkdtempSync(path.join(os.tmpdir(), "cognia-contract-"))
  })
  afterEach(async () => {
    ;(globalThis as { fetch: unknown }).fetch = realFetch
    await nodeFsP.rm(home, { recursive: true, force: true })
  })

  /** A live manager whose status follows the lifecycle calls it receives. */
  function statefulHost(status: string, scenario: ReplacementScenario) {
    let current = status
    const become = (next: string) => async () => void (current = next)
    const host: HostManager = {
      registerDiskPlugin: async () => {
        if (scenario.fault === "after-commit") throw new Error("the new manifest was rejected")
      },
      loadPlugin: become("loaded"),
      enablePlugin: become("enabled"),
      disablePlugin: become("disabled"),
      suspendPlugin: become("suspended"),
      setPluginIntent: async () => undefined,
      unloadPlugin: become("installed"),
      reloadPlugin: async () => undefined,
      withPluginPackageMutation: async (_id, operation) => {
        // The package fence refuses after the runtime was stopped.
        if (scenario.fault === "before-commit") throw new Error("package mutation refused")
        return operation()
      },
      reservePluginRuntimeGraph: (id) =>
        ({ managerId: "m", pluginId: id, token: Symbol(id) }) as never,
      releasePluginRuntimeGraph: () => undefined,
      list: () => [
        {
          id: "demo.plugin",
          name: "Demo",
          version: VERSIONS.from,
          type: "frontend",
          path: path.join(home, ".cognia", "plugins", "demo.plugin"),
          status: current,
        },
      ],
    }
    return { host, status: () => current }
  }

  /** Update an installed v1.0.0 to the v2.0.0 upstream serves, with `scenario`'s fault. */
  async function run(scenario: ReplacementScenario): Promise<ReplacementObservation> {
    const dir = path.join(home, ".cognia", "plugins", "demo.plugin")
    nodeFs.mkdirSync(dir, { recursive: true })
    nodeFs.writeFileSync(path.join(dir, "plugin.json"), manifestText(VERSIONS.from))
    nodeFs.writeFileSync(path.join(dir, "main.js"), "export default {}")
    recordOrigin(home, "demo.plugin", {
      repoRef: "owner/repo",
      version: VERSIONS.from,
      fingerprint: "stale",
    })

    const upstream =
      scenario.fault === "identity"
        ? JSON.stringify({ ...JSON.parse(manifestText(VERSIONS.to)), id: "other.plugin" })
        : manifestText(VERSIONS.to)
    installFetch(() => ({
      "plugin.json": upstream,
      "": [
        { type: "file", path: "plugin.json" },
        { type: "file", path: "main.js" },
      ],
      "main.js": `export default { v: "${VERSIONS.to}" }`,
    }))
    const controller = new AbortController()
    const serve = globalThis.fetch
    ;(globalThis as { fetch: unknown }).fetch = jest.fn(async (url: string) => {
      // Cancelled while the bundle is still downloading.
      if (scenario.fault === "cancel" && /contents\/main\.js/.test(String(url))) controller.abort()
      return serve(url)
    })

    const { host, status } = statefulHost(STATUS_OF[scenario.before], scenario)
    const notices: string[] = []
    await pluginUpdate("demo.plugin", {
      roots: [home],
      home,
      dispatch: (action) => notices.push((action as { message?: string }).message ?? ""),
      host: async () => host,
      signal: controller.signal,
    })

    const notice = notices.join("\n")
    const restartRequired = notice.includes("but restarting it failed")
    const outcome: ReplacementObservation["outcome"] =
      controller.signal.aborted && notices.length === 0
        ? "cancelled"
        : notice.startsWith('Updated "demo.plugin":') && !restartRequired
          ? "succeeded"
          : "failed"
    const manifestPath = path.join(dir, "plugin.json")
    return {
      outcome,
      restartRequired,
      packageVersion: nodeFs.existsSync(manifestPath)
        ? (JSON.parse(nodeFs.readFileSync(manifestPath, "utf8")) as { version: string }).version
        : undefined,
      recordedVersion: getOrigin(home, "demo.plugin")?.version,
      runtime: runtimeResumeStateOf(status()),
    }
  }

  it.each(scenariosFor("cli-update"))("$id", async (scenario) => {
    expect(contractViolations(scenario, VERSIONS, await run(scenario))).toEqual([])
  })
})
