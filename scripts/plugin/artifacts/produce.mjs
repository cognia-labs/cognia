#!/usr/bin/env node
// Produce a plugin artifact set (`scripts/build/plugin-artifact-format.mjs`)
// from plugin source: the browser built-in chunks, their index and pre-boot
// snapshot, the plugin icons, and the installer-staged plugins with their seed
// catalog. The host build consumes the finished set through
// `scripts/build/stage-plugin-artifacts.mjs` and never reads plugin source.
//
//   node scripts/plugin/artifacts/produce.mjs --out <set dir> [--plugins <plugin source dir>]
//
// `--plugins` defaults to `<repo>/plugins`; curation is always the host's
// (`lib/plugin/distribution/`), because which plugins ship is the app's choice.

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  PLUGIN_ARTIFACT_MANIFEST,
  PLUGIN_ARTIFACT_SCHEMA,
} from "../../build/plugin-artifact-format.mjs"
import { writeIfChanged } from "../../build/esbuild-input-cache.mjs"
import { buildBrowserBuiltinPlugins } from "./builtin-chunks.mjs"
import { stageBundledPlugins } from "./desktop-plugins.mjs"
import { execFileSync } from "node:child_process"
import {
  createProductProfile,
  readHostAuthoringIdentity,
  valueSha256,
  sha256,
} from "../../build/plugin-artifact-contract.mjs"
import { readAuthoringKit, verifyInstalledAuthoringPackages } from "../bootstrap-authoring-kit.mjs"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")

