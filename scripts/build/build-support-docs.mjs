#!/usr/bin/env node
/** Verify the versioned, offline documentation corpus published by cognia-docs. */
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const REPOSITORY = "cognia-labs/cognia-docs"
export const CORPUS_PATH = "lib/support-agent/support-docs.generated.json"
export const PAGES_PATH = "integrations/cognia-docs-pages.json"
export const PIN_PATH = "integrations/cognia-docs.json"
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")

export function validateCorpus(bytes) {
  const corpus = JSON.parse(bytes.toString())
  if (corpus.schemaVersion !== 1) throw new Error("Unsupported documentation corpus schema")
  for (const locale of ["en", "zh"]) {
    const entries = corpus.locales?.[locale]
    if (!Array.isArray(entries) || entries.length === 0) throw new Error(`Empty ${locale} corpus`)
    const paths = new Set()
    for (const entry of entries) {
      if (typeof entry.path !== "string" || !/^[a-zA-Z0-9_./-]+\.mdx?$/.test(entry.path) || entry.path.startsWith("/") || entry.path.split("/").some((part) => !part || part === "." || part === "..") || typeof entry.title !== "string" || typeof entry.text !== "string" || paths.has(entry.path)) {
        throw new Error(`Invalid ${locale} corpus entry`)
      }
      paths.add(entry.path)
    }
  }
  return corpus
}

export function validatePages(bytes) {
  const pages = JSON.parse(bytes.toString())
  if (pages.schemaVersion !== 1 || !Array.isArray(pages.urls) || !pages.urls.includes("/en/docs") || !pages.urls.includes("/zh/docs") || new Set(pages.urls).size !== pages.urls.length || pages.urls.some((url) => typeof url !== "string" || !/^\/(en|zh)\/docs(?:\/[a-zA-Z0-9_.-]+)*$/.test(url))) throw new Error("Invalid documentation page index")
  return pages
}

export function verifyPinnedCorpus(root = ROOT, docsRoot, runGit = execFileSync) {
  const pin = JSON.parse(readFileSync(resolve(root, PIN_PATH), "utf8"))
  if (pin.repository !== REPOSITORY || !/^[a-f0-9]{40}$/.test(pin.revision ?? "") || !/^[a-f0-9]{64}$/.test(pin.corpusSha256 ?? "") || !/^[a-f0-9]{64}$/.test(pin.pagesSha256 ?? "")) {
    throw new Error(`${PIN_PATH} must contain the pinned docs repository, revision and corpus SHA-256`)
  }
  const bytes = readFileSync(resolve(root, CORPUS_PATH))
  if (sha256(bytes) !== pin.corpusSha256) throw new Error("Documentation corpus SHA-256 does not match its pin; run pnpm docs:sync --docs-root <checkout>")
  const corpus = validateCorpus(bytes)
  const pageBytes = readFileSync(resolve(root, PAGES_PATH))
  if (sha256(pageBytes) !== pin.pagesSha256) throw new Error("Documentation page index SHA-256 does not match its pin")
  const pages = validatePages(pageBytes)
  if (docsRoot) {
    let revision, published, publishedPages
    try {
      revision = runGit("git", ["-C", resolve(docsRoot), "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
      published = runGit("git", ["-C", resolve(docsRoot), "show", `${revision}:artifacts/support-docs.json`], { maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] })
      publishedPages = runGit("git", ["-C", resolve(docsRoot), "show", `${revision}:artifacts/doc-pages.json`], { maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] })
    } catch (cause) {
      throw new Error("The docs checkout must contain a committed publication artifact", { cause })
    }
    if (revision !== pin.revision || !published.equals(bytes) || !publishedPages.equals(pageBytes)) throw new Error("The pinned docs checkout or published corpus differs from the application copy")
  }
  return { pin, corpus, pages }
}

export function parseArgs(args) {
  let check = false, docsRoot
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--check") check = true
    else if (args[i] === "--docs-root") {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error("--docs-root requires a path")
      docsRoot = args[++i]
    } else throw new Error(`unknown option: ${args[i]}`)
  }
  return { check, docsRoot }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = parseArgs(process.argv.slice(2))
  const { pin, corpus } = verifyPinnedCorpus(ROOT, args.docsRoot)
  console.log(`[support-docs] verified ${pin.repository}@${pin.revision}: en=${corpus.locales.en.length}, zh=${corpus.locales.zh.length}`)
}
