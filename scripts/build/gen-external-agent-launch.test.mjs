import assert from "node:assert/strict"
import { test } from "node:test"

import { renderLaunchTable } from "./gen-external-agent-launch.mjs"

test("the committed launch table is what the packages' descriptors generate", async () => {
  const { current, next } = await renderLaunchTable()
  assert.equal(next, current)
})
