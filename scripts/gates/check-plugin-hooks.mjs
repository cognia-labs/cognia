#!/usr/bin/env node
/**
 * Static audit for plugin hook points: does every hook the contract calls
 * `implemented` actually have a fire site, and does every hook it calls
 * `virtual` actually lack one?
 *
 * Why this exists: `hookPointContracts` in
 * `lib/plugin/contracts/plugin-points.ts` is SYNTHESIZED — it maps every
 * canonical hook name through one object literal. Before `VIRTUAL_HOOK_POINTS`
 * landed, that literal hardcoded `status: "implemented"`, `stability:
 * "stable"` and a single shared `binding`, so all 139 hooks asserted they were
 * live and bound to `hooks-system.ts`. Ten of them were fired nowhere in the
 * repo. A plugin author registering `onScheduledTaskBeforeRun` got accepting
 * SDK types, a contract claiming stable+implemented, and a handler that never
 * ran. Nothing could catch it: the UI-slot audit covers `ui-slot` points only,
 * and no gate looked at hooks at all.
 *
 * The check is deliberately two-directional. Requiring only that implemented
 * hooks fire would let the dormancy label rot the other way — someone wires
 * `onScheduledTaskCreate` up properly and forgets to remove it from
 * `VIRTUAL_HOOK_POINTS`, and the contract keeps telling plugin authors the
 * hook is dead while it is quietly working.
 *
 * A "fire site" names the hook in the binding file or dispatches its canonical
 * interceptor point through the legacy normalizer mapping. That is a
 * weaker test than proving the call is reachable, but it is sufficient for the
 * defect this gate exists to catch: a hook name that appears nowhere in the
 * host cannot possibly fire.
 *
 * Usage:
 *   pnpm audit:hooks          # exit 0 if green, 1 if red
 *   pnpm audit:hooks --json   # machine-readable JSON to stdout
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import ts from "typescript"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const CONTRACT_FILE = "packages/plugin-contract/src/lib/plugin/contracts/plugin-points.ts"

/**
 * Parse the canonical hook list and the virtual set straight out of the
 * contract source. Importing the module instead would drag the whole plugin
 * runtime (and its `@/` aliases) into a plain `node` gate.
 */
export function parseContract(source) {
  const declarations = variableInitializers(source)
  const hooks = declarations.get("CANONICAL_HOOK_POINTS")
  const virtual = declarations.get("VIRTUAL_HOOK_POINTS")
  const binding = declarations.get("HOOK_POINT_BINDING")
  if (!hooks || !ts.isArrayLiteralExpression(hooks))
    throw new Error(`CANONICAL_HOOK_POINTS not found in ${CONTRACT_FILE}`)
  if (!virtual || !ts.isNewExpression(virtual))
    throw new Error(`VIRTUAL_HOOK_POINTS not found in ${CONTRACT_FILE}`)
  if (!binding || !ts.isStringLiteral(binding))
    throw new Error(`HOOK_POINT_BINDING not found in ${CONTRACT_FILE}`)
  const values = (array) =>
    array && ts.isArrayLiteralExpression(array)
      ? array.elements.filter(ts.isStringLiteral).map((element) => element.text)
      : []
  return { hooks: values(hooks), virtual: values(virtual.arguments?.[0]), binding: binding.text }
}

function variableInitializers(source) {
  const parsed = ts.createSourceFile("contract.ts", source, ts.ScriptTarget.Latest, true)
  const declarations = new Map()
  const unwrap = (node) =>
    node &&
    (ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isParenthesizedExpression(node))
      ? unwrap(node.expression)
      : node
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))
      declarations.set(node.name.text, unwrap(node.initializer))
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return declarations
}

