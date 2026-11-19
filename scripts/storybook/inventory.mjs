#!/usr/bin/env node
// Source inventory, not a test/visual coverage gate. Keep in sync with main.ts's
// components/**/*.stories.@(tsx|ts) and .storybook/*.mdx discovery scope.
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

function walk(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, "en"))
    .flatMap((entry) => {
      const file = join(dir, entry.name)
      return entry.isDirectory() ? walk(file) : entry.isFile() ? [file] : []
    })
}

function inspectStory(file, root) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
  const variables = new Map()
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        variables.set(declaration.name.text, declaration.initializer)
      }
    }
  }
  function unwrap(node, seen = new Set()) {
    if (!node || seen.has(node)) return undefined
    seen.add(node)
    if (ts.isIdentifier(node)) return unwrap(variables.get(node.text), seen)
    if (
      ts.isSatisfiesExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isParenthesizedExpression(node)
    ) {
      return unwrap(node.expression, seen)
    }
    return node
  }
  function property(node, name) {
    const object = unwrap(node)
    if (!object || !ts.isObjectLiteralExpression(object)) return undefined
    const prop = object.properties.find(
      (p) => p.name?.getText(source).replace(/["']/g, "") === name
    )
    if (!prop) return undefined
    if (ts.isShorthandPropertyAssignment(prop)) return variables.get(prop.name.text)
    return ts.isPropertyAssignment(prop) ? prop.initializer : prop
  }
  function text(node) {
    const value = unwrap(node)
    return value && ts.isStringLiteralLike(value) ? value.text : undefined
  }
  function strings(node) {
    const value = unwrap(node)
    return value && ts.isArrayLiteralExpression(value)
      ? value.elements.map(text).filter(Boolean)
      : []
  }
  function matches(node, name, fallback) {
    const value = unwrap(node)
    if (!value) return fallback
    if (ts.isArrayLiteralExpression(value)) return strings(value).includes(name)
    if (ts.isRegularExpressionLiteral(value)) {
      const end = value.text.lastIndexOf("/")
      return new RegExp(value.text.slice(1, end), value.text.slice(end + 1)).test(name)
    }
    return fallback
  }
  const defaultExport = source.statements.find(ts.isExportAssignment)
  const meta = unwrap(defaultExport?.expression)
  const metaResolved = Boolean(meta && ts.isObjectLiteralExpression(meta))
  const exports = source.statements
    .filter(
      (statement) =>
        ts.isVariableStatement(statement) &&
        statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    )
    .flatMap((statement) => statement.declarationList.declarations)
    .filter((declaration) => ts.isIdentifier(declaration.name))
    .filter(
      ({ name }) =>
        matches(property(meta, "includeStories"), name.text, true) &&
        !matches(property(meta, "excludeStories"), name.text, false)
    )
  const docsDescription = (node, kind) =>
    Boolean(
      text(property(property(property(property(node, "parameters"), "docs"), "description"), kind))
    )
  const metaTags = strings(property(meta, "tags"))
  const hasAutodocs = (node) => {
    const tags = strings(property(node, "tags"))
    return (
      (metaTags.includes("autodocs") || tags.includes("autodocs")) &&
      !metaTags.includes("!autodocs") &&
      !tags.includes("!autodocs")
    )
  }
  return {
    path: relative(root, file).replaceAll("\\", "/"),
    title: text(property(meta, "title")) ?? null,
    metaResolved,
    exports: exports.map(({ name }) => name.text),
    componentDescription: docsDescription(meta, "component"),
    storyDescriptions: exports.filter(({ initializer }) => docsDescription(initializer, "story"))
      .length,
    argTypes: Boolean(property(meta, "argTypes")),
    autodocs: exports.some(({ initializer }) => hasAutodocs(initializer)),
    playExports: exports.filter(({ initializer }) => property(initializer, "play")).length,
    beforeEach: Boolean(property(meta, "beforeEach")),
  }
}

export function collectInventory(root = ROOT) {
  const allFiles = walk(join(root, "components")).filter(
    (file) => !/[\\/]__(mocks|tests)__[\\/]/.test(file)
  )
  const files = allFiles.filter((p) => /\.stories\.tsx?$/.test(p)).map((p) => inspectStory(p, root))
  const candidates = allFiles.filter(
    (p) => /\.tsx$/.test(p) && !/\.(stories|test|spec|d)\.tsx$/.test(p)
  )
  const storyStems = new Set(files.map((f) => f.path.replace(/\.stories\.tsx?$/, "")))
  const areas = new Map()
  function areaFor(file) {
    const parts = file.split("/")
    const area = parts.length > 2 ? parts[1] : "(root)"
    if (!areas.has(area)) {
      areas.set(area, {
        area,
        candidateTsxModules: 0,
        storyFiles: 0,
        storyExports: 0,
        missingSameStem: [],
      })
    }
    return areas.get(area)
  }
  let sameStemStories = 0
  for (const candidate of candidates) {
    const file = relative(root, candidate).replaceAll("\\", "/")
    const area = areaFor(file)
    area.candidateTsxModules++
    if (storyStems.has(file.replace(/\.tsx$/, ""))) sameStemStories++
    else area.missingSameStem.push(file)
  }
  for (const file of files) {
    const area = areaFor(file.path)
    area.storyFiles++
    area.storyExports += file.exports.length
  }
  return {
    scope:
      "components/**/*.stories.{ts,tsx}; candidate modules: non-test/story components/**/*.tsx",
    limitations: [
      "Static local object metadata only; no execution, inherited preview tags, imported meta, spreads, re-exports or CSF factories.",
      "Named variable exports honor static includeStories/excludeStories; validate actual entries against the running index.json.",
      "Missing same-stem stories are triage candidates, including providers, wrappers and non-visual modules; not missing-feature or coverage counts.",
      "play presence does not imply assertions, runner execution, accessibility or screenshot regression coverage.",
    ],
    totals: {
      storyFiles: files.length,
      storyExports: files.reduce((n, f) => n + f.exports.length, 0),
      componentDescriptions: files.filter((f) => f.componentDescription).length,
      storyDescriptions: files.reduce((n, f) => n + f.storyDescriptions, 0),
      argTypesFiles: files.filter((f) => f.argTypes).length,
      autodocsFiles: files.filter((f) => f.autodocs).length,
      playExports: files.reduce((n, f) => n + f.playExports, 0),
      beforeEachFiles: files.filter((f) => f.beforeEach).length,
      candidateTsxModules: candidates.length,
      sameStemStories,
    },
    mdxFiles: walk(join(root, ".storybook"))
      .filter((p) => dirname(p) === join(root, ".storybook") && p.endsWith(".mdx"))
      .map((p) => relative(root, p).replaceAll("\\", "/")),
    unresolvedMeta: files.filter((f) => !f.metaResolved).map((f) => f.path),
    areas: [...areas.values()].sort((a, b) => a.area.localeCompare(b.area, "en")),
    files,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inventory = collectInventory()
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`)
  } else {
    console.log(JSON.stringify(inventory.totals, null, 2))
    console.log("\narea\tstory files\tcandidate TSX modules\tmissing same-stem")
    for (const area of inventory.areas) {
      console.log(
        `${area.area}\t${area.storyFiles}\t${area.candidateTsxModules}\t${area.missingSameStem.length}`
      )
    }
    console.log(`\nUnresolved metadata: ${inventory.unresolvedMeta.length}`)
    console.log(inventory.limitations.join("\n"))
  }
}
