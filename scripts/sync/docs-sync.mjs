#!/usr/bin/env node
/** Explicitly import a committed documentation corpus; normal builds never fetch it. */
import { execFileSync } from "node:child_process"
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  CORPUS_PATH,
  PAGES_PATH,
  PIN_PATH,
  REPOSITORY,
  sha256,
  validateCorpus,
  validatePages,
} from "../build/build-support-docs.mjs"

export function syncDocs(root, docsRoot, runGit = execFileSync) {
  const source = resolve(docsRoot)
  const revision = runGit("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  const bytes = runGit("git", ["-C", source, "show", `${revision}:artifacts/support-docs.json`], {
    maxBuffer: 32 * 1024 * 1024,
  })
  const pages = runGit("git", ["-C", source, "show", `${revision}:artifacts/doc-pages.json`], {
    maxBuffer: 32 * 1024 * 1024,
  })
  validateCorpus(bytes)
  validatePages(pages)
  const pin = {
    repository: REPOSITORY,
    revision,
    corpusSha256: sha256(bytes),
    pagesSha256: sha256(pages),
  }
  const outputs = [
    [CORPUS_PATH, bytes],
    [PAGES_PATH, pages],
    [PIN_PATH, JSON.stringify(pin, null, 2) + "\n"],
  ]
  const pending = []
  try {
    for (const [relative, content] of outputs) {
      const target = resolve(root, relative)
      mkdirSync(dirname(target), { recursive: true })
      const temporary = `${target}.tmp-${process.pid}`
      pending.push([temporary, target])
      writeFileSync(temporary, content, { flag: "wx" })
    }
    for (const [temporary, target] of pending) renameSync(temporary, target)
  } finally {
    for (const [temporary] of pending) rmSync(temporary, { force: true })
  }
  return pin
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== "--docs-root")
    throw new Error("Usage: pnpm docs:sync --docs-root <committed cognia-docs checkout>")
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
  const pin = syncDocs(root, args[1])
  console.log(`[docs-sync] imported ${pin.repository}@${pin.revision}`)
}
