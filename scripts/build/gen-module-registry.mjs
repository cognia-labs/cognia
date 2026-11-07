#!/usr/bin/env node
/**
 * Generate the feature module registries (ADR-0250 §14).
 *
 * Reads every `lib/<id>/module.ts` and `components/<id>/module.ui.ts` and
 * writes `lib/modules/generated/host.ts`, one runtime registry per host
 * (`lib/modules/generated/{brain,desktop,mobile}.ts`), the prompt catalog's
 * registry (`lib/modules/generated/prompts.ts`), the send resolver's
 * (`lib/modules/generated/capabilities.ts`) and
 * `components/modules/generated/ui.ts` (see
 * `scripts/gates/lib/module-manifests.mjs` for their shape). Both files
 * are gitignored, so every entry point that compiles the app runs this first:
 * postinstall, predev, prebuild, prestorybook, `scripts/test/jest.mjs`,
 * `scripts/gates/typecheck-root.mjs` and the CLI builds (which the brain's
 * Docker image runs). A manifest that is not data stops the generator; the
 * module gate (`pnpm audit:modules`) explains the same errors with more context.
 *
 * Files are rewritten only when their content changes, so a dev server does not
 * rebuild on every run.
 *
 * Usage:
 *   node scripts/build/gen-module-registry.mjs           # write
 *   node scripts/build/gen-module-registry.mjs --check   # exit 1 when stale
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { createContext } from "../gates/convergence/counter.mjs"
import {
  findManifestFiles,
  manifestKind,
  readManifest,
  renderRegistries,
  validateHostManifest,
  validateUiManifest,
} from "../gates/lib/module-manifests.mjs"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

/** The registries `root`'s manifests produce, or the errors that stop them. */
export function computeModuleRegistries(root = REPO_ROOT) {
  const ctx = createContext(root)
  const errors = []
  const host = []
  const ui = []
  for (const file of findManifestFiles(ctx.root)) {
    const kind = manifestKind(file)
    const { value, errors: readErrors } = readManifest(ctx, file, kind.helper)
    const shapeErrors =
      value === undefined
        ? []
        : kind.layer === "host"
          ? validateHostManifest(value, kind.id)
          : validateUiManifest(value, kind.id)
    for (const error of [...readErrors, ...shapeErrors]) errors.push(`${file}: ${error}`)
    ;(kind.layer === "host" ? host : ui).push({ id: kind.id, file, value })
  }
  return { errors, files: renderRegistries({ host, ui }) }
}

/**
 * Write (or, with `check`, compare) the registries. Returns the paths that were
 * stale and the manifest errors; `ok` is false when either list is non-empty
 * in check mode, or when there are errors.
 */
export function generateModuleRegistries({ root = REPO_ROOT, check = false } = {}) {
  root = resolve(root)
  // A partial checkout (the brain image installs dependencies before copying
  // the source) has no modules yet; the CLI build generates after the copy.
  if (!existsSync(join(root, "lib/modules/define.ts")))
    return { ok: true, skipped: true, stale: [], errors: [] }
  const { errors, files } = computeModuleRegistries(root)
  if (errors.length) return { ok: false, skipped: false, stale: [], errors }
  const stale = []
  for (const [file, content] of Object.entries(files)) {
    const path = join(root, file)
    const current = existsSync(path) ? readFileSync(path, "utf8") : null
    if (current === content) continue
    stale.push(file)
    if (check) continue
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  return { ok: !check || stale.length === 0, skipped: false, stale, errors }
}

/**
 * For entry points that compile the app (Jest, typecheck, the CLI builds):
 * write the registries, or throw with the manifest errors.
 */
export function ensureModuleRegistries(root = REPO_ROOT) {
  const result = generateModuleRegistries({ root })
  if (result.errors.length)
    throw new Error(
      `Feature module manifests are not data (run \`pnpm audit:modules\`):\n${result.errors
        .map((error) => `  ${error}`)
        .join("\n")}`
    )
  return result
}

export function main(argv = process.argv.slice(2), output = console) {
  const check = argv.includes("--check")
  const unknown = argv.filter((arg) => arg !== "--check")
  if (unknown.length) {
    output.error(`gen-module-registry: unknown argument ${unknown[0]}`)
    return 2
  }
  const result = generateModuleRegistries({ check })
  for (const error of result.errors) output.error(`  ${error}`)
  if (result.errors.length) {
    output.error(
      `gen-module-registry: ${result.errors.length} manifest error(s); run \`pnpm audit:modules\` for details`
    )
    return 1
  }
  if (check && result.stale.length) {
    output.error(
      `gen-module-registry: stale ${result.stale.join(", ")} — run node scripts/build/gen-module-registry.mjs`
    )
    return 1
  }
  if (!check && result.stale.length) output.log(`gen-module-registry: wrote ${result.stale.join(", ")}`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main()
