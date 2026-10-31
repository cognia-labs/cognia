#!/usr/bin/env node
/** Runs before pnpm install. This transport uses only Node built-ins. */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")
const safePath = (relative) => {
  if (
    typeof relative !== "string" ||
    !relative ||
    relative.includes("\\") ||
    relative.includes("\0") ||
    relative.split("/").some((part) => !part || part === "." || part === "..") ||
    relative.startsWith("/") ||
    /^[a-z]+:/i.test(relative)
  )
    throw new Error(`Unsafe authoring kit path: ${relative}`)
  return relative
}

export function verifyAuthoringKitFiles(directory, expected) {
  const bytes = fs.readFileSync(path.join(directory, "authoring-kit.json"))
  if (digest(bytes) !== expected) throw new Error("Authoring kit manifest digest mismatch")
  const manifest = JSON.parse(bytes)
  if (
    manifest.schema !== 1 ||
    !manifest.files ||
    Array.isArray(manifest.files) ||
    !Array.isArray(manifest.packages)
  )
    throw new Error("Invalid authoring kit manifest")
  const realRoot = fs.realpathSync(directory)
  for (const [relative, hash] of Object.entries(manifest.files)) {
    safePath(relative)
    const file = path.join(directory, relative)
    let ancestor = directory
    for (const part of relative.split("/")) {
      ancestor = path.join(ancestor, part)
      if (fs.lstatSync(ancestor).isSymbolicLink())
        throw new Error(`Symlink in authoring kit: ${relative}`)
    }
    if (
      !fs.realpathSync(file).startsWith(`${realRoot}${path.sep}`) ||
      !/^[a-f0-9]{64}$/.test(hash) ||
      digest(fs.readFileSync(file)) !== hash
    )
      throw new Error(`Authoring kit file digest/path mismatch: ${relative}`)
  }
  for (const entry of manifest.packages)
    if (!manifest.files[safePath(entry.file)])
      throw new Error(`Unlisted authoring package: ${entry.file}`)
  return manifest
}

export function readAuthoringKit(directory, expectedSha256) {
  const kitSha256 = digest(fs.readFileSync(path.join(directory, "authoring-kit.json")))
  const manifest = verifyAuthoringKitFiles(directory, expectedSha256 ?? kitSha256)
  const read = (file) => JSON.parse(fs.readFileSync(path.join(directory, "contract", file), "utf8"))
  return {
    manifest,
    authoring: { ...manifest.authoring, kitSha256 },
    contractCatalog: read("catalog.json"),
    styleContract: read("style.json"),
    compilerContract: read("compiler.json"),
    profile: read("product-profile.json"),
  }
}

/** A matching package version alone cannot identify a different kit revision. */
export function verifyInstalledAuthoringPackages(root, manifest) {
  const require = createRequire(path.join(root, "package.json"))
  const realRoot = fs.realpathSync(root)
  for (const entry of manifest.packages) {
    let directory = path.dirname(require.resolve(entry.name))
    while (
      path.dirname(directory) !== directory &&
      (!fs.existsSync(path.join(directory, "package.json")) ||
        JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")).name !==
          entry.name)
    )
      directory = path.dirname(directory)
    if (
      !fs.realpathSync(directory).startsWith(`${realRoot}${path.sep}`) ||
      !entry.files ||
      Array.isArray(entry.files)
    )
      throw new Error(`Authoring package is not installed from the selected kit: ${entry.name}`)
    for (const [relative, expected] of Object.entries(entry.files)) {
      safePath(relative)
      const file = path.join(directory, relative)
      if (
        !fs.realpathSync(file).startsWith(`${fs.realpathSync(directory)}${path.sep}`) ||
        digest(fs.readFileSync(file)) !== expected
      )
        throw new Error(`Authoring package differs from selected kit: ${entry.name}/${relative}`)
    }
  }
}

async function download(url, fetchImpl) {
  const source = new URL(url)
  if (source.protocol === "file:") return fs.readFileSync(source)
  if (source.protocol !== "https:")
    throw new Error("Authoring kit transport requires HTTPS or an explicit local file URL")
  const response = await fetchImpl(source, { signal: AbortSignal.timeout(60000) })
  if (!response.ok)
    throw new Error(`Authoring kit download failed (${response.status}): ${source.pathname}`)
  return Buffer.from(await response.arrayBuffer())
}

export async function bootstrapAuthoringKit({ pinFile, target, fetchImpl = fetch } = {}) {
  const pin = JSON.parse(fs.readFileSync(pinFile, "utf8"))
  if (pin.schema !== 1 || !/^[a-f0-9]{64}$/.test(pin.sha256 ?? "") || typeof pin.url !== "string")
    throw new Error("Invalid authoring kit pin")
  target = path.resolve(target)
  if (fs.existsSync(target)) {
    if (!fs.existsSync(path.join(target, "authoring-kit.json")))
      throw new Error("Refusing to replace an unowned authoring kit directory")
    try {
      return { manifest: verifyAuthoringKitFiles(target, pin.sha256), cached: true }
    } catch {
      /* Replace only after a new complete kit verifies. */
    }
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const staged = fs.mkdtempSync(`${target}.download-`),
    backup = `${staged}.previous`
  let backedUp = false
  try {
    const bytes = await download(pin.url, fetchImpl)
    if (digest(bytes) !== pin.sha256) throw new Error("Authoring kit manifest digest mismatch")
    const manifest = JSON.parse(bytes)
    if (manifest.schema !== 1 || !manifest.files || Array.isArray(manifest.files))
      throw new Error("Invalid authoring kit manifest")
    fs.writeFileSync(path.join(staged, "authoring-kit.json"), bytes)
    for (const [relative, expected] of Object.entries(manifest.files)) {
      safePath(relative)
      const content = await download(
        new URL(relative.split("/").map(encodeURIComponent).join("/"), pin.url),
        fetchImpl
      )
      if (digest(content) !== expected)
        throw new Error(`Authoring kit file digest mismatch: ${relative}`)
      const output = path.join(staged, relative)
      fs.mkdirSync(path.dirname(output), { recursive: true })
      fs.writeFileSync(output, content)
    }
    verifyAuthoringKitFiles(staged, pin.sha256)
    if (fs.existsSync(target)) {
      fs.renameSync(target, backup)
      backedUp = true
    }
    fs.renameSync(staged, target)
    if (backedUp) fs.rmSync(backup, { recursive: true, force: true })
    return { manifest, cached: false }
  } catch (error) {
    if (backedUp && !fs.existsSync(target)) fs.renameSync(backup, target)
    throw error
  } finally {
    fs.rmSync(staged, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , pinFile = "authoring-kit.lock.json", target = ".vendor/authoring-kit"] = process.argv
  const { cached } = await bootstrapAuthoringKit({ pinFile, target })
  console.log(`[authoring-kit] ${cached ? "verified cache" : "downloaded and verified"}: ${target}`)
}
