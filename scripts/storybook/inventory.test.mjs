import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"

import { collectInventory } from "./inventory.mjs"

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), "cognia-storybook-inventory-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [name, source] of Object.entries(files)) {
    const file = join(root, name)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, source)
  }
  return root
}

test("counts actual metadata rather than fixture text, comments, or type exports", (t) => {
  const root = fixture(t, {
    "components/chat/card.tsx": "export function Card() { return null }",
    "components/chat/card.test.tsx": "// not a candidate module",
    "components/chat/provider.tsx": "export function Provider() { return null }",
    "components/ui/__mocks__/button.tsx": "export const Button = () => null",
    "components/chat/card.stories.tsx": `
      const fixture = { description: "not documentation", play: "not a play function" }
      // tags: ['autodocs']; argTypes: {}; play: async () => {}
      const meta = {
        title: "Chat/Card",
        parameters: { docs: { description: { component: "Component contract" } } },
        beforeEach() {},
      } satisfies Meta<typeof Card>
      export default meta
      export type Fixture = { description: string }
      export const Empty: Story = {}
      export const Loaded: Story = {
        parameters: { docs: { description: { story: "Loaded state" } } },
        async play() {},
      }
    `,
    ".storybook/guide.mdx": '<Meta title="Documentation/Guide" />',
  })
  const result = collectInventory(root)
  assert.equal(result.totals.storyFiles, 1)
  assert.equal(result.totals.storyExports, 2)
  assert.equal(result.totals.componentDescriptions, 1)
  assert.equal(result.totals.storyDescriptions, 1)
  assert.equal(result.totals.playExports, 1)
  assert.equal(result.totals.beforeEachFiles, 1)
  assert.equal(result.totals.autodocsFiles, 0)
  assert.equal(result.totals.argTypesFiles, 0)
  assert.equal(result.totals.candidateTsxModules, 2)
  assert.equal(result.totals.sameStemStories, 1)
  assert.deepEqual(result.areas[0].missingSameStem, ["components/chat/provider.tsx"])
  assert.deepEqual(result.mdxFiles, [".storybook/guide.mdx"])
})

test("honors CSF include/exclude filters and selective autodocs tags", (t) => {
  const root = fixture(t, {
    "components/shared/badge.stories.ts": `
      export default {
        title: 'Shared/Badge',
        tags: ['autodocs'],
        argTypes: { value: { control: 'text' } },
        includeStories: /^[A-Z]/,
        excludeStories: ['Helper'],
      } as Meta
      export const helper = { description: 'fixture' }
      export const Helper = {}
      export const Default = { tags: ['!autodocs'] }
      export const Documented = { play: runAssertions }
    `,
    "components/shared/inert.stories.tsx": `
      const meta = { tags: ['autodocs'] }
      export default meta
      export const Default = { tags: ['!autodocs'] }
    `,
  })
  const result = collectInventory(root)
  assert.equal(result.totals.storyExports, 3)
  assert.equal(result.totals.autodocsFiles, 1)
  assert.equal(result.totals.argTypesFiles, 1)
  assert.equal(result.totals.playExports, 1)
  assert.deepEqual(result.files[0].exports, ["Default", "Documented"])
})

test("reports unresolved metadata explicitly and handles an empty tree", (t) => {
  const empty = fixture(t, {})
  assert.equal(collectInventory(empty).totals.storyFiles, 0)
  const root = fixture(t, {
    "components/card.stories.tsx": "export default makeMeta(); export const Default = {}",
  })
  assert.deepEqual(collectInventory(root).unresolvedMeta, ["components/card.stories.tsx"])
})
