/** Pin release semantics independently of a consumer's development tsconfig. */
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { parse } from "jsonc-parser"

export function createPluginCompilerContract(root) {
  const inputs = [],
    visited = new Set()
  function load(file) {
    if (visited.has(file)) throw new Error("Circular plugin compiler configuration")
    visited.add(file)
    inputs.push(file)
    const config = parse(fs.readFileSync(file, "utf8"))
    let options = {}
    for (const extension of [config.extends ?? []].flat()) {
      const parent = extension.startsWith(".")
        ? path.resolve(path.dirname(file), extension)
        : createRequire(file).resolve(extension)
      options = { ...options, ...load(fs.existsSync(parent) ? parent : `${parent}.json`) }
    }
    visited.delete(file)
    return { ...options, ...config.compilerOptions }
  }
  const options = load(path.join(root, "tsconfig.json"))
  const compilerOptions = Object.fromEntries(
    [
      "jsx",
      "jsxFactory",
      "jsxFragmentFactory",
      "jsxImportSource",
      "experimentalDecorators",
      "verbatimModuleSyntax",
    ]
      .filter((key) => options[key] !== undefined)
      .map((key) => [key, options[key]])
  )
  compilerOptions.alwaysStrict = options.alwaysStrict ?? options.strict ?? false
  compilerOptions.useDefineForClassFields =
    options.useDefineForClassFields ??
    /^(?:ESNext|ES20(?:2[2-9]|[3-9]\d))$/i.test(options.target ?? "ES5")
  const packageFile = path.join(root, "package.json")
  const packageType = fs.existsSync(packageFile)
    ? (JSON.parse(fs.readFileSync(packageFile, "utf8")).type ?? "commonjs")
    : "commonjs"
  if (fs.existsSync(packageFile)) inputs.push(packageFile)
  return { schema: 1, target: "es2022", packageType, compilerOptions, inputs }
}
