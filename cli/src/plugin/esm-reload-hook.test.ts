import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  findPluginRoot,
  installPluginReloadHook,
  pluginEntryUrl,
  stampResolvedUrl,
} from "./esm-reload-hook"

let dir: string
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "cognia-esm-reload-")))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function file(rel: string, content: string): Promise<string> {
  const path = join(dir, rel)
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, content)
  return path
}

describe("findPluginRoot", () => {
  it("is the nearest folder with a plugin.json", async () => {
    await file("plugin/plugin.json", "{}")
    const entry = await file("plugin/src/index.ts", "")
    expect(findPluginRoot(entry)).toBe(join(dir, "plugin"))
  })

  it("falls back to the entry's own folder", async () => {
    const entry = await file("loose/index.mjs", "")
    expect(findPluginRoot(entry)).toBe(join(dir, "loose"))
  })
})

describe("stampResolvedUrl", () => {
  async function parent(): Promise<string> {
    await file("plugin/plugin.json", "{}")
    return pluginEntryUrl(await file("plugin/src/index.mjs", ""), 7)
  }

  it("carries the stamp to a module inside the plugin", async () => {
    const child = pathToFileURL(join(dir, "plugin/src/util.mjs")).href
    const stamped = new URL(stampResolvedUrl(child, await parent()))
    expect(stamped.searchParams.get("cognia-plugin-gen")).toBe("7")
    expect(stamped.searchParams.get("cognia-plugin-root")).toBe(join(dir, "plugin"))
  })

  it("leaves modules outside the plugin or under its node_modules alone", async () => {
    const from = await parent()
    for (const rel of [
      "sdk/index.mjs",
      "plugin/node_modules/dep/index.mjs",
      "plugin-sibling/x.mjs",
    ]) {
      const url = pathToFileURL(join(dir, rel)).href
      expect(stampResolvedUrl(url, from)).toBe(url)
    }
    expect(stampResolvedUrl("node:fs", from)).toBe("node:fs")
  })

  it("leaves imports from unstamped modules alone", () => {
    const url = pathToFileURL(join(dir, "plugin/src/util.mjs")).href
    expect(stampResolvedUrl(url, pathToFileURL(join(dir, "plugin/src/index.mjs")).href)).toBe(url)
    expect(stampResolvedUrl(url, undefined)).toBe(url)
  })
})

describe("installPluginReloadHook", () => {
  it("registers once", () => {
    const register = jest.fn()
    installPluginReloadHook(register)
    installPluginReloadHook(register)
    expect(register).toHaveBeenCalledTimes(1)
  })
})

describe("in a real Node process", () => {
  it("re-runs the plugin's own modules on each load, and nothing else", async () => {
    await file("plugin/plugin.json", "{}")
    const entry = await file(
      "plugin/src/index.mjs",
      [
        'import { value } from "./util.mjs"',
        'import { dep } from "dep"',
        'import { shared } from "../../shared/index.mjs"',
        "export default { value, dep, shared }",
      ].join("\n")
    )
    await file("plugin/src/util.mjs", 'export const value = "first"')
    await file(
      "plugin/node_modules/dep/index.mjs",
      "globalThis.depRuns = (globalThis.depRuns ?? 0) + 1\nexport const dep = globalThis.depRuns"
    )
    await file(
      "plugin/node_modules/dep/package.json",
      '{"name":"dep","type":"module","exports":"./index.mjs"}'
    )
    await file(
      "shared/index.mjs",
      "globalThis.sharedRuns = (globalThis.sharedRuns ?? 0) + 1\nexport const shared = globalThis.sharedRuns"
    )
    const hook = pathToFileURL(join(__dirname, "esm-reload-hook.ts")).href
    const script = `
      import { writeFileSync } from "node:fs"
      import { installPluginReloadHook, pluginEntryUrl } from ${JSON.stringify(hook)}
      installPluginReloadHook()
      const entry = ${JSON.stringify(entry)}
      const first = (await import(pluginEntryUrl(entry, 1))).default
      writeFileSync(${JSON.stringify(join(dir, "plugin/src/util.mjs"))}, 'export const value = "second"')
      const second = (await import(pluginEntryUrl(entry, 2))).default
      console.log(JSON.stringify({ first, second }))
    `
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
    })
    expect(run.stderr).not.toMatch(/Error/)
    const result = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}")
    expect(result).toEqual({
      first: { value: "first", dep: 1, shared: 1 },
      // The edited module is fresh; the dependency and the module outside the
      // plugin are the same instances as before.
      second: { value: "second", dep: 1, shared: 1 },
    })
  })
})
