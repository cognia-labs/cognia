/**
 * @jest-environment jsdom
 * @cognia-host-integration-test
 */
import { execFileSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { makeNodeFrontendImporter } from "@/cli/src/plugin/node-importer"
import { PluginLoader } from "@/lib/plugin/core/loader"
import { assertPluginManifestParity } from "@/lib/plugin/core/manifest-parity"
import { validatePluginManifest } from "@/lib/plugin/core/validation"
import type { Plugin } from "@/types/plugin"

describe("Feishu plugin distribution", () => {
  beforeAll(() => {
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import {buildFrontendPlugin,writeFrontendPackage} from "./scripts/plugin/build-frontend-plugins.mjs";for(const directory of ["feishu-auth","feishu-calendar"]){await writeFrontendPackage(await buildFrontendPlugin({directory}),".cache/feishu-calendar-packages")}',
      ],
      { cwd: process.cwd(), stdio: "pipe", timeout: 60_000 }
    )
  }, 65_000)

  it.each(["feishu-auth", "feishu-calendar"])(
    "loads %s from its standalone package with manifest parity",
    async (pluginId) => {
      const pluginPath = path.join(process.cwd(), ".cache/feishu-calendar-packages", pluginId)
      const manifest = JSON.parse(await readFile(path.join(pluginPath, "plugin.json"), "utf8"))
      expect(validatePluginManifest(manifest).errors).toEqual([])
      const loader = new PluginLoader({ frontendImporter: makeNodeFrontendImporter() })
      const definition = await loader.load({
        manifest,
        path: pluginPath,
        source: "local",
        status: "installed",
        config: {},
      } as Plugin)
      expect(() => assertPluginManifestParity(manifest, definition.manifest)).not.toThrow()
      expect(typeof definition.activate).toBe("function")
      if (pluginId === "feishu-calendar") {
        const exports = (await loader.importEntry(
          path.join(pluginPath, manifest.main),
          pluginId,
          pluginPath
        )) as Record<string, unknown>
        for (const action of definition.manifest.integrations ?? []) {
          for (const entry of action.actions) expect(typeof exports[entry.handler]).toBe("function")
        }
      }
      await loader.unload(pluginId)
    }
  )

  it("curates both packages with a satisfiable required dependency", async () => {
    const curated = JSON.parse(
      await readFile("lib/plugin/distribution/browser-builtins.json", "utf8")
    )
    expect(curated).toEqual(expect.arrayContaining(["feishu-auth", "feishu-calendar"]))
    const assets = JSON.parse(
      await readFile("lib/plugin/core/browser-builtin-assets.generated.json", "utf8")
    )
    expect(assets.entries["feishu-calendar"].manifest.dependencies).toEqual({
      "feishu-auth": "^1.0.0",
    })
    expect(assets.entries["feishu-auth"].manifest.authProviders).toContainEqual({
      id: "feishu-user-oauth",
      label: "Feishu user OAuth",
    })
  })
})
