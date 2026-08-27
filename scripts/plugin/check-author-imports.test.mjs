import { test } from "node:test"
import assert from "node:assert/strict"

import {
  collectFindings,
  diffAgainstBaseline,
  findForbiddenAuthorImports,
  findingKey,
  readBaseline,
} from "./check-author-imports.mjs"

test("flags every @/ alias, not just the four the loader used to know about", () => {
  assert.deepEqual(
    findForbiddenAuthorImports(`
      import type { PluginContext } from "@/types/plugin"
      import "@/lib/plugin/private-side-effect"
      import Widget from "@/components/private"
      const store = require("@/stores/private")
      import { gate } from "@/packages/plugin-sdk/src/host"
      import { useThing } from "@/hooks/ui/use-thing"
      import { thing } from "@/app/internal"
      const lazy = await import("@/utils/private")
    `),
    [
      "@/types/plugin",
      "@/lib/plugin/private-side-effect",
      "@/components/private",
      "@/stores/private",
      // `@/packages` / `@/hooks` / `@/app` / `@/utils` all resolve inside this
      // monorepo and nowhere else, so root-only has to cover them too. The
      // loader's old four-prefix list is exactly why `plugins/web-tools` could
      // reach `@/packages/plugin-sdk/src/host` and still load.
      "@/packages/plugin-sdk/src/host",
      "@/hooks/ui/use-thing",
      "@/app/internal",
      "@/utils/private",
    ]
  )
})

test("flags SDK and UI subpaths while allowing both bare roots", () => {
  assert.deepEqual(
    findForbiddenAuthorImports(`
      import { definePlugin } from "@cognia/plugin-sdk"
      import { Button } from "@cognia/plugin-ui"
      import { definePlugin as d } from "@cognia/plugin-sdk/manifest"
      import type { PluginContext } from "@cognia/plugin-sdk/context"
      import { gate } from "@cognia/plugin-sdk/host"
      import { cn } from "@cognia/plugin-ui/cn"
    `),
    [
      "@cognia/plugin-sdk/manifest",
      "@cognia/plugin-sdk/context",
      "@cognia/plugin-sdk/host",
      "@cognia/plugin-ui/cn",
    ]
  )
})

test("leaves third-party and relative specifiers alone", () => {
  assert.deepEqual(
    findForbiddenAuthorImports(`
      import ky from "ky"
      import { z } from "zod"
      import { helper } from "./helper"
      import { shared } from "../shared"
      import react from "react"
    `),
    []
  )
})

test("a comment naming an alias is prose, not an import", () => {
  // plugins/impeccable — one of only two plugins already root-only — carries
  // exactly this in its vendored .d.ts. Scanning raw source would make the
  // reference plugin permanently dirty.
  assert.deepEqual(
    findForbiddenAuthorImports(`
      /** Mirrors \`cn\` from "@/lib/utils". */
      // was: import { cn } from "@/lib/utils"
      import { cn } from "@cognia/plugin-ui"
    `),
    []
  )
})

test("catches type-only, dynamic, and require forms", () => {
  assert.deepEqual(
    findForbiddenAuthorImports(`
      import type { A } from "@/types/a"
      export type { B } from "@/types/b"
      const c = await import("@/lib/c")
      const d = require("@/lib/d")
      import "@/lib/side-effect"
    `),
    ["@/types/a", "@/types/b", "@/lib/c", "@/lib/d", "@/lib/side-effect"]
  )
})

test("the ratchet fails a new finding and celebrates a removed one", () => {
  const baseline = [findingKey("plugins/known/src/index.ts", "@/lib/known")]

  assert.deepEqual(
    diffAgainstBaseline(
      [
        findingKey("plugins/known/src/index.ts", "@/lib/known"),
        findingKey("plugins/fresh/src/index.ts", "@/lib/fresh"),
      ],
      baseline
    ),
    { added: [findingKey("plugins/fresh/src/index.ts", "@/lib/fresh")], removed: [] }
  )

  assert.deepEqual(diffAgainstBaseline([], baseline), {
    added: [],
    removed: [findingKey("plugins/known/src/index.ts", "@/lib/known")],
  })
})

test("a finding is keyed by file AND specifier, so moving debt is still new debt", () => {
  const baseline = [findingKey("plugins/a/src/index.ts", "@/lib/x")]
  const { added } = diffAgainstBaseline([findingKey("plugins/b/src/index.ts", "@/lib/x")], baseline)
  assert.deepEqual(added, [findingKey("plugins/b/src/index.ts", "@/lib/x")])
})

test("the committed baseline still matches the tree", () => {
  // The gate's whole value is this equality. If it drifts, either debt was paid
  // down (rerun with --write-baseline) or new debt landed (fix the import).
  assert.deepEqual(diffAgainstBaseline(collectFindings(), readBaseline()).added, [])
})

test("templates and the two already-clean plugins carry no debt", () => {
  const findings = collectFindings()
  const dirty = (prefix) => findings.filter((finding) => finding.startsWith(prefix))

  for (const template of [
    "crates/cognia-plugin-template-ts/",
    "crates/cognia-plugin-template-hybrid/",
    "crates/cognia-plugin-template-vscode-extension/",
  ]) {
    assert.deepEqual(dirty(template), [], `${template} must stay author-clean`)
  }

  // These two are the reference for what a distributable plugin looks like, and
  // `plugins/impeccable` is the subject of the out-of-repo authoring proof.
  assert.deepEqual(dirty("plugins/impeccable/"), [])
  assert.deepEqual(dirty("plugins/pro-ide-fixture/"), [])
})
