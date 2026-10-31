#!/usr/bin/env node
/** First-party distribution builder. Author code is evaluated for metadata, never activated. */
import {
  readFile,
  readdir,
  lstat,
  realpath,
  mkdir,
  mkdtemp,
  rename,
  rm,
  chmod,
} from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { execFileSync } from "node:child_process"
import { build } from "esbuild"
import { createPluginCompilerContract } from "../build/plugin-compiler-contract.mjs"
import { compilePluginUtilityCss, createPluginStyleContract } from "./plugin-styles.mjs"
import { register } from "tsx/cjs/api"
import JSZip from "jszip"
import {
  writeIfChanged,
  readBuildCache,
  isBuildCacheFresh,
  saveBuildCache,
} from "../build/esbuild-input-cache.mjs"

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
export const NODE_RUNTIME_SOURCE_MAX_BYTES = 1024 * 1024
register()
const authoringPreparations = new Map()

async function prepareAuthoringHelpers(root) {
  const owner = path.join(root, "packages/github-bot-kit")
  if (!(await exists(path.join(owner, "tsup.config.ts")))) return
  if (authoringPreparations.has(root)) return authoringPreparations.get(root)
  const preparation = (async () => {
    const collect = async (directory) =>
      (
        await Promise.all(
          (await readdir(directory, { withFileTypes: true })).map((entry) =>
            entry.isDirectory()
              ? collect(path.join(directory, entry.name))
              : [path.join(directory, entry.name)]
          )
        )
      ).flat()
    const inputs = (await collect(path.join(owner, "src"))).filter((file) => !/\.test\./.test(file))
    const cacheFile = path.join(root, ".cache/plugin-toolchain/github-bot-kit.json")
    const key = JSON.stringify({
      build: JSON.parse(await readFile(path.join(owner, "package.json"), "utf8")).scripts.build,
    })
    const required = [
      "index.js",
      "index.cjs",
      "index.d.ts",
      "testing.js",
      "testing.cjs",
      "testing.d.ts",
    ].map((file) => path.join(owner, "dist", file))
    if (isBuildCacheFresh(readBuildCache(cacheFile), root, key, required)) return
    const startedAt = performance.timeOrigin + performance.now()
    execFileSync("pnpm", ["--dir", owner, "run", "build"], { cwd: root, stdio: "inherit" })
    saveBuildCache(cacheFile, {
      root,
      key,
      inputs,
      extraFiles: [path.join(owner, "tsup.config.ts"), path.join(owner, "package.json")],
      outputs: await collect(path.join(owner, "dist")),
      startedAt,
    })
  })()
  authoringPreparations.set(root, preparation)
  try {
    return await preparation
  } finally {
    authoringPreparations.delete(root)
  }
}
export const SHARED_MODULES = [
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "@cognia/plugin-sdk",
  "@cognia/plugin-ui",
  "lucide-react",
]

function relativePath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    /^(?:[a-z]+:|[\\/])/i.test(value) ||
    value.replaceAll("\\", "/").split("/").includes("..")
  )
    throw new Error(`Unsafe plugin path: ${value}`)
  return value.replaceAll("\\", "/").replace(/^\.\//, "")
}

function validateIdentity(manifest) {
  if (
    !/^[a-z0-9][a-z0-9._-]*$/.test(manifest.id ?? "") ||
    !/^[0-9][a-zA-Z0-9.+_-]*$/.test(manifest.version ?? "")
  ) {
    throw new Error("Invalid plugin id or version for distribution")
  }
}

function pathValues(object, expression) {
  const [part, ...rest] = expression.split(".")
  if (part === "*") {
    return Object.values(object ?? {}).flatMap((value) =>
      rest.length ? pathValues(value, rest.join(".")) : typeof value === "string" ? [value] : []
    )
  }
  const array = part.endsWith("[]")
  const value = object?.[array ? part.slice(0, -2) : part]
  return (array ? (value ?? []) : [value]).flatMap((item) =>
    rest.length ? pathValues(item, rest.join(".")) : typeof item === "string" ? [item] : []
  )
}

async function exists(file) {
  try {
    await lstat(file)
    return true
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return false
    throw error
  }
}