function sourceSnapshot(pluginsRoot) {
  const names = execFileSync(
    "git",
    ["-C", pluginsRoot, "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  )
    .split("\0")
    .filter(Boolean)
  const inputs = Object.fromEntries(
    [...new Set(names)].sort().map((name) => {
      const file = path.resolve(pluginsRoot, name)
      if (!file.startsWith(`${pluginsRoot}${path.sep}`))
        throw new Error(`Plugin source path escapes root: ${name}`)
      if (!fs.existsSync(file)) return [name, null]
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`Symlink in plugin source: ${name}`)
      return [
        name,
        {
          sha256: sha256(fs.readFileSync(file)),
          mode: fs.statSync(file).mode & 0o111 ? 0o755 : 0o644,
        },
      ]
    })
  )
  return valueSha256(inputs)
}

/** Every regular file under `directory` as sorted `/`-separated relative paths. */
export function listSetFiles(directory) {
  const files = []
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = path.join(current, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Symlink in plugin artifact set: ${relative}`)
      if (entry.isDirectory()) walk(absolute, relative)
      else if (entry.isFile()) files.push(relative)
      else throw new Error(`Unsupported entry in plugin artifact set: ${relative}`)
    }
  }
  walk(directory, "")
  return files.sort()
}

/**
 * Build the whole set into `outDir`. The manifest is written last and lists
 * every file with its digest, so an interrupted run leaves a set the consumer
 * refuses rather than one it stages half of.
 */
export async function producePluginArtifacts({
  root = repoRoot,
  pluginsRoot,
  outDir,
  bundle,
  buildFrontend,
  profile,
  authoring,
  source,
  kitRoot,
} = {}) {
  if (!outDir) throw new Error("producePluginArtifacts: `outDir` is required")
  root = path.resolve(root)
  outDir = path.resolve(outDir)
  pluginsRoot = path.resolve(pluginsRoot ?? path.join(root, "plugins"))
  if (!fs.existsSync(pluginsRoot))
    throw new Error(`producePluginArtifacts: plugin source directory ${pluginsRoot} does not exist`)
  const initialSources = source ? undefined : sourceSnapshot(pluginsRoot)
  const initialLockfile = source
    ? undefined
    : sha256(fs.readFileSync(path.join(root, "pnpm-lock.yaml")))
  const kit = kitRoot ? readAuthoringKit(path.resolve(kitRoot)) : undefined
  if (kit) verifyInstalledAuthoringPackages(root, kit.manifest)
  fs.mkdirSync(outDir, { recursive: true })
  profile ??= kit?.profile ?? createProductProfile({ root, pluginsRoot })
  authoring ??= kit?.authoring ?? readHostAuthoringIdentity(root)
  const manifestPath = path.join(outDir, PLUGIN_ARTIFACT_MANIFEST)
  // A set being rebuilt is not a valid set until its new manifest lands.
  fs.rmSync(manifestPath, { force: true })

  await buildBrowserBuiltinPlugins({
    root,
    pluginsRoot,
    outDir,
    bundle,
    profile,
    authoring,
    contractCatalog: kit?.contractCatalog,
    styleContract: kit?.styleContract,
    compilerContract: kit?.compilerContract,
    pluginIds: profile.browser.map((entry) => entry.directory),
  })
  await stageBundledPlugins({
    root,
    pluginsRoot,
    profile,
    contractCatalog: kit?.contractCatalog,
    styleContract: kit?.styleContract,
    compilerContract: kit?.compilerContract,
    outDir,
    ...(buildFrontend ? { buildFrontend } : {}),
  })

  const files = {}
  const modes = {}
  for (const relative of listSetFiles(outDir)) {
    if (relative === PLUGIN_ARTIFACT_MANIFEST) continue
    files[relative] = createHash("sha256")
      .update(fs.readFileSync(path.join(outDir, ...relative.split("/"))))
      .digest("hex")
    modes[relative] = fs.statSync(path.join(outDir, relative)).mode & 0o111 ? 0o755 : 0o644
  }
  const index = JSON.parse(
    fs.readFileSync(path.join(outDir, "browser-builtin-assets.json"), "utf8")
  )
  const inventory = fs
    .readdirSync(pluginsRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && fs.existsSync(path.join(pluginsRoot, entry.name, "plugin.json"))
    )
    .map(({ name: directory }) => {
      const base = JSON.parse(
        fs.readFileSync(path.join(pluginsRoot, directory, "plugin.json"), "utf8")
      )
      const packaged = index.entries[base.id]?.manifest ?? base
      return {
        directory,
        id: packaged.id,
        version: packaged.version,
        type: packaged.type,
        manifestSha256: valueSha256(packaged),
      }
    })
    .sort((left, right) => left.directory.localeCompare(right.directory))
  source ??= {
    repository: "cognia-labs/cognia-next",
    revision: execFileSync("git", ["-C", pluginsRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    sourceTreeSha256: initialSources,
    lockfileSha256: initialLockfile,
  }
  if (initialSources && sourceSnapshot(pluginsRoot) !== initialSources)
    throw new Error(
      "Plugin source changed during artifact production; retry from a stable checkout"
    )
  if (
    initialLockfile &&
    sha256(fs.readFileSync(path.join(root, "pnpm-lock.yaml"))) !== initialLockfile
  )
    throw new Error(
      "Plugin lockfile changed during artifact production; retry from a stable checkout"
    )
  const producerFiles = [
    "produce.mjs",
    "builtin-chunks.mjs",
    "desktop-plugins.mjs",
    "../build-frontend-plugins.mjs",
    "../plugin-styles.mjs",
  ].map((file) => new URL(file, import.meta.url))
  const producerSha256 = valueSha256(
    Object.fromEntries(
      producerFiles.map((file) => [
        path.relative(repoRoot, fileURLToPath(file)),
        sha256(fs.readFileSync(file)),
      ])
    )
  )
  const manifest = {
    schema: PLUGIN_ARTIFACT_SCHEMA,
    source,
    authoring,
    profile: { name: profile.name, sha256: valueSha256(profile) },
    inventory,
    toolchain: {
      nodeVersion: process.versions.node,
      packageManager: "pnpm",
      producerVersion: "2",
      producerSha256,
    },
    files,
    modes,
  }
  writeIfChanged(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return { outDir, manifest }
}

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exportProfile = argument("--export-profile")
  if (exportProfile) {
    const profile = createProductProfile({ root: repoRoot })
    fs.mkdirSync(path.dirname(path.resolve(exportProfile)), { recursive: true })
    writeIfChanged(path.resolve(exportProfile), JSON.stringify(profile, null, 2) + "\n")
    console.log(`[plugin-artifacts] exported product profile ${valueSha256(profile)}`)
  } else {
    const outDir = argument("--out")
    if (!outDir) {
      console.error("usage: produce.mjs --out <set dir> [--plugins <plugin source dir>]")
      process.exit(2)
    }
    const pluginsRoot = argument("--plugins")
    const { manifest } = await producePluginArtifacts({
      outDir: path.resolve(outDir),
      ...(argument("--profile")
        ? { profile: JSON.parse(fs.readFileSync(path.resolve(argument("--profile")), "utf8")) }
        : {}),
      ...(argument("--kit") ? { kitRoot: path.resolve(argument("--kit")) } : {}),
      ...(pluginsRoot ? { pluginsRoot: path.resolve(pluginsRoot) } : {}),
    })
    console.log(
      `[plugin-artifacts] produced ${Object.keys(manifest.files).length} file(s) into ${outDir}`
    )
  }
}
