// Real installed theme data for Jest's CommonJS runner. Parse JSON only:
// no substituted colours, package-code evaluation, or highlighting stub.
const { createRequire } = require("node:module")
const { readFileSync } = require("node:fs")

exports.loadBundledTheme = (name) => {
  const fromShiki = createRequire(require.resolve("shiki/package.json"))
  const source = readFileSync(fromShiki.resolve(`@shikijs/themes/${name}`), "utf8")
  const encoded = source.match(/JSON\.parse\(("(?:[^"\\]|\\.)*")\)/)?.[1]
  if (!encoded) throw new Error(`Review the installed Shiki theme asset format: ${name}`)
  return Object.freeze(JSON.parse(JSON.parse(encoded)))
}
