#!/usr/bin/env node
// ADR-0233: record the image actually published by the existing Images workflow,
// pin it into signed builds (amendment A2) and refuse drift between the pin and
// the guest sources it was built from.
// This script never builds, resolves tags, pushes an image or contacts E2B.

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const IMAGE_CONTEXT = "crates/cognia-automation/src/cua_sandbox/image"

export const RELEASE_FILE = "managed-desktop-release.json"
export const SOURCE_FILE = "managed-desktop-release.source.json"
/** Bundled by Tauri (`tauri.conf.json`) and copied into the server image. */
export const PINNED_RELEASE_DIR = "src-tauri/resources/managed-desktop"
/**
 * What the published image is built from: its context files, the importer it
 * copies in, and the guest binary's crate plus the confinement crate it links.
 * `cognia-net` is left out on purpose: it changes for unrelated network work,
 * and Host/guest compatibility is still pinned by recipe and protocol.
 */
export const SOURCE_INPUTS = Object.freeze([
  ...["Dockerfile", "entrypoint.sh", "startup.py", "server.py", "menu.xml"].map(
    (name) => `${IMAGE_CONTEXT}/${name}`
  ),
  "crates/cognia-automation/src/cua_sandbox/managed/handoff_guest.py",
  "crates/cognia-desktop-guest",
  "crates/cognia-exec-sandbox",
])

export const RELEASE_IDENTITY = Object.freeze({
  architecture: "linux/amd64",
  recipeRevision: "7",
  protocol: "computer-server-0.3.46",
  serverVersion: "0.3.46",
  // Template snapshots must never contain a runtime guest token. The Host
  // starts the authenticated desktop over protected envd after create.
  startCommand: "sleep infinity",
  readyCommand:
    "test -x /usr/local/bin/cognia-desktop && test -f /opt/cognia-desktop/server.py && test -f /opt/cognia-desktop/startup.py && test -x /usr/bin/git && test -x /usr/bin/node && test -x /usr/bin/npm && test -x /usr/bin/bwrap && test -x /usr/local/bin/cognia-desktop-guest && test -f /opt/cognia-desktop/handoff-import.py",
})

export function createManagedDesktopRelease({ imageRepository, digest }) {
  if (
    typeof imageRepository !== "string" ||
    !/^ghcr\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*\/cognia-managed-desktop$/.test(imageRepository)
  ) {
    throw new Error("Expected an untagged ghcr.io/<owner>/cognia-managed-desktop repository")
  }
  if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error("A complete sha256 digest from the published image build is required")
  }
  return {
    image: `${imageRepository}@${digest}`,
    imageDigest: digest,
    ...RELEASE_IDENTITY,
  }
}

/** Tracked files only, so local build output and scratch files never count. */
export function sourceFiles(root = ROOT) {
  const listed = execFileSync("git", ["-C", root, "ls-files", "-z", "--", ...SOURCE_INPUTS], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
  const files = listed.split("\0").filter(Boolean).sort()
  if (files.length === 0) throw new Error("No managed desktop guest sources are tracked")
  return files
}

/** One digest over every input's path and content hash, in path order. */
export function computeSourceDigest(root = ROOT) {
  const files = sourceFiles(root)
  const digest = createHash("sha256")
  for (const file of files) {
    const content = createHash("sha256").update(readFileSync(join(root, file))).digest("hex")
    digest.update(`${file}\0${content}\n`)
  }
  return { sourceDigest: `sha256:${digest.digest("hex")}`, files: files.length }
}

function sourceRecord(release, root) {
  return {
    version: 1,
    imageDigest: release.imageDigest,
    recipeRevision: release.recipeRevision,
    ...computeSourceDigest(root),
  }
}

/** The exact shape `createManagedDesktopRelease` produces, and nothing else. */
export function validateRelease(release) {
  if (!release || typeof release !== "object" || Array.isArray(release)) {
    throw new Error("The managed desktop release must be an object")
  }
  const repository = String(release.image ?? "").split("@")[0]
  const expected = createManagedDesktopRelease({
    imageRepository: repository,
    digest: release.imageDigest,
  })
  if (JSON.stringify(release) !== JSON.stringify(expected)) {
    throw new Error("The managed desktop release does not match this build's release identity")
  }
  return expected
}

function writeAtomically(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const partial = `${path}.${process.pid}.partial`
  try {
    writeFileSync(partial, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o644 })
    renameSync(partial, path)
  } finally {
    rmSync(partial, { force: true })
  }
}

/**
 * Pin a published release (the Images workflow artifact) into the tree. The
 * artifact's guest sources must be exactly the current ones; otherwise the
 * image was built from other code and a new publication is required.
 */
