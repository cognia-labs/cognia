/** Build-time identity and semantic admission shared by producer and Host. */
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { createPluginCompilerContract } from "./plugin-compiler-contract.mjs"
import { assertSetRelativePath, BUILTIN_CHUNK_URL_PREFIX } from "./plugin-artifact-format.mjs"

export const PRODUCT_PROFILE_FILE = "lib/plugin/distribution/product-profile.json"
export const AUTHORING_KIT_PIN = "lib/plugin/distribution/authoring-kit.json"
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`
  return JSON.stringify(value)
}
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")
export const valueSha256 = (value) => sha256(canonicalJson(value))
const read = (root, file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"))

export function createProductProfile({ root, pluginsRoot = path.join(root, "plugins") }) {
  const browserIds = read(root, "lib/plugin/distribution/browser-builtins.json")
  const distribution = read(root, "lib/plugin/distribution/distribution.json")
  const browser = browserIds.map((directory) => {
    assertSetRelativePath(directory)
    const manifest = JSON.parse(
      fs.readFileSync(path.join(pluginsRoot, directory, "plugin.json"), "utf8")
    )
    return { directory, id: manifest.id }
  })
  return {
    schema: 1,
    name: "first-party",
    browser,
    desktop: distribution.bundled ?? {},
    companions: browser.filter(
      ({ directory }) =>
        JSON.parse(fs.readFileSync(path.join(pluginsRoot, directory, "plugin.json"), "utf8"))
          .nodeRuntime
    ),
    devOnly: distribution.devOnly ?? {},
  }
}

export function readProductProfile(root) {
  const profile = read(root, PRODUCT_PROFILE_FILE)
  equal(
    profile.browser?.map((entry) => entry.directory),
    read(root, "lib/plugin/distribution/browser-builtins.json"),
    "Host browser profile"
  )
  const distribution = read(root, "lib/plugin/distribution/distribution.json")
  equal(profile.desktop, distribution.bundled ?? {}, "Host desktop profile")
  equal(profile.devOnly, distribution.devOnly ?? {}, "Host dev-only profile")
  return profile
}

export function readHostAuthoringAbi(root) {
  const sdk = read(root, "packages/plugin-sdk/package.json")
  const ui = read(root, "packages/plugin-ui/package.json")
  const catalog = read(root, "packages/plugin-contract/contract/catalog.json")
  const hashFiles = (files) =>
    valueSha256(
      Object.fromEntries(
        files.map((file) => [file, sha256(fs.readFileSync(path.join(root, file)))])
      )
    )
  const sourceFiles = (directory) =>
    fs
      .readdirSync(path.join(root, directory), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) => {
        const relative = `${directory}/${entry.name}`
        if (entry.isSymbolicLink()) fail(`symlink in authoring source ${relative}`)
        return entry.isDirectory()
          ? sourceFiles(relative)
          : /\.(?:tsx?|json)$/.test(relative) && !/\.test\./.test(relative)
            ? [relative]
            : []
      })
  const identity = {
    sdkVersion: sdk.version,
    uiVersion: ui.version,
    contractVersion: catalog.contractVersion,
    catalogSha256: valueSha256(catalog),
    sharedModulesSha256: hashFiles([
      "lib/plugin/core/shared-modules.ts",
      "lib/plugin/core/sdk-subpath-loaders.ts",
    ]),
    styleContractSha256: hashFiles(["app/globals.css", "lib/plugin/styles/plugin-stylesheet.ts"]),
    compilerContractSha256: valueSha256({ ...createPluginCompilerContract(root), inputs: [] }),
    witSha256: sha256(fs.readFileSync(path.join(root, "src-tauri/wit/cognia-plugin.wit"))),
    sdkSourceSha256: hashFiles([
      ...sourceFiles("packages/plugin-sdk/src"),
      ...sourceFiles("types/plugin"),
      "packages/plugin-sdk/package.json",
    ]),
    uiSourceSha256: hashFiles([
      ...sourceFiles("packages/plugin-ui/src"),
      "packages/plugin-ui/package.json",
    ]),
    lockfileSha256: sha256(fs.readFileSync(path.join(root, "pnpm-lock.yaml"))),
    githubKitSourceSha256: hashFiles([
      ...sourceFiles("packages/github-bot-kit/src"),
      "packages/github-bot-kit/package.json",
      "packages/github-bot-kit/tsup.config.ts",
    ]),
    sharedModules: [
      "react",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "@cognia/plugin-sdk",
      "@cognia/plugin-ui",
      "lucide-react",
      ...Object.keys(sdk.exports)
        .filter((entry) => entry !== "." && entry !== "./package.json")
        .map((entry) => `@cognia/plugin-sdk/${entry.slice(2)}`),
    ],
  }
  return identity
}

export function readHostAuthoringIdentity(root) {
  const identity = readHostAuthoringAbi(root)
  const pin = read(root, AUTHORING_KIT_PIN)
  equal(
    pin.authoring,
    identity,
    "Host authoring kit ABI; regenerate and validate the kit before updating its pin"
  )
  if (!/^[a-f0-9]{64}$/.test(pin.sha256 ?? "")) fail("invalid Host authoring kit pin")
  return { ...identity, kitSha256: pin.sha256 }
}

function fail(message) {
  throw new Error(`Plugin artifact contract: ${message}`)
}
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`invalid ${label}`)
  return value
}
function equal(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) fail(`${label} mismatch`)
}
function jsonFile(files, name) {
  const bytes = files.get(name)
  if (!bytes) fail(`missing ${name}`)
  try {
    return object(JSON.parse(bytes.toString()), name)
  } catch (error) {
    fail(`${name}: ${error.message}`)
  }
}
function sameKeys(actual, expected, label) {
  equal(Object.keys(actual).sort(), expected.slice().sort(), label)
}

export function assertArtifactIdentity(manifest) {
  object(manifest.source, "source identity")
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(manifest.source.repository ?? "") ||
    !/^[a-f0-9]{40}$/.test(manifest.source.revision ?? "") ||
    !/^[a-f0-9]{64}$/.test(manifest.source.sourceTreeSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(manifest.source.lockfileSha256 ?? "")
  )
    fail("invalid source identity")
  object(manifest.authoring, "authoring identity")
  for (const key of [
    "kitSha256",
    "catalogSha256",
    "sharedModulesSha256",
    "styleContractSha256",
    "compilerContractSha256",
    "witSha256",
    "sdkSourceSha256",
    "uiSourceSha256",
    "githubKitSourceSha256",
    "lockfileSha256",
  ]) {
    if (!/^[a-f0-9]{64}$/.test(manifest.authoring[key] ?? "")) fail(`invalid authoring ${key}`)
  }
  for (const key of ["sdkVersion", "uiVersion", "contractVersion"]) {
    if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(manifest.authoring[key] ?? ""))
      fail(`invalid authoring ${key}`)
  }
  object(manifest.profile, "profile identity")
  if (
    typeof manifest.profile.name !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.profile.sha256 ?? "")
  )
    fail("invalid profile identity")
  if (!Array.isArray(manifest.inventory)) fail("missing release inventory")
  const ids = new Set(),
    directories = new Set()
  for (const entry of manifest.inventory) {
    if (
      !entry ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(entry.id ?? "") ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(entry.directory ?? "") ||
      !["frontend", "python", "wasm"].includes(entry.type) ||
      typeof entry.version !== "string" ||
      !entry.version ||
      !/^[a-f0-9]{64}$/.test(entry.manifestSha256 ?? "") ||
      ids.has(entry.id) ||
      directories.has(entry.directory)
    )
      fail("invalid or duplicate inventory identity")
    ids.add(entry.id)
    directories.add(entry.directory)
  }
}

function pathValues(value, expression) {
  const [head, ...tail] = expression.split(".")
  const values =
    head === "*"
      ? Object.values(value ?? {})
      : head.endsWith("[]")
        ? (value?.[head.slice(0, -2)] ?? [])
        : [value?.[head]]
  return values.flatMap((item) =>
    tail.length ? pathValues(item, tail.join(".")) : typeof item === "string" ? [item] : []
  )
}

export function verifyPluginArtifactContract({
  manifest,
  sections,
  profile,
  authoring,
  contractCatalog,
}) {
  assertArtifactIdentity(manifest)
  if (
    profile?.schema !== 1 ||
    !Array.isArray(profile.browser) ||
    !Array.isArray(profile.companions)
  )
    fail("missing expected product profile")
  equal(manifest.profile, { name: profile.name, sha256: valueSha256(profile) }, "profile")
  equal(manifest.authoring, authoring, "authoring identity")
  const inventory = new Map(manifest.inventory.map((entry) => [entry.directory, entry]))
  const index = jsonFile(sections.builtinIndex, "")
  if (index.version !== 1) fail("unsupported browser catalog version")
  const entries = object(index.entries, "browser entries")
  sameKeys(
    entries,
    profile.browser.map((entry) => entry.id),
    "browser catalog membership"
  )
  const shared = object(index.sharedResources, "shared resources")
  sameKeys(shared, ["pdfWorker"], "shared resource membership")
  const worker = object(shared.pdfWorker, "PDF worker")
  const workerPath = `_shared/pdf.worker.${worker.sha256}.mjs`
  const workerBytes = sections.builtinChunks.get(workerPath)
  if (
    !/^[a-f0-9]{64}$/.test(worker.sha256 ?? "") ||
    worker.url !== `${BUILTIN_CHUNK_URL_PREFIX}/${workerPath}` ||
    !workerBytes ||
    sha256(workerBytes) !== worker.sha256
  )
    fail("shared PDF worker identity or resource")
  const preboot = {}
  const browserChunks = new Set([workerPath])
  const browserResourcePrefixes = []
  for (const { directory, id } of profile.browser) {
    const entry = object(entries[id], `browser ${id}`)
    const plugin = object(entry.manifest, `manifest ${id}`)
    if (
      inventory.get(directory)?.id !== id ||
      plugin.id !== id ||
      plugin.type !== "frontend" ||
      plugin.version !== inventory.get(directory)?.version ||
      entry.path !== `builtin://${id}`
    )
      fail(`browser identity ${id}`)
    const resourcePrefix = `${id}/resources/`
    equal(
      jsonFile(sections.builtinChunks, `${resourcePrefix}plugin.json`),
      plugin,
      `resource manifest ${id}`
    )
    if (valueSha256(plugin) !== inventory.get(directory).manifestSha256)
      fail(`inventory manifest ${id}`)
    const asset = object(entry.asset, `asset ${id}`)
    const chunk = `${id}/${asset.sha256}.cjs`
    browserChunks.add(chunk)
    browserResourcePrefixes.push(resourcePrefix)
    if (
      asset.url !== `${BUILTIN_CHUNK_URL_PREFIX}/${chunk}` ||
      !sections.builtinChunks.has(chunk) ||
      sha256(sections.builtinChunks.get(chunk)) !== asset.sha256 ||
      asset.resourcesUrl !== `${BUILTIN_CHUNK_URL_PREFIX}/${id}/resources/`
    )
      fail(`chunk identity ${id}`)
    assertSetRelativePath(plugin.main)
    if (
      !sections.builtinChunks
        .get(`${resourcePrefix}${plugin.main}`)
        ?.equals(sections.builtinChunks.get(chunk))
    )
      fail(`main resource ${id}`)
    if (plugin.styles) {
      assertSetRelativePath(plugin.styles)
      const css = sections.builtinChunks.get(`${resourcePrefix}${plugin.styles}`)
      if (!css || entry.bundledStyles !== css.toString()) fail(`stylesheet ${id}`)
    }
    const allowedModules = authoring.sharedModules ?? [
      "react",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "@cognia/plugin-sdk",
      "@cognia/plugin-ui",
      "lucide-react",
    ]
    if (
      !Array.isArray(asset.sharedModules) ||
      asset.sharedModules.some((name) => !allowedModules.includes(name))
    )
      fail(`shared modules ${id}`)
    for (const field of contractCatalog?.pathFields ?? []) {
      if (field.path.startsWith("nodeRuntime.") || field.kind === "contained-only") continue
      for (const relative of pathValues(plugin, field.path)) {
        if (field.sentinels?.includes(relative)) continue
        assertSetRelativePath(relative)
        const resource = `${resourcePrefix}${relative}`
        if (
          field.kind === "directory"
            ? ![...sections.builtinChunks.keys()].some((key) => key.startsWith(`${resource}/`))
            : !sections.builtinChunks.has(resource)
        )
          fail(`declared resource ${id}/${relative}`)
        if (
          field.runtime === "javascript" &&
          asset.entryHashes?.[relative] !== sha256(sections.builtinChunks.get(resource))
        )
          fail(`missing entry integrity ${id}/${relative}`)
      }
    }
    for (const [relative, digest] of Object.entries(asset.entryHashes ?? {})) {
      assertSetRelativePath(relative)
      const bytes = sections.builtinChunks.get(`${resourcePrefix}${relative}`)
      if (!bytes || sha256(bytes) !== digest) fail(`entry resource ${id}/${relative}`)
    }
    const fields = Object.fromEntries(
      ["dexie", "characterPacks"]
        .filter((key) => plugin[key] !== undefined)
        .map((key) => [key, plugin[key]])
    )
    if (Object.keys(fields).length) preboot[id] = { version: plugin.version, ...fields }
  }
  for (const relative of sections.builtinChunks.keys()) {
    if (
      browserChunks.has(relative) ||
      browserResourcePrefixes.some((prefix) => relative.startsWith(prefix))
    )
      continue
    fail(`unowned browser payload ${relative}`)
  }
  equal(
    jsonFile(sections.prebootManifests, ""),
    { version: 1, plugins: preboot },
    "preboot projection"
  )
  const desktop = object(jsonFile(sections.desktopCatalog, "").entries, "desktop entries")
  const expectedDesktop = [
    ...Object.entries(profile.desktop ?? {}).map(([directory, entry]) => ({
      directory,
      id: entry.id,
    })),
    ...profile.companions,
  ]
  equal(
    profile.companions,
    profile.browser.filter(({ id }) => entries[id].manifest.nodeRuntime),
    "runtime companion selection"
  )
  sameKeys(
    desktop,
    expectedDesktop.map((entry) => entry.directory),
    "desktop catalog membership"
  )
  const listedDesktop = new Set()
  for (const { directory, id } of expectedDesktop) {
    const entry = object(desktop[directory], `desktop ${directory}`)
    const plugin = jsonFile(sections.desktopPlugins, `${directory}/plugin.json`)
    if (
      entry.id !== id ||
      plugin.id !== id ||
      entry.version !== plugin.version ||
      inventory.get(directory)?.id !== id ||
      inventory.get(directory)?.version !== plugin.version ||
      inventory.get(directory)?.manifestSha256 !== valueSha256(plugin)
    )
      fail(`desktop identity ${directory}`)
    if (!Array.isArray(entry.files) || !entry.files.some((file) => file.path === "plugin.json"))
      fail(`desktop file list ${directory}`)
    if (plugin.nodeRuntime) {
      const runtime = object(plugin.nodeRuntime, `desktop runtime ${directory}`)
      assertSetRelativePath(runtime.directory)
      assertSetRelativePath(runtime.entry)
      for (const required of [
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        runtime.entry,
      ]) {
        const relative = `${runtime.directory}/${required}`
        if (!entry.files.some((file) => file.path === relative))
          fail(`desktop runtime resource ${directory}/${relative}`)
      }
    }
    for (const field of contractCatalog?.pathFields ?? []) {
      if (field.path.startsWith("nodeRuntime.") || field.kind === "contained-only") continue
      const values = pathValues(plugin, field.path)
      if (field.requiredFor?.includes(plugin.type) && !values.length)
        fail(`desktop missing ${directory}/${field.path}`)
      for (const relative of values) {
        if (field.sentinels?.includes(relative)) continue
        assertSetRelativePath(relative)
        if (
          field.kind === "directory"
            ? !entry.files.some((file) => file.path.startsWith(`${relative}/`))
            : !entry.files.some((file) => file.path === relative)
        )
          fail(`desktop declared resource ${directory}/${relative}`)
      }
    }
    for (const file of entry.files) {
      assertSetRelativePath(file.path)
      const relative = `${directory}/${file.path}`,
        bytes = sections.desktopPlugins.get(relative)
      if (
        listedDesktop.has(relative) ||
        !bytes ||
        bytes.length !== file.bytes ||
        sha256(bytes) !== file.sha256
      )
        fail(`desktop file ${relative}`)
      listedDesktop.add(relative)
    }
  }
  sameKeys(
    Object.fromEntries([...sections.desktopPlugins.keys()].map((key) => [key, true])),
    [...listedDesktop],
    "desktop payload membership"
  )
  for (const relative of sections.pluginIcons.keys()) {
    if (!manifest.inventory.some((entry) => relative.startsWith(`${entry.id}/`)))
      fail(`unowned icon ${relative}`)
  }
  return manifest
}