/** Only declarative provisioning inputs and the declared probe ship; never installed dependencies. */
export async function collectNodeRuntimeSources(pluginRoot, declaration) {
  if (declaration === undefined) return { files: new Map(), inputs: [] }
  if (!declaration || typeof declaration !== "object" || Array.isArray(declaration))
    throw new Error("Invalid nodeRuntime declaration")
  const confined = (value) => {
    const relative = relativePath(value)
    if (
      relative !== value ||
      relative
        .split("/")
        .some(
          (part) =>
            !part ||
            part === "." ||
            [
              "node_modules",
              "tests",
              "test",
              "__tests__",
              ".git",
              ".cache",
              "cache",
              "__pycache__",
              ".venv",
              "venv",
              "target",
              ".pytest_cache",
            ].includes(part)
        )
    )
      throw new Error(`Unsafe nodeRuntime path: ${value}`)
    return relative
  }
  const directory = confined(declaration.directory)
  const entry = confined(declaration.entry)
  if (!/\.(?:mjs|cjs|js)$/.test(entry)) throw new Error("nodeRuntime entry must be JavaScript")
  if (/\.(?:test|spec)\.[cm]?js$/.test(entry)) throw new Error("Unsafe nodeRuntime test entry")
  const files = new Map()
  const inputs = []
  let totalBytes = 0
  for (const relative of new Set([
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    entry,
  ])) {
    const packagedPath = `${directory}/${relative}`
    let source = pluginRoot
    const parts = packagedPath.split("/")
    for (const [index, part] of parts.entries()) {
      source = path.join(source, part)
      const info = await lstat(source)
      if (
        info.isSymbolicLink() ||
        (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())
      )
        throw new Error(`Unsafe nodeRuntime path (symlink or non-file): ${packagedPath}`)
      if (index === parts.length - 1 && info.size > NODE_RUNTIME_SOURCE_MAX_BYTES)
        throw new Error(`nodeRuntime sources exceed ${NODE_RUNTIME_SOURCE_MAX_BYTES} bytes`)
    }
    const realRoot = await realpath(pluginRoot)
    if (!(await realpath(source)).startsWith(`${realRoot}${path.sep}`))
      throw new Error(`Unsafe nodeRuntime path: ${packagedPath}`)
    const bytes = await readFile(source)
    totalBytes += bytes.length
    if (totalBytes > NODE_RUNTIME_SOURCE_MAX_BYTES)
      throw new Error(`nodeRuntime sources exceed ${NODE_RUNTIME_SOURCE_MAX_BYTES} bytes`)
    files.set(packagedPath, bytes)
    inputs.push(source)
  }
  return { files, inputs }
}

async function sourceEntry(pluginRoot, manifest) {
  const candidates = [
    manifest.tsEntry,
    /\.[cm]?[jt]sx?$/.test(manifest.main ?? "") && !manifest.main.startsWith("dist/")
      ? manifest.main
      : undefined,
    "src/index.ts",
    "src/index.tsx",
    "src/main.ts",
    manifest.main,
  ].filter(Boolean)
  for (const candidate of candidates) {
    const source = path.join(pluginRoot, relativePath(candidate))
    if (await exists(source)) return source
  }
  throw new Error(`No frontend source entry in ${pluginRoot}`)
}

/**
 * Build one frontend plugin package. `root` is the toolchain root (esbuild's
 * working directory, `node_modules`, the SDK contract catalog and the
 * style compiler); `pluginsRoot` is where plugin sources and resources live,
 * `<root>/plugins` by default.
 */
