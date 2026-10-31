/** Compile package-owned utility CSS using an explicit, portable Host style contract. */
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"

const require = createRequire(import.meta.url)
const cssRequire = createRequire(require.resolve("@tailwindcss/postcss"))
const postcss = cssRequire("postcss")
const { Scanner } = cssRequire("@tailwindcss/oxide")
const { compile } = await import(pathToFileURL(cssRequire.resolve("@tailwindcss/node")))

export function createPluginStyleContract(root) {
  const file = path.join(root, "app/globals.css")
  const sheet = postcss.parse(fs.readFileSync(file, "utf8"))
  const definitions = sheet.nodes
    .filter((node) => node.type === "atrule" && ["theme", "custom-variant"].includes(node.name))
    .map((node) => `${node.toString()}${node.nodes ? "" : ";"}`)
  const hostVariables = new Set()
  sheet.walkDecls((declaration) => {
    if (declaration.prop.startsWith("--")) hostVariables.add(declaration.prop)
  })
  return {
    schema: 1,
    css: definitions.join("\n"),
    hostVariables: [...hostVariables].sort(),
    inputs: [file],
  }
}

export async function compilePluginUtilityCss({ root, javascript, contract }) {
  if (
    contract?.schema !== 1 ||
    typeof contract.css !== "string" ||
    !Array.isArray(contract.hostVariables)
  )
    throw new Error("A valid plugin style contract is required")
  const inputs = []
  const compiler = await compile(
    [
      `@import ${JSON.stringify(cssRequire.resolve("tailwindcss/theme.css"))} layer(theme);`,
      `@import ${JSON.stringify(cssRequire.resolve("tailwindcss/utilities.css"))} layer(utilities);`,
      contract.css,
    ].join("\n"),
    {
      base: root,
      onDependency(file) {
        inputs.push(file)
      },
    }
  )
  const candidates = new Scanner({ sources: [] }).scanFiles([
    { content: javascript, extension: "js" },
  ])
  const sheet = postcss.parse(compiler.build(candidates))
  let hasUtilities = false
  const defaults = new Map(),
    inherited = new Set(contract.hostVariables)
  sheet.walkRules((rule) => {
    if (
      rule.selector.split(",").every((selector) => [":root", ":host"].includes(selector.trim()))
    ) {
      rule.walkDecls((declaration) => defaults.set(declaration.prop, declaration.value))
      rule.remove()
    } else if (rule.selector.includes(".")) hasUtilities = true
  })
  if (!hasUtilities) return { css: "", inputs }
  // Preserve user/Host overrides. Default theme tokens are fallbacks in each
  // utility, never declarations on a scoped :root that cannot match a plugin.
  const substitute = (value, seen = new Set()) =>
    value.replace(/var\(\s*(--[\w-]+)\s*\)/g, (original, name) => {
      if (inherited.has(name) || !defaults.has(name) || seen.has(name)) return original
      return `var(${name}, ${substitute(defaults.get(name), new Set([...seen, name]))})`
    })
  sheet.walkDecls((declaration) => {
    declaration.value = substitute(declaration.value)
  })
  return { css: sheet.toString(), inputs }
}
