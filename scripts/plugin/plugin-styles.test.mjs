import assert from "node:assert/strict"
import path from "node:path"
import { test } from "node:test"
import { compilePluginUtilityCss, createPluginStyleContract } from "./plugin-styles.mjs"

test("utility styles close responsive, focus and animation rules without leaking a previous plugin's candidates", async () => {
  const root = process.cwd(),
    contract = createPluginStyleContract(root)
  assert.ok(!contract.css.includes('@import "./typeset.css"'))
  assert.ok(contract.hostVariables.includes("--background"))
  const first = await compilePluginUtilityCss({
    root,
    contract,
    javascript: '"sm:px-2 focus-visible:underline animate-spin translate-x-1"',
  })
  assert.ok(first.css.includes(".sm\\:px-2"))
  assert.ok(first.css.includes("focus-visible"))
  assert.ok(first.css.includes("@keyframes spin"))
  assert.match(first.css, /var\(--spacing,/) // standalone fallback while allowing Host overrides
  assert.match(first.css, /var\(--animate-spin,/)
  assert.ok(!first.css.includes(":root, :host"))
  assert.ok(!first.css.includes("box-sizing: border-box")) // no preflight/reset
  const second = await compilePluginUtilityCss({ root, contract, javascript: '"p-7"' })
  assert.ok(second.css.includes(".p-7"))
  assert.ok(!second.css.includes("focus-visible"))
  assert.ok(first.inputs.some((file) => file.endsWith(path.join("tailwindcss", "theme.css"))))
})
