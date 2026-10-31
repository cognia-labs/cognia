#!/usr/bin/env node
/** Record the actual source inputs and test ownership before a plugin migration. */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { moduleReferences, isHostIntegrationTest } from "./check-author-imports.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const INPUTS = [
  "plugins",
  "public/plugins",
  "packages/plugin-sdk",
  "packages/plugin-ui",
  "packages/plugin-contract",
  "packages/github-bot-kit",
  "plugin-sdk",
  "scripts/plugin",
  "scripts/build",
  "lib/plugin",
  "components/plugins",
  "hooks/plugins",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "app/globals.css",
  "src-tauri/wit",
  "src-tauri/tauri.conf.json",
]

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")

export function collectExtractionInventory({ root = ROOT, files, revision, status } = {}) {
  root = path.resolve(root)
  files ??= git(root, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ...INPUTS,
  ])
    .split("\0")
    .filter(Boolean)
  const inputs = {}
  const plugins = []
  const tests = []
  const buildEntrypoints = []
  for (const relative of [...new Set(files)].sort()) {
    const absolute = path.resolve(root, relative)
    if (!absolute.startsWith(`${root}${path.sep}`))
      throw new Error(`Inventory path escapes root: ${relative}`)
    if (!fs.existsSync(absolute)) {
      inputs[relative] = { kind: "deleted" }
      continue
    }
    const stat = fs.lstatSync(absolute)
    if (stat.isSymbolicLink()) {
      inputs[relative] = { kind: "symlink", target: fs.readlinkSync(absolute) }
      continue
    }
    if (!stat.isFile()) continue
    const bytes = fs.readFileSync(absolute)
    inputs[relative] = {
      kind: "file",
      bytes: bytes.length,
      mode: stat.mode & 0o777,
      sha256: digest(bytes),
    }
    if (/^plugins\/[^/]+\/plugin\.json$/.test(relative)) {
      const manifest = JSON.parse(bytes.toString())
      const directory = relative.split("/")[1]
      plugins.push({
        directory,
        id: manifest.id,
        version: manifest.version,
        type: manifest.type,
        manifest: relative,
        nodeRuntime: manifest.nodeRuntime ?? null,
        bundleInclude: manifest.bundle_include ?? [],
        legacyPublicPaths: [
          ...new Set(JSON.stringify(manifest).match(/\/plugins\/[^"\\\s]+/g) ?? []),
        ].sort(),
        publicMirror: `public/plugins/${manifest.id}`,
      })
    }
    if (/^plugins\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relative)) {
      const source = bytes.toString()
      const hostReferences = moduleReferences(source).filter((specifier) =>
        specifier.startsWith("@/")
      )
      const hostIntegration = isHostIntegrationTest(relative, source)
      tests.push({
        path: relative,
        owner: hostIntegration || hostReferences.length ? "host" : "plugin",
        explicitHostIntegration: hostIntegration,
        hostReferences,
      })
    }
    if (/^scripts\/build\/.*\.[cm]?[jt]s$/.test(relative) || relative === "package.json") {
      const lines = bytes.toString().split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        if (
          /stage-plugin-artifacts|stagePluginArtifacts|stageBuiltinPluginAssets|producePluginArtifacts/.test(
            lines[index]
          )
        ) {
          buildEntrypoints.push({ path: relative, line: index + 1, source: lines[index].trim() })
        }
      }
    }
  }
  const ids = new Set()
  for (const plugin of plugins) {
    if (!plugin.id || ids.has(plugin.id))
      throw new Error(`Missing or duplicate plugin id: ${plugin.id}`)
    ids.add(plugin.id)
  }
  return {
    schema: 1,
    revision: revision ?? git(root, ["rev-parse", "HEAD"]).trim(),
    dirtyPaths:
      status ??
      git(root, ["status", "--porcelain", "--", ...INPUTS])
        .trim()
        .split("\n")
        .filter(Boolean),
    sourceTreeSha256: digest(JSON.stringify(inputs)),
    summary: {
      plugins: plugins.length,
      types: Object.fromEntries(
        [...new Set(plugins.map((p) => p.type))]
          .sort()
          .map((type) => [type, plugins.filter((p) => p.type === type).length])
      ),
      testFiles: tests.length,
      hostTestFiles: tests.filter((t) => t.owner === "host").length,
      publicMirrorFiles: Object.keys(inputs).filter((p) => p.startsWith("public/plugins/")).length,
    },
    plugins,
    tests,
    buildEntrypoints,
    inputs,
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputIndex = process.argv.indexOf("--out")
  const output = process.argv[outputIndex + 1]
  if (outputIndex < 0 || !output || output.startsWith("--"))
    throw new Error("Usage: extraction-inventory.mjs --out <file>")
  const inventory = collectExtractionInventory()
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true })
  fs.writeFileSync(output, JSON.stringify(inventory, null, 2) + "\n")
  console.log(
    JSON.stringify({ ...inventory.summary, sourceTreeSha256: inventory.sourceTreeSha256, output })
  )
}
