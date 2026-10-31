#!/usr/bin/env node
/** Produce the portable authoring distribution; normal workspace packages stay unchanged. */
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import { build } from "esbuild"
import { createPluginStyleContract } from "./plugin-styles.mjs"
import { createPluginCompilerContract } from "../build/plugin-compiler-contract.mjs"
import {
  readHostAuthoringAbi,
  sha256,
  valueSha256,
  AUTHORING_KIT_PIN,
  PRODUCT_PROFILE_FILE,
} from "../build/plugin-artifact-contract.mjs"
export { readAuthoringKit } from "./bootstrap-authoring-kit.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const require = createRequire(import.meta.url)
const ts = require("typescript")
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"))
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n")
}
const run = (args, cwd) => execFileSync("pnpm", args, { cwd, stdio: "inherit" })

export function stripSourceConditions(value) {
  if (Array.isArray(value)) return value.map(stripSourceConditions)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "cognia-source")
        .map(([key, item]) => [key, stripSourceConditions(item)])
    )
  return value
}

function filesUnder(root) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const file = path.join(root, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Symlink in authoring distribution: ${file}`)
      return entry.isDirectory() ? filesUnder(file) : [file]
    })
}

function installedVersion(name, owner, root) {
  for (const base of [root, owner]) {
    const direct = path.join(base, "node_modules", name, "package.json")
    if (fs.existsSync(direct)) return json(direct).version
    try {
      let current = path.dirname(createRequire(path.join(base, "package.json")).resolve(name))
      while (path.dirname(current) !== current) {
        const file = path.join(current, "package.json")
        if (fs.existsSync(file) && json(file).name === name) return json(file).version
        current = path.dirname(current)
      }
    } catch {
      /* Try the owning workspace and then the root. */
    }
  }
  throw new Error(`Authoring dependency ${name} is not installed`)
}

const packageName = (specifier) =>
  specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]
export function declarationDependencies(directory) {
  const dependencies = new Set()
  for (const file of filesUnder(directory).filter((name) => /\.d\.(?:ts|cts|mts)$/.test(name))) {
    const info = ts.preProcessFile(fs.readFileSync(file, "utf8"), true, true)
    for (const item of info.importedFiles) {
      if (item.fileName.startsWith(".")) {
        const target = path.resolve(path.dirname(file), item.fileName)
        if (
          !target.startsWith(`${directory}${path.sep}`) ||
          ![
            target,
            target.replace(/\.[cm]?js$/, ".d.ts"),
            `${target}.d.ts`,
            `${target}.d.cts`,
          ].some((name) => fs.existsSync(name))
        )
          throw new Error(`Unclosed declaration ${file}: ${item.fileName}`)
      } else dependencies.add(packageName(item.fileName))
    }
    for (const item of info.typeReferenceDirectives)
      dependencies.add(
        item.fileName.startsWith("@types/") ? item.fileName : `@types/${item.fileName}`
      )
  }
  return dependencies
}

function declarationSourceFiles(root, entries) {
  const config = ts.getParsedCommandLineOfConfigFile(
    path.join(root, "packages/plugin-sdk/tsconfig.json"),
    { noEmit: true },
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(error) {
        throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"))
      },
    }
  )
  return ts
    .createProgram({ rootNames: Object.values(entries), options: config.options })
    .getSourceFiles()
    .map((file) => file.fileName)
    .filter(
      (file) =>
        file.startsWith(`${root}${path.sep}`) &&
        !file.split(path.sep).some((part) => ["node_modules", "dist", "__pycache__"].includes(part))
    )
}

async function packageDistribution({ root, stage, outDir, name, entries, sdk = false }) {
  const owner = path.join(root, "packages", name)
  const original = json(path.join(owner, "package.json"))
  const directory = path.join(stage, name)
  fs.mkdirSync(path.join(directory, "dist"), { recursive: true })
  const result = await build({
    absWorkingDir: root,
    entryPoints: entries,
    outdir: path.join(directory, "dist"),
    bundle: true,
    packages: "external",
    platform: "neutral",
    format: "esm",
    splitting: true,
    target: "es2022",
    sourcemap: false,
    metafile: true,
    write: name !== "github-bot-kit",
    logLevel: "warning",
    plugins: [
      {
        name: "inline-package-json-data",
        setup(api) {
          api.onResolve({ filter: /\.json$/ }, (args) => ({
            path: createRequire(path.join(args.resolveDir || root, "package.json")).resolve(
              args.path
            ),
          }))
        },
      },
    ],
  })
  const dependencies = new Set(
    Object.values(result.metafile.outputs).flatMap((output) =>
      output.imports.filter((item) => item.external).map((item) => packageName(item.path))
    )
  )
  if (name === "github-bot-kit")
    fs.cpSync(path.join(owner, "dist"), path.join(directory, "dist"), { recursive: true })
  if (sdk || name === "plugin-ui") {
    for (const file of filesUnder(path.join(owner, "dist")).filter((file) =>
      /\.d\.(ts|cts|mts)$/.test(file)
    )) {
      const output = path.join(directory, "dist", path.relative(path.join(owner, "dist"), file))
      fs.mkdirSync(path.dirname(output), { recursive: true })
      fs.copyFileSync(file, output)
    }
  }
  for (const dependency of declarationDependencies(path.join(directory, "dist")))
    dependencies.add(dependency)
  if (dependencies.has("react")) dependencies.add("@types/react")
  if (sdk) dependencies.add("@types/node")
  // Node >=26 is the SDK's supported authoring runtime. Native require(esm)
  // preserves one implementation graph across all public CJS/ESM entry points.
  for (const entry of name === "github-bot-kit" ? [] : Object.keys(entries))
    fs.writeFileSync(
      path.join(directory, "dist", `${entry}.cjs`),
      `module.exports = require(${JSON.stringify(`./${entry}.js`)})\n`
    )
  let exports = stripSourceConditions(original.exports)
  if (name === "github-bot-kit")
    exports = Object.fromEntries(
      Object.keys(entries).map((entry) => [
        entry === "index" ? "." : `./${entry}`,
        {
          types: `./dist/${entry}.d.ts`,
          import: `./dist/${entry}.js`,
          require: `./dist/${entry}.cjs`,
          default: `./dist/${entry}.js`,
        },
      ])
    )
  const exactDependencies = {}
  for (const dependency of [...dependencies].sort()) {
    if (dependency.startsWith("node:")) continue
    if (dependency.startsWith("@cognia/") || dependency.startsWith("@/"))
      throw new Error(`Unclosed authoring dependency ${dependency}`)
    exactDependencies[dependency] = installedVersion(dependency, owner, root)
  }
  const manifest = {
    name: original.name,
    version: original.version,
    type: "module",
    sideEffects: original.sideEffects,
    license: original.license ?? "AGPL-3.0-only",
    engines: original.engines,
    main: "./dist/index.cjs",
    module: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports,
    files: ["dist", "README.md", "LICENSE"],
    dependencies: exactDependencies,
  }
  for (const file of ["README.md", "LICENSE"])
    if (fs.existsSync(path.join(owner, file)))
      fs.copyFileSync(path.join(owner, file), path.join(directory, file))
  writeJson(path.join(directory, "package.json"), manifest)
  const packageFiles = Object.fromEntries(
    filesUnder(directory).map((file) => [
      path.relative(directory, file).replaceAll(path.sep, "/"),
      sha256(fs.readFileSync(file)),
    ])
  )
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", outDir], {
      cwd: directory,
      encoding: "utf8",
    })
  )
  return {
    name: manifest.name,
    version: manifest.version,
    file: packed[0].filename,
    dependencies: exactDependencies,
    files: packageFiles,
    inputs: Object.keys(result.metafile.inputs).map((file) => path.resolve(root, file)),
  }
}

export async function buildAuthoringKit({
  root = ROOT,
  outDir,
  buildPackages = true,
  writePin = false,
} = {}) {
  if (!outDir) throw new Error("An authoring kit output directory is required")
  root = path.resolve(root)
  outDir = path.resolve(outDir)
  const { runtimeEntries } = await import(path.join(root, "packages/plugin-sdk/tsup.config.ts"))
  const sdkEntries = Object.fromEntries(
    Object.entries(runtimeEntries).map(([key, file]) => [
      key,
      path.join(root, "packages/plugin-sdk", file),
    ])
  )
  const initialFiles = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  )
    .split("\0")
    .filter(Boolean)
  initialFiles.push(
    ...declarationSourceFiles(root, sdkEntries).map((file) => path.relative(root, file))
  )
  const initialSources = Object.fromEntries(
    initialFiles
      .filter(
        (file) =>
          fs.statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile() &&
          !fs.lstatSync(path.join(root, file)).isSymbolicLink()
      )
      .map((file) => [file, sha256(fs.readFileSync(path.join(root, file)))])
  )
  fs.mkdirSync(outDir, { recursive: true })
  const stage = fs.mkdtempSync(path.join(outDir, ".packages-"))
  try {
    if (buildPackages)
      for (const name of ["plugin-sdk", "plugin-ui"])
        run(["--dir", `packages/${name}`, "run", "build"], root)
    const uiOwner = path.join(root, "packages/plugin-ui")
    const uiEntries = Object.fromEntries(
      Object.values(json(path.join(uiOwner, "package.json")).exports)
        .filter((entry) => typeof entry === "object")
        .map((entry) => [
          entry.import.replace(/^\.\/dist\//, "").replace(/\.js$/, ""),
          path.join(uiOwner, entry.import),
        ])
    )
    const githubOwner = path.join(root, "packages/github-bot-kit")
    run(["run", "build"], githubOwner)
    const packages = []
    packages.push(
      await packageDistribution({
        root,
        stage,
        outDir,
        name: "plugin-sdk",
        entries: sdkEntries,
        sdk: true,
      })
    )
    packages.push(
      await packageDistribution({ root, stage, outDir, name: "plugin-ui", entries: uiEntries })
    )
    packages.push(
      await packageDistribution({
        root,
        stage,
        outDir,
        name: "github-bot-kit",
        entries: {
          index: path.join(githubOwner, "dist/index.js"),
          testing: path.join(githubOwner, "dist/testing.js"),
        },
      })
    )
    execFileSync(
      "uv",
      ["build", "--wheel", "--out-dir", outDir, path.join(root, "plugin-sdk/python")],
      {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          SOURCE_DATE_EPOCH: execFileSync("git", ["show", "-s", "--format=%ct", "HEAD"], {
            cwd: root,
            encoding: "utf8",
          }).trim(),
        },
      }
    )
    const style = createPluginStyleContract(root)
    const contracts = {
      "contract/catalog.json": "packages/plugin-contract/contract/catalog.json",
      "contract/product-profile.json": PRODUCT_PROFILE_FILE,
      "contract/cognia-plugin.wit": "src-tauri/wit/cognia-plugin.wit",
    }
    for (const [output, input] of Object.entries(contracts)) {
      fs.mkdirSync(path.dirname(path.join(outDir, output)), { recursive: true })
      fs.copyFileSync(path.join(root, input), path.join(outDir, output))
    }
    writeJson(path.join(outDir, "contract/style.json"), { ...style, inputs: [] })
    writeJson(path.join(outDir, "contract/compiler.json"), {
      ...createPluginCompilerContract(root),
      inputs: [],
    })
    const tooling = [
      "scripts/build/plugin-artifact-format.mjs",
      "scripts/build/plugin-artifact-contract.mjs",
      "scripts/build/esbuild-input-cache.mjs",
      "scripts/build/source-fingerprint.mjs",
      "scripts/build/plugin-compiler-contract.mjs",
    ]
    for (const relative of tooling) {
      const output = path.join(outDir, "tooling", relative)
      fs.mkdirSync(path.dirname(output), { recursive: true })
      fs.copyFileSync(path.join(root, relative), output)
    }
    const sourceFiles = new Set([
      ...packages
        .flatMap((entry) => entry.inputs)
        .filter(
          (file) =>
            !file.includes(`${path.sep}node_modules${path.sep}`) &&
            !file.includes(`${path.sep}dist${path.sep}`)
        ),
      ...Object.values(contracts).map((file) => path.join(root, file)),
      ...tooling.map((file) => path.join(root, file)),
      ...[
        "scripts/plugin/authoring-kit.mjs",
        "scripts/plugin/plugin-styles.mjs",
        "scripts/plugin/bootstrap-authoring-kit.mjs",
        "scripts/plugin/generate-author-types.mjs",
        "lib/plugin/core/shared-modules.ts",
        "lib/plugin/core/sdk-subpath-loaders.ts",
        "lib/plugin/styles/plugin-stylesheet.ts",
        "app/globals.css",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "tsconfig.json",
        "tsconfig.build.json",
      ].map((file) => path.join(root, file)),
    ])
    const owningSources = execFileSync(
      "git",
      [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        "packages/plugin-sdk",
        "packages/plugin-ui",
        "packages/github-bot-kit",
        "plugin-sdk/python",
        "types",
      ],
      { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
    )
      .split("\0")
      .filter(Boolean)
    for (const relative of owningSources)
      if (
        !relative
          .split("/")
          .some(
            (part) =>
              ["dist", "build", "__pycache__", ".venv"].includes(part) || part.endsWith(".egg-info")
          ) &&
        !/\.test\.|\.pyc$/.test(relative) &&
        fs.existsSync(path.join(root, relative))
      )
        sourceFiles.add(path.join(root, relative))
    for (const file of declarationSourceFiles(root, sdkEntries)) sourceFiles.add(file)
    const inputs = Object.fromEntries(
      [...sourceFiles]
        .sort()
        .map((file) => [
          path.relative(root, file).replaceAll(path.sep, "/"),
          sha256(fs.readFileSync(file)),
        ])
    )
    for (const [file, hash] of Object.entries(inputs))
      if (initialSources[file] !== hash)
        throw new Error(`Authoring source changed or was not inventoried before the build: ${file}`)
    // Staging contains build intermediates and is not part of the distribution.
    fs.rmSync(stage, { recursive: true, force: true })
    const files = Object.fromEntries(
      filesUnder(outDir)
        .filter((file) => path.basename(file) !== "authoring-kit.json")
        .map((file) => [
          path.relative(outDir, file).replaceAll(path.sep, "/"),
          sha256(fs.readFileSync(file)),
        ])
    )
    const manifest = {
      schema: 1,
      authoring: readHostAuthoringAbi(root),
      source: {
        revision: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
        treeSha256: valueSha256(inputs),
        inputs,
      },
      toolchain: {
        node: process.version,
        esbuild: require("esbuild/package.json").version,
        tailwind: require("tailwindcss/package.json").version,
        lockfileSha256: sha256(fs.readFileSync(path.join(root, "pnpm-lock.yaml"))),
      },
      packages: packages.map(({ inputs: _, ...entry }) => entry),
      files,
    }
    writeJson(path.join(outDir, "authoring-kit.json"), manifest)
    const digest = sha256(fs.readFileSync(path.join(outDir, "authoring-kit.json")))
    if (writePin)
      writeJson(path.join(root, AUTHORING_KIT_PIN), {
        schema: 1,
        sha256: digest,
        authoring: manifest.authoring,
      })
    return { manifest, sha256: digest, outDir }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv.indexOf("--out")
  if (out < 0 || !process.argv[out + 1])
    throw new Error(
      "usage: authoring-kit.mjs --out <directory> [--write-pin] [--reuse-package-builds]"
    )
  const result = await buildAuthoringKit({
    outDir: process.argv[out + 1],
    writePin: process.argv.includes("--write-pin"),
    buildPackages: !process.argv.includes("--reuse-package-builds"),
  })
  console.log(
    `[authoring-kit] ${result.sha256} (${Object.keys(result.manifest.files).length} files)`
  )
}
