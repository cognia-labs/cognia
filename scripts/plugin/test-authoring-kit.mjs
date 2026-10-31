#!/usr/bin/env node
/** Independent distribution proof. Never links a package or alias back to Host. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createRequire, isBuiltin } from "node:module"
import { execFileSync } from "node:child_process"
import { bootstrapAuthoringKit, readAuthoringKit } from "./bootstrap-authoring-kit.mjs"
import { sha256, valueSha256 } from "../build/plugin-artifact-contract.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const require = createRequire(import.meta.url)
const ts = require("typescript")
const argument = (name) => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const kitRoot = path.resolve(argument("--kit") ?? ".cache/plugin-extraction/authoring-kit")
const { manifest, compilerContract } = readAuthoringKit(kitRoot)
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-authoring-proof-"))
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"))
const write = (relative, content) => {
  const file = path.join(directory, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}
const env = { ...process.env, NODE_OPTIONS: "", TSX_TSCONFIG_PATH: "" }
delete env.NODE_PATH
const run = (command, args) =>
  execFileSync(command, args, { cwd: directory, env, stdio: "inherit", timeout: 600000 })
try {
  const pin = {
    schema: 1,
    sha256: sha256(fs.readFileSync(path.join(kitRoot, "authoring-kit.json"))),
    url: pathToFileURL(path.join(kitRoot, "authoring-kit.json")).href,
  }
  write("authoring-kit.lock.json", JSON.stringify(pin))
  await bootstrapAuthoringKit({
    pinFile: path.join(directory, "authoring-kit.lock.json"),
    target: path.join(directory, ".vendor/authoring-kit"),
  })
  const dependencies = Object.fromEntries(
    manifest.packages.map((entry) => [entry.name, `file:.vendor/authoring-kit/${entry.file}`])
  )
  const rootManifest = json(path.join(ROOT, "package.json"))
  const dependencyVersion = (name) => {
    const declared = rootManifest.dependencies?.[name] ?? rootManifest.devDependencies?.[name]
    if (declared && /^(https?:|npm:)/.test(declared)) return declared
    for (const owner of [
      ROOT,
      path.join(ROOT, "packages/plugin-sdk"),
      path.join(ROOT, "packages/plugin-ui"),
    ]) {
      const file = path.join(owner, "node_modules", name, "package.json")
      if (fs.existsSync(file)) return json(file).version
    }
    if (!declared || declared.includes("workspace:") || declared.includes("link:"))
      throw new Error(`Independent plugin dependency is not declared: ${name}`)
    return declared
  }
  const sourceFiles = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "plugins"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  )
    .split("\0")
    .filter(Boolean)
  let copied = 0
  const sourceSnapshot = {}
  for (const relative of new Set(sourceFiles)) {
    const source = path.join(ROOT, relative)
    if (!fs.existsSync(source)) continue
    if (fs.lstatSync(source).isSymbolicLink()) throw new Error(`Plugin source symlink: ${relative}`)
    const bytes = fs.readFileSync(source)
    write(relative, bytes)
    copied++
    sourceSnapshot[relative] = {
      sha256: sha256(bytes),
      mode: fs.statSync(source).mode & 0o111 ? 0o755 : 0o644,
    }
    fs.chmodSync(path.join(directory, relative), sourceSnapshot[relative].mode)
    if (
      !/^plugins\/[^/]+\/src\//.test(relative) ||
      !/\.[cm]?[jt]sx?$/.test(relative) ||
      /\.test\./.test(relative)
    )
      continue
    const imports = ts.preProcessFile(bytes.toString(), true, true).importedFiles
    for (const { fileName } of imports) {
      if (fileName.startsWith(".") || isBuiltin(fileName)) continue
      if (fileName.startsWith("@/"))
        throw new Error(`Host-private plugin import: ${relative} -> ${fileName}`)
      const name = fileName.startsWith("@")
        ? fileName.split("/").slice(0, 2).join("/")
        : fileName.split("/")[0]
      if (!dependencies[name]) dependencies[name] = dependencyVersion(name)
    }
  }
  for (const name of [
    "tsx",
    "esbuild",
    "jszip",
    "jsonc-parser",
    "write-file-atomic",
    "jest",
    "@jest/globals",
    "@tailwindcss/postcss",
    "tailwindcss",
    "typescript",
    "@types/react",
    "@types/node",
    "@types/jest",
    "@types/semver",
    "@types/json-schema",
  ])
    dependencies[name] =
      name === "typescript" ? rootManifest.devDependencies.typescript : dependencyVersion(name)
  write(
    "package.json",
    JSON.stringify(
      {
        name: "cognia-independent-plugin-proof",
        private: true,
        type: compilerContract.packageType,
        dependencies,
      },
      null,
      2
    )
  )
  const yaml = require("yaml")
  const workspace = yaml.parse(fs.readFileSync(path.join(ROOT, "pnpm-workspace.yaml"), "utf8"))
  const patchedDependencies = Object.fromEntries(
    Object.entries(workspace.patchedDependencies ?? {}).filter(
      ([specifier]) =>
        dependencies[specifier.slice(0, specifier.lastIndexOf("@"))] ||
        specifier.startsWith("@sinonjs/fake-timers@")
    )
  )
  for (const file of Object.values(patchedDependencies))
    write(file, fs.readFileSync(path.join(ROOT, file)))
  write(
    "pnpm-workspace.yaml",
    yaml.stringify({
      packages: ["."],
      patchedDependencies,
      overrides: workspace.overrides,
      catalog: workspace.catalog,
    })
  )
  const scripts = [
    "scripts/plugin/build-frontend-plugins.mjs",
    "scripts/plugin/plugin-styles.mjs",
    "scripts/plugin/bootstrap-authoring-kit.mjs",
    "scripts/plugin/artifacts/produce.mjs",
    "scripts/plugin/artifacts/builtin-chunks.mjs",
    "scripts/plugin/artifacts/desktop-plugins.mjs",
  ]
  for (const relative of scripts) write(relative, fs.readFileSync(path.join(ROOT, relative)))
  for (const relative of Object.keys(manifest.files).filter((file) => file.startsWith("tooling/")))
    write(
      relative.slice("tooling/".length),
      fs.readFileSync(path.join(directory, ".vendor/authoring-kit", relative))
    )
  run("pnpm", ["install", "--lockfile-only", "--ignore-scripts"])
  run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"])
  write(
    "exports.mjs",
    `import assert from "node:assert/strict"; import {createRequire} from "node:module"; import fs from "node:fs"; const require=createRequire(import.meta.url); const packages=${JSON.stringify(manifest.packages.map((entry) => entry.name))}; let count=0; for(const name of packages){const m=JSON.parse(fs.readFileSync(new URL('./node_modules/'+name+'/package.json',import.meta.url)));assert.ok(!JSON.stringify(m).includes('cognia-source'));for(const key of Object.keys(m.exports)){if(key==='./package.json')continue;const specifier=name+(key==='.'?'':key.slice(1));const esm=await import(specifier),cjs=require(specifier);assert.deepEqual(Object.keys(esm).sort(),Object.keys(cjs).sort());count++}} const sdk=await import('@cognia/plugin-sdk'); assert.equal(typeof sdk.definePlugin,'function'); const original={manifest:{id:'probe'},activate(){return 42}}; assert.equal(sdk.definePlugin(original).activate(),42); console.log('[authoring-proof] runtime exports',count)\n`
  )
  run(process.execPath, ["exports.mjs"])
  const imports = []
  for (const entry of manifest.packages) {
    const exported = json(path.join(directory, "node_modules", entry.name, "package.json")).exports
    for (const key of Object.keys(exported))
      if (key !== "./package.json")
        imports.push(
          `import * as p${imports.length} from ${JSON.stringify(entry.name + (key === "." ? "" : key.slice(1)))}; void p${imports.length};`
        )
  }
  write("exports.ts", imports.join("\n"))
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        jsx: "react-jsx",
        types: ["node", "react"],
        lib: ["ES2022", "DOM", "DOM.Iterable"],
      },
      files: ["exports.ts"],
    })
  )
  const typescript = json(path.join(directory, "node_modules/typescript/package.json"))
  run(process.execPath, [
    path.join(directory, "node_modules/typescript", typescript.bin.tsc ?? typescript.bin.tsc6),
    "--project",
    "tsconfig.json",
  ])
  const pluginSources = sourceFiles.filter(
    (file) =>
      /^plugins\/[^/]+\/src\//.test(file) &&
      /\.tsx?$/.test(file) &&
      !/\.test\./.test(file) &&
      fs.existsSync(path.join(directory, file))
  )
  write(
    "tsconfig.plugins.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        jsx: "react-jsx",
        resolveJsonModule: true,
        esModuleInterop: true,
        types: ["node", "react", "jest"],
        lib: ["ES2022", "DOM", "DOM.Iterable"],
      },
      files: pluginSources,
    })
  )
  run(process.execPath, [
    path.join(directory, "node_modules/typescript", typescript.bin.tsc ?? typescript.bin.tsc6),
    "--project",
    "tsconfig.plugins.json",
  ])
  const helperSuites = [
    ...fs
      .readdirSync(path.join(ROOT, "packages/github-bot-kit/src"))
      .filter((file) => file.endsWith(".test.ts"))
      .map((file) => ({
        source: `packages/github-bot-kit/src/${file}`,
        name: `github-${file}`,
        specifier: "@cognia/github-bot-kit",
        testing: true,
      })),
    ...[
      ["runtime/abort", "api/abort"],
      ["templates/index", "templates"],
      ["api/agent-team-template", "api/agent-team-template"],
    ].map(([source, entry]) => ({
      source: `packages/plugin-sdk/src/${source}.test.ts`,
      name: `sdk-${source.replaceAll("/", "-")}.test.ts`,
      specifier: `@cognia/plugin-sdk/${entry}`,
    })),
  ]
  for (const suite of helperSuites) {
    const code = fs
      .readFileSync(path.join(ROOT, suite.source), "utf8")
      .replace(
        /from\s+(["'])\.\/([^"']+)\1/g,
        (_match, _quote, relative) =>
          `from ${JSON.stringify(suite.testing && relative === "testing" ? `${suite.specifier}/testing` : suite.specifier)}`
      )
    write(
      `helper-tests/${suite.name.replace(/\.ts$/, ".mjs")}`,
      require("esbuild").transformSync(`import {jest} from '@jest/globals';\n${code}`, {
        loader: "ts",
        format: "esm",
        target: "es2022",
      }).code
    )
  }
  write(
    "jest.config.cjs",
    "module.exports={testEnvironment:'node',testMatch:['<rootDir>/helper-tests/*.test.mjs'],transform:{}}\n"
  )
  const previousOptions = env.NODE_OPTIONS
  env.NODE_OPTIONS = "--experimental-vm-modules"
  try {
    run("pnpm", ["exec", "jest", "--runInBand", "--config", "jest.config.cjs"])
  } finally {
    env.NODE_OPTIONS = previousOptions
  }
  const wheel = Object.keys(manifest.files).find((file) => file.endsWith(".whl"))
  if (!wheel) throw new Error("Authoring kit has no Python wheel")
  run("uv", ["venv", "python-env"])
  const python = path.join(
    directory,
    "python-env",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python"
  )
  run("uv", [
    "pip",
    "install",
    "--python",
    python,
    "--no-deps",
    path.join(directory, ".vendor/authoring-kit", wheel),
  ])
  run(python, [
    "-I",
    "-c",
    "import cognia, importlib, pkgutil; [importlib.import_module(m.name) for m in pkgutil.iter_modules(cognia.__path__, cognia.__name__ + '.')]; assert callable(cognia.tool) and callable(cognia.define_skill); print('[authoring-proof] Python wheel imports passed')",
  ])
  write(
    "produce-proof.mjs",
    `import fs from 'node:fs'; import path from 'node:path'; import {buildFrontendPlugin,writeFrontendPackage} from './scripts/plugin/build-frontend-plugins.mjs'; import {readAuthoringKit} from './scripts/plugin/bootstrap-authoring-kit.mjs'; import {producePluginArtifacts} from './scripts/plugin/artifacts/produce.mjs'; const root=process.cwd(),kitRoot=path.join(root,'.vendor/authoring-kit'),kit=readAuthoringKit(kitRoot); let count=0; for(const directory of fs.readdirSync('plugins')){const file=path.join('plugins',directory,'plugin.json');if(!fs.existsSync(file))continue;const m=JSON.parse(fs.readFileSync(file));if(m.type!=='frontend')continue;const result=await buildFrontendPlugin({root,directory,contractCatalog:kit.contractCatalog,styleContract:kit.styleContract,compilerContract:kit.compilerContract}); for(const input of result.inputs)if(!path.resolve(input).startsWith(root+path.sep))throw new Error('Escaped independent build: '+input);await writeFrontendPackage(result,path.join(root,'packages-out'));count++} if(count!==69)throw new Error('Expected 69 frontend packages, received '+count);await producePluginArtifacts({root,kitRoot,outDir:path.join(root,'artifact'),source:{repository:'cognia-labs/cognia-next',revision:${JSON.stringify(execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim())},sourceTreeSha256:${JSON.stringify(valueSha256(sourceSnapshot))},lockfileSha256:${JSON.stringify(sha256(fs.readFileSync(path.join(directory, "pnpm-lock.yaml"))))}}});console.log('[authoring-proof] packages',count)\n`
  )
  run(process.execPath, ["produce-proof.mjs"])
  for (const [relative, expected] of Object.entries(sourceSnapshot)) {
    const file = path.join(directory, relative)
    if (
      sha256(fs.readFileSync(file)) !== expected.sha256 ||
      (fs.statSync(file).mode & 0o111 ? 0o755 : 0o644) !== expected.mode
    )
      throw new Error(`Independent source changed during validation: ${relative}`)
  }
  const report = {
    kitSha256: pin.sha256,
    harnessSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))),
    sourceFiles: copied,
    pluginTypecheckFiles: pluginSources.length,
    helperSuites: helperSuites.length,
    independentRoot: directory,
    result: "passed",
  }
  fs.mkdirSync(path.join(ROOT, ".cache/plugin-extraction"), { recursive: true })
  fs.writeFileSync(
    path.join(ROOT, ".cache/plugin-extraction/authoring-proof.json"),
    JSON.stringify(report, null, 2) + "\n"
  )
  console.log(JSON.stringify(report))
} finally {
  if (!process.argv.includes("--keep")) fs.rmSync(directory, { recursive: true, force: true })
  else console.log(`[authoring-proof] retained ${directory}`)
}
