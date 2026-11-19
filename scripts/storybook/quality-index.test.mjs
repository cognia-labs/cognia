import assert from "node:assert/strict"
import { test } from "node:test"
import { qualityEntries } from "./quality-index.mjs"

const index = {
  entries: {
    "documentation-overview--docs": { type: "docs" },
    "ui-button--enabled": {
      id: "ui-button--enabled",
      type: "story",
      importPath: "./components/ui/button.stories.tsx",
      tags: ["quality"],
    },
    "ui-button--ignored": {
      id: "ui-button--ignored",
      type: "story",
      importPath: "./components/ui/button.stories.tsx",
      tags: [],
    },
  },
}
test("selects only explicitly tagged stories and proves each required file is represented", () => {
  assert.deepEqual(
    qualityEntries(index, ["components/ui/button.stories.tsx"]).map((entry) => entry.id),
    ["ui-button--enabled"]
  )
})
test("empty selections, missing story files and missing docs cannot produce a green smoke", () => {
  assert.throws(() => qualityEntries(index, []), /selection is empty/)
  assert.throws(
    () => qualityEntries(index, ["components/missing.stories.tsx"]),
    /No quality stories/
  )
  assert.throws(
    () => qualityEntries({ entries: {} }, ["components/ui/button.stories.tsx"]),
    /No quality stories/
  )
  const withoutDocs = structuredClone(index)
  delete withoutDocs.entries["documentation-overview--docs"]
  assert.throws(
    () => qualityEntries(withoutDocs, ["components/ui/button.stories.tsx"]),
    /Overview docs are missing/
  )
})
