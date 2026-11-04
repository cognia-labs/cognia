import assert from "node:assert/strict"
import { test } from "node:test"

import { renderCatalog, renderDshChannelCertification } from "./gen-external-agent-runtimes.mjs"

test("the committed runtime catalog is what the integration manifests generate", async () => {
  const { current, next } = await renderCatalog()
  assert.equal(next, current)
})

test("the Rust channel certification exactly follows the package channel builder", async () => {
  const { current, next } = await renderDshChannelCertification()
  assert.equal(next, current)
})