export function pinRelease(artifactDir, root = ROOT) {
  const release = validateRelease(JSON.parse(readFileSync(join(artifactDir, RELEASE_FILE), "utf8")))
  const source = JSON.parse(readFileSync(join(artifactDir, SOURCE_FILE), "utf8"))
  const current = sourceRecord(release, root)
  if (JSON.stringify(source) !== JSON.stringify(current)) {
    throw new Error(
      "The published image was built from other guest sources; publish the managed desktop image again from this revision"
    )
  }
  verifyImageSources(root)
  writeAtomically(join(root, PINNED_RELEASE_DIR, RELEASE_FILE), release)
  writeAtomically(join(root, PINNED_RELEASE_DIR, SOURCE_FILE), current)
  return release
}

/**
 * The drift gate. No pin means managed desktops stay dormant, which is valid.
 * A pin must be a valid release whose recorded guest sources are the tree's.
 */
export function checkPinnedRelease(root = ROOT) {
  const releasePath = join(root, PINNED_RELEASE_DIR, RELEASE_FILE)
  const sourcePath = join(root, PINNED_RELEASE_DIR, SOURCE_FILE)
  const pinned = existsSync(releasePath)
  if (!pinned && !existsSync(sourcePath)) return { state: "absent" }
  if (!pinned || !existsSync(sourcePath)) {
    throw new Error(`Pin ${RELEASE_FILE} and ${SOURCE_FILE} together`)
  }
  const release = validateRelease(JSON.parse(readFileSync(releasePath, "utf8")))
  verifyImageSources(root)
  const recorded = JSON.parse(readFileSync(sourcePath, "utf8"))
  const current = sourceRecord(release, root)
  if (JSON.stringify(recorded) !== JSON.stringify(current)) {
    throw new Error(
      `Managed desktop guest sources changed since ${release.imageDigest} was published (recorded ${recorded.sourceDigest}, now ${current.sourceDigest}). Publish the image again and re-pin it.`
    )
  }
  return { state: "pinned", release }
}

export function verifyImageSources(root = ROOT) {
  const dockerfile = readFileSync(resolve(root, IMAGE_CONTEXT, "Dockerfile"), "utf8")
  const server = readFileSync(resolve(root, IMAGE_CONTEXT, "server.py"), "utf8")
  if (!/^FROM \S+@sha256:[0-9a-f]{64}$/m.test(dockerfile)) {
    throw new Error("Managed desktop base image must remain digest pinned")
  }
  if (
    !dockerfile.includes(`'cua-computer-server[linux]==${RELEASE_IDENTITY.serverVersion}'`) ||
    !dockerfile.includes(`cognia.cua.protocol="${RELEASE_IDENTITY.protocol}"`) ||
    !dockerfile.includes(`cognia.cua.recipe="${RELEASE_IDENTITY.recipeRevision}"`)
  ) {
    throw new Error("Release identity does not match the desktop image recipe")
  }
  if (!dockerfile.includes("dpkg-query -W git nodejs npm")) {
    throw new Error("Managed desktop handoff image must verify git, nodejs and npm")
  }
  for (const key of ["protocol", "recipeRevision", "serverVersion"]) {
    if (!server.includes(`"${key}": "${RELEASE_IDENTITY[key]}"`)) {
      throw new Error(`Release ${key} does not match the authenticated guest health identity`)
    }
  }
}

export function parseArgs(args) {
  const values = {}
  const names = { "--image": "imageRepository", "--digest": "digest", "--output": "output" }
  for (let index = 0; index < args.length; index += 2) {
    const name = names[args[index]]
    const value = args[index + 1]
    if (!name || name in values || !value || value.startsWith("--")) {
      throw new Error(
        "Usage: managed-desktop-release.mjs --image <repository> --digest <sha256> --output <file>"
      )
    }
    values[name] = value
  }
  if (Object.keys(values).length !== 3) {
    throw new Error("Image repository, published digest and output file are required")
  }
  return values
}

/** The Images workflow's step: the manifest plus the sources it was built from. */
export function writeRelease(args, root = ROOT) {
  const { output, ...input } = parseArgs(args)
  const release = createManagedDesktopRelease(input)
  verifyImageSources(root)
  const path = resolve(output)
  const source = sourceRecord(release, root)
  writeAtomically(path, release)
  writeAtomically(join(dirname(path), SOURCE_FILE), source)
  return release
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, value] = process.argv.slice(2)
    if (mode === "--check-pin") {
      const result = checkPinnedRelease()
      console.log(
        result.state === "pinned"
          ? `Managed desktop release pinned: ${result.release.image}`
          : "No managed desktop release is pinned; managed desktops stay dormant in this build."
      )
    } else if (mode === "--pin" && value) {
      const release = pinRelease(resolve(value))
      console.log(`Pinned managed desktop release: ${release.image}`)
    } else {
      const release = writeRelease(process.argv.slice(2))
      console.log(`Managed desktop release: ${release.image}`)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