export async function buildFrontendPlugin({
  root = repository,
  pluginsRoot,
  directory,
  bundle = build,
  pdfWorkerUrl,
  moduleManifest,
  contractCatalog,
  styleContract,
  compilerContract,
} = {}) {
  const catalog =
    contractCatalog ??
    JSON.parse(
      await readFile(
        path.join(repository, "packages/plugin-contract/contract/catalog.json"),
        "utf8"
      )
    )
  const compiler = compilerContract ?? createPluginCompilerContract(repository)
  if (
    compiler.schema !== 1 ||
    compiler.target !== "es2022" ||
    typeof compiler.compilerOptions?.useDefineForClassFields !== "boolean"
  )
    throw new Error("A valid plugin compiler contract is required")
  root = path.resolve(root)
  await prepareAuthoringHelpers(root)
  const pluginRoot = path.join(
    path.resolve(pluginsRoot ?? path.join(root, "plugins")),
    relativePath(directory)
  )
  const base = JSON.parse(await readFile(path.join(pluginRoot, "plugin.json"), "utf8"))
  validateIdentity(base)
  const source = await sourceEntry(pluginRoot, base)
  let scope = path.dirname(source),
    sourcePackageType = "commonjs"
  while (true) {
    if (await exists(path.join(scope, "package.json"))) {
      sourcePackageType =
        JSON.parse(await readFile(path.join(scope, "package.json"), "utf8")).type ?? "commonjs"
      break
    }
    if (path.dirname(scope) === scope) break
    scope = path.dirname(scope)
  }
  if (
    sourcePackageType !== compiler.packageType &&
    scope !== pluginRoot &&
    !scope.startsWith(`${pluginRoot}${path.sep}`)
  )
    throw new Error(
      `Plugin source package type differs from the pinned compiler contract (${directory}: ${sourcePackageType} != ${compiler.packageType}); preserve its CommonJS/ESM interop mode`
    )
  let moduleStyles
  const metadataInputs = []
  if (!moduleManifest) {
    // Evaluate the same class-field/JSX semantics as the release. Bare package
    // imports use the real SDK/helpers; activation is never run.
    const metadata = await build({
      absWorkingDir: root,
      entryPoints: [source],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: compiler.target,
      tsconfigRaw: { compilerOptions: compiler.compilerOptions },
      packages: "external",
      write: false,
      metafile: true,
      loader: { ".css": "empty" },
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      plugins: [
        {
          name: "reject-private-metadata-imports",
          setup(api) {
            // The helper is inlined in the release too. Bundle it afresh here
            // so a long-lived builder cannot reuse stale Node module exports.
            api.onResolve({ filter: /^@cognia\/github-bot-kit(?:\/|$)/ }, (args) => ({
              path: createRequire(path.join(root, "package.json")).resolve(args.path),
            }))
            api.onResolve({ filter: /^@\// }, (args) => ({
              errors: [
                { text: `Plugin imports host-private module ${args.path}; use the public SDK.` },
              ],
            }))
          },
        },
      ],
    })
    metadataInputs.push(
      ...Object.keys(metadata.metafile.inputs).map((file) => path.resolve(root, file))
    )
    const sourceRequire = createRequire(source),
      toolRequire = createRequire(path.join(root, "package.json"))
    const metadataRequire = (specifier) => {
      if (/^@cognia\/(?:plugin-sdk|plugin-ui|github-bot-kit)(?:\/|$)/.test(specifier))
        return toolRequire(specifier)
      let resolved
      try {
        resolved = sourceRequire.resolve(specifier)
      } catch (error) {
        if (error.code !== "MODULE_NOT_FOUND") throw error
        return toolRequire(specifier)
      }
      return sourceRequire(resolved)
    }
    const metadataModule = { exports: {} }
    new Function(
      "module",
      "exports",
      "require",
      "__filename",
      "__dirname",
      metadata.outputFiles[0].text
    )(metadataModule, metadataModule.exports, metadataRequire, source, path.dirname(source))
    const imported = metadataModule.exports
    const definition = imported.default?.default ?? imported.default ?? imported.plugin ?? imported
    moduleManifest = definition.manifest ?? imported.manifest ?? base
    moduleStyles = imported.styles
  }
  if (moduleManifest.id !== base.id) throw new Error(`Plugin identity mismatch in ${directory}`)
  const manifest = JSON.parse(JSON.stringify({ ...base, ...moduleManifest, id: base.id }))
  validateIdentity(manifest)
  const originalManifest = structuredClone(manifest)
  const files = new Map()
  const fileModes = new Map()
  const inputs = new Set([
    pluginRoot,
    path.join(pluginRoot, "plugin.json"),
    source,
    ...metadataInputs,
  ])
  for (const input of [
    ...(compiler.inputs ?? []),
    fileURLToPath(new URL("../build/plugin-compiler-contract.mjs", import.meta.url)),
  ])
    inputs.add(input)
  const sourceMapFile = path.join(pluginRoot, "build-entries.json")
  const sourceEntries = (await exists(sourceMapFile))
    ? JSON.parse(await readFile(sourceMapFile, "utf8"))
    : {}
  if (!sourceEntries || typeof sourceEntries !== "object" || Array.isArray(sourceEntries))
    throw new Error("Invalid plugin build entry map")
  if (await exists(sourceMapFile)) inputs.add(sourceMapFile)
  for (const [output, entry] of Object.entries(sourceEntries)) {
    relativePath(output)
    relativePath(entry)
    if (!output.startsWith("dist/") || !/\.[cm]?js$/.test(output) || !/\.[cm]?[jt]sx?$/.test(entry))
      throw new Error("Invalid plugin build entry map")
  }
  const nodeRuntime = await collectNodeRuntimeSources(pluginRoot, manifest.nodeRuntime)
  for (const [relative, bytes] of nodeRuntime.files) files.set(relative, bytes)
  for (const input of nodeRuntime.inputs) inputs.add(input)
  const mapping = {
    [manifest.main]: "dist/index.js",
    [path.relative(pluginRoot, source).replaceAll(path.sep, "/")]: "dist/index.js",
  }
  const entries = new Map([[source, "dist/index.js"]])
  const libraryEntries = new Set(pathValues(manifest, "library.modules.*.entry"))
  for (const contract of catalog.pathFields.filter((field) => field.runtime === "javascript")) {
    if (contract.path.startsWith("nodeRuntime.")) continue
    for (const value of pathValues(manifest, contract.path)) {
      if (contract.sentinels?.includes(value)) continue
      const relative = relativePath(value)
      if (mapping[value]) continue
      if (sourceEntries[value]) {
        mapping[value] = value
        entries.set(path.join(pluginRoot, sourceEntries[value]), value)
        continue
      }
      const extension = libraryEntries.has(value) ? "cjs" : "js"
      const output = `dist/entries/${relative.replace(/\.[cm]?[jt]sx?$/, "")}.${extension}`
      mapping[value] = output
      entries.set(path.join(pluginRoot, relative), output)
    }
  }
  function normalize(value) {
    if (typeof value === "string") return mapping[value] ?? value
    if (Array.isArray(value)) return value.map(normalize)
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]))
    return value
  }
  const packaged = normalize(manifest)
  if (manifest.nodeRuntime) packaged.nodeRuntime = structuredClone(manifest.nodeRuntime)
  delete packaged.tsEntry
  if (manifest.styles && typeof moduleStyles === "string")
    files.set(relativePath(manifest.styles), Buffer.from(moduleStyles))
  async function collect(relative, required = true, origin = pluginRoot) {
    relative = relativePath(relative)
    const localState =
      relative
        .split("/")
        .some((part) =>
          [
            "node_modules",
            ".git",
            ".cache",
            ".venv",
            "venv",
            "__pycache__",
            ".pytest_cache",
            "target",
          ].includes(part)
        ) ||
      [
        "vendor/runtime/toolchain",
        "vendor/runtime/render",
        ".latexwb",
        ".latexwb-materialize",
      ].some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`))
    if (localState) {
      if (required) throw new Error(`Plugin shipping path names local-only state: ${relative}`)
      return
    }
    // Even bundle_include or the public mirror cannot bypass the runtime source allowlist.
    if (
      manifest.nodeRuntime &&
      (relative === manifest.nodeRuntime.directory ||
        relative.startsWith(`${manifest.nodeRuntime.directory}/`))
    )
      return
    const sourceFile = path.join(origin, relative)
    if (!(await exists(sourceFile))) {
      if (files.has(relative)) return
      const resources = path.join(pluginRoot, "resources")
      if (origin === pluginRoot && (await exists(path.join(resources, relative))))
        return collect(relative, required, resources)
      if (!required) return
      throw new Error(`Missing plugin resource ${directory}/${relative}`)
    }
    const actual = await realpath(sourceFile)
    const realRoot = await realpath(origin)
    if (!actual.startsWith(`${realRoot}${path.sep}`))
      throw new Error(`Unsafe plugin path: ${relative}`)
    const info = await lstat(sourceFile)
    if (info.isSymbolicLink()) throw new Error(`Unsafe plugin path (symlink): ${relative}`)
    if (info.isDirectory()) {
      inputs.add(sourceFile)
      for (const child of (await readdir(sourceFile)).sort()) {
        const candidate = `${relative}/${child}`
        if (
          [
            "node_modules",
            ".git",
            ".cache",
            ".venv",
            "venv",
            "__pycache__",
            ".pytest_cache",
            "target",
          ].includes(child)
        )
          continue
        if (["vendor/runtime/toolchain", "vendor/runtime/render"].includes(candidate)) continue
        await collect(candidate, true, origin)
      }
    } else {
      inputs.add(sourceFile)
      fileModes.set(relative, info.mode & 0o111 ? 0o755 : 0o644)
      if (!files.has(relative)) files.set(relative, await readFile(sourceFile))
    }
  }
  if (
    manifest.bundle_include !== undefined &&
    (!Array.isArray(manifest.bundle_include) ||
      manifest.bundle_include.some((entry) => typeof entry !== "string"))
  )
    throw new Error("bundle_include must be an array of shipping paths")
  // An explicit allowlist is authoritative. In particular a vendored snapshot
  // must not make provisioned toolchains or other unlisted local state ship.
  if (manifest.bundle_include === undefined)
    for (const name of ["assets", "public", "locales", "skills", "vendor", "pi", "bin"])
      await collect(name, false)
  for (const contract of catalog.pathFields.filter(
    (field) => field.runtime === "asset" && field.kind !== "contained-only"
  )) {
    if (contract.path.startsWith("nodeRuntime.")) continue
    for (const value of pathValues(manifest, contract.path)) await collect(value)
  }
  if (
    manifest.icon &&
    /\.(png|svg|webp|jpe?g|gif|avif)$/i.test(manifest.icon) &&
    !/^(?:[a-z]+:|\/)/i.test(manifest.icon)
  )
    await collect(manifest.icon)
  for (const value of manifest.bundle_include ?? []) await collect(value)
  if (manifest.styles && typeof moduleStyles === "string")
    files.set(relativePath(manifest.styles), Buffer.from(moduleStyles))
  // Resource inputs belong to the plugin even when their runtime path is dist/.
  const resources = path.join(pluginRoot, "resources")
  if (await exists(resources)) inputs.add(resources)
  if (manifest.bundle_include === undefined && (await exists(resources)))
    for (const child of await readdir(resources)) {
      if (["dist", "plugin.json"].includes(child)) continue
      await collect(child, true, resources)
    }
  const define = {}
  if (manifest.id === "cognia-pdf") {
    const workerPath = path.join(root, "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs")
    const worker = await readFile(workerPath)
    inputs.add(workerPath)
    // A data module has no dependency on the app's public directory or install location.
    define.__COGNIA_PDF_WORKER_URL__ = JSON.stringify(
      pdfWorkerUrl ?? `data:text/javascript;base64,${worker.toString("base64")}`
    )
  }
  const shared = new Set()
  const emittedStyles = []
  for (const [entry, output] of entries) {
    const result = await bundle({
      absWorkingDir: root,
      entryPoints: [entry],
      outfile: path.join(pluginRoot, output),
      bundle: true,
      platform: "browser",
      format: "cjs",
      target: compiler.target,
      tsconfigRaw: { compilerOptions: compiler.compilerOptions },
      minify: true,
      sourcemap: false,
      metafile: true,
      write: false,
      define,
      loader: Object.fromEntries(
        [
          ".png",
          ".jpg",
          ".jpeg",
          ".gif",
          ".webp",
          ".svg",
          ".woff",
          ".woff2",
          ".ttf",
          ".otf",
          ".wasm",
        ].map((extension) => [extension, "dataurl"])
      ),
      external: [...SHARED_MODULES, "@cognia/plugin-sdk/*"],
      plugins: [
        {
          name: "reject-host-private-imports",
          setup(api) {
            api.onResolve({ filter: /^@\// }, (args) => ({
              errors: [
                { text: `Plugin imports host-private module ${args.path}; use the public SDK.` },
              ],
            }))
          },
        },
      ],
    })
    for (const input of Object.keys(result.metafile.inputs)) inputs.add(path.resolve(root, input))
    for (const out of Object.values(result.metafile.outputs))
      for (const item of out.imports) if (item.external) shared.add(item.path)
    for (const file of result.outputFiles) {
      const name = path.relative(pluginRoot, file.path).replaceAll(path.sep, "/")
      const bytes = Buffer.from(file.contents)
      if (name.endsWith(".css")) emittedStyles.push(bytes)

      files.set(name, bytes)
    }
  }
  const utilities = await compilePluginUtilityCss({
    root,
    javascript: [...files]
      .filter(([name]) => /\.[cm]?js$/.test(name))
      .map(([, bytes]) => bytes.toString())
      .join("\n"),
    contract: styleContract ?? createPluginStyleContract(repository),
  })
  for (const input of [
    ...utilities.inputs,
    ...(styleContract?.inputs ?? [path.join(repository, "app/globals.css")]),
    fileURLToPath(new URL("./plugin-styles.mjs", import.meta.url)),
  ])
    inputs.add(input)
  if (utilities.css || emittedStyles.length) {
    const authored = packaged.styles ? files.get(packaged.styles) : undefined
    packaged.styles = "dist/plugin.css"
    files.set(
      packaged.styles,
      Buffer.concat(
        [
          ...(utilities.css ? [Buffer.from(utilities.css)] : []),
          ...(authored ? [authored] : []),
          ...emittedStyles,
        ].flatMap((bytes) => [bytes, Buffer.from("\n")])
      )
    )
  }
  {
    let bytes = files.get("dist/index.js")
    {
      // Normalize paths on the live manifest without JSON-roundtripping executable adapters.
      bytes = Buffer.concat([
        bytes,
        Buffer.from(
          `\n;(()=>{const p=${JSON.stringify(packaged)},m=${JSON.stringify(mapping)};const n=v=>typeof v==='string'?(m[v]??v):Array.isArray(v)?v.map(n):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,n(x)])):v;const d=module.exports.default??module.exports.plugin??module.exports;if(d&&typeof d==='object'){d.manifest={...p,...n(d.manifest??{})};delete d.manifest.tsEntry;if(p.styles)d.manifest.styles=p.styles;}})();\n`
        ),
      ])
    }
    files.set("dist/index.js", bytes)
  }
  files.set("plugin.json", Buffer.from(`${JSON.stringify(packaged, null, 2)}\n`))
  return {
    manifest: packaged,
    originalManifest,
    files,
    fileModes,
    inputs: [...inputs],
    sharedModules: [...shared].sort(),
  }
}

export async function writeFrontendPackage(result, outputRoot) {
  validateIdentity(result.manifest)
  const archive = new JSZip()
  const date = new Date("1980-01-01T00:00:00Z")
  await mkdir(outputRoot, { recursive: true })
  const staged = await mkdtemp(path.join(outputRoot, `.${result.manifest.id}-`))
  const destination = path.join(outputRoot, result.manifest.id)
  const backup = `${staged}.previous`
  let backedUp = false
  try {
    for (const [relative, content] of [...result.files].sort(([a], [b]) => a.localeCompare(b))) {
      relativePath(relative)
      writeIfChanged(path.join(staged, relative), content)
      const mode = result.fileModes?.get(relative) ?? 0o644
      await chmod(path.join(staged, relative), mode)
      archive.file(relative, content, { date, createFolders: false, unixPermissions: mode })
    }
    if (await exists(destination)) {
      await rename(destination, backup)
      backedUp = true
    }
    try {
      await rename(staged, destination)
    } catch (error) {
      if (backedUp) {
        await rename(backup, destination)
        backedUp = false
      }
      throw error
    }
  } finally {
    await rm(staged, { recursive: true, force: true })
    if (backedUp) await rm(backup, { recursive: true, force: true })
  }
  const archivePath = path.join(outputRoot, `${result.manifest.id}-${result.manifest.version}.zip`)
  writeIfChanged(
    archivePath,
    await archive.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
      platform: "UNIX",
    })
  )
  return archivePath
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const requested = process.argv.slice(2)
  const unmatched = new Set(requested)
  const outputRoot = path.join(repository, "dist/plugins")
  await mkdir(outputRoot, { recursive: true })
  for (const directory of (await readdir(path.join(repository, "plugins"))).sort()) {
    const file = path.join(repository, "plugins", directory, "plugin.json")
    if (!(await exists(file))) continue
    const manifest = JSON.parse(await readFile(file, "utf8"))
    if (
      manifest.type !== "frontend" ||
      (requested.length && !requested.includes(directory) && !requested.includes(manifest.id))
    )
      continue
    unmatched.delete(directory)
    unmatched.delete(manifest.id)
    const result = await buildFrontendPlugin({ directory })
    process.stdout.write(`${await writeFrontendPackage(result, outputRoot)}\n`)
  }
  if (unmatched.size) throw new Error(`Unknown frontend plugins: ${[...unmatched].join(", ")}`)
}