/** A hook fires if the binding file mentions it as a whole word. */
export function hasFireSite(bindingSource, hook) {
  const source = ts.createSourceFile("binding.ts", bindingSource, ts.ScriptTarget.Latest, true)
  let found = false
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression
      if (ts.isPropertyAccessExpression(expression) && expression.name.text === hook) found = true
      if (ts.isIdentifier(expression) && expression.text === hook) found = true
      if (node.arguments.some((argument) => ts.isStringLiteral(argument) && argument.text === hook))
        found = true
      // Typed shared dispatchers forward a hook-name parameter to executeHook.
      for (const argument of node.arguments.filter(ts.isIdentifier)) {
        let parent = node.parent
        while (parent && !ts.isFunctionLike(parent)) parent = parent.parent
        const parameter = parent?.parameters.find((entry) => entry.name.getText() === argument.text)
        if (parameter?.type && parameter.type.getText().includes(`"${hook}"`)) found = true
      }
    }
    if (!found) ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

export function parseNormalizedHookPoints(source) {
  const initializer = variableInitializers(source).get("LEGACY_HOOK_POINTS")
  const object =
    initializer && ts.isCallExpression(initializer) ? initializer.arguments[0] : initializer
  if (!object || !ts.isObjectLiteralExpression(object))
    throw new Error("LEGACY_HOOK_POINTS not found in interceptor normalizer")
  return Object.fromEntries(
    object.properties.flatMap((property) =>
      ts.isPropertyAssignment(property) && ts.isStringLiteral(property.initializer)
        ? [[property.name.getText().replaceAll('"', ""), property.initializer.text]]
        : []
    )
  )
}

export function evaluate({ hooks, virtual, bindingSource, binding, normalizedHookPoints = {} }) {
  const virtualSet = new Set(virtual)
  const errors = []

  const unknownVirtual = virtual.filter((h) => !hooks.includes(h))
  for (const hook of unknownVirtual) {
    errors.push(
      `[virtual-unknown] "${hook}" is in VIRTUAL_HOOK_POINTS but is not a canonical hook point.`
    )
  }

  for (const hook of hooks) {
    const semanticPoint = normalizedHookPoints[hook]
    const fires =
      hasFireSite(bindingSource, hook) ||
      (semanticPoint !== undefined &&
        new RegExp(
          `dispatchTransform(?:<[^>]+>)?\\s*\\(\\s*["']${semanticPoint.replaceAll(".", "\\.")}["']`
        ).test(bindingSource))
    if (virtualSet.has(hook) && fires) {
      errors.push(
        `[virtual-but-fired] "${hook}" is marked virtual but ${binding} has a fire site for it. ` +
          `If the hook is wired now, remove it from VIRTUAL_HOOK_POINTS so the contract stops telling plugin authors it is dead.`
      )
    } else if (!virtualSet.has(hook) && !fires) {
      errors.push(
        `[implemented-never-fired] "${hook}" is contracted as implemented but ${binding} has no direct or normalized fire site for it, ` +
          `so a plugin handler registered for it can never run. Either fire it, or add it to VIRTUAL_HOOK_POINTS.`
      )
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    total: hooks.length,
    virtual: virtual.filter((h) => hooks.includes(h)).length,
  }
}

export function runAudit(repoRoot = REPO_ROOT) {
  const source = readFileSync(join(repoRoot, CONTRACT_FILE), "utf8")
  const { hooks, virtual, binding } = parseContract(source)
  const bindingSource = readFileSync(join(repoRoot, binding), "utf8")
  const normalizedHookPoints = parseNormalizedHookPoints(
    readFileSync(
      join(repoRoot, "packages/plugin-contract/src/lib/plugin/interceptors/normalize.ts"),
      "utf8"
    )
  )
  return evaluate({ hooks, virtual, bindingSource, binding, normalizedHookPoints })
}

function main() {
  const report = runAudit()
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2))
  } else if (report.ok) {
    console.log(
      `[plugin-hooks] PASS — ${report.total} hook points (${report.virtual} virtual, ${report.total - report.virtual} fired).`
    )
  } else {
    console.error(`[plugin-hooks] FAIL — ${report.errors.length} problem(s):`)
    for (const err of report.errors) console.error(`  ${err}`)
  }
  process.exit(report.ok ? 0 : 1)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
