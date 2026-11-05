import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"

import { GENERATED_FILES, GENERATED_HOST, GENERATED_RUNTIMES } from "../gates/lib/module-manifests.mjs"
import { generateModuleRegistries } from "./gen-module-registry.mjs"

const MANIFEST = `import { defineHostModule } from "@/lib/modules/define"
export default defineHostModule({ id: "crew", kind: "module", stage: "beta" })
`

function tree(files) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gen-module-registry-")))
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(root, dirname(file)), { recursive: true })
    writeFileSync(join(root, file), content)
  }
  return root
}

test("writes every registry, then leaves them alone when nothing changed", () => {
  const root = tree({ "lib/modules/define.ts": "", "lib/crew/module.ts": MANIFEST })
  try {
    const first = generateModuleRegistries({ root })
    assert.equal(first.ok, true)
    assert.deepEqual(first.stale.sort(), [...GENERATED_FILES].sort())
    assert.match(readFileSync(join(root, GENERATED_HOST), "utf8"), /HOST_MODULES = \[crewModule\]/)
    const written = statSync(join(root, GENERATED_HOST)).mtimeMs
    const second = generateModuleRegistries({ root })
    assert.deepEqual(second.stale, [])
    assert.equal(statSync(join(root, GENERATED_HOST)).mtimeMs, written)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("writes each host's runtime adapters into that host's registry only", () => {
  const root = tree({
    "lib/modules/define.ts": "",
    "lib/crew/module.ts": `import { defineHostModule } from "@/lib/modules/define"
export default defineHostModule({
  id: "crew",
  kind: "module",
  stage: "beta",
  runtimes: [
    {
      name: "crew-sync",
      criticality: "required",
      boot: "integrations",
      adapters: {
        brain: { module: "./runtime/brain", hosts: ["brain", "person-brain"] },
        desktop: "@/lib/crew/runtime/desktop",
      },
      absent: { mobile: "The phone keeps no crew roster." },
    },
  ],
})
`,
  })
  try {
    assert.equal(generateModuleRegistries({ root }).ok, true)
    const read = (host) => readFileSync(join(root, GENERATED_RUNTIMES[host]), "utf8")
    const brain = read("brain")
    assert.match(brain, /export const BRAIN_RUNTIMES: readonly BrainRuntimeEntry\[\] = \[/)
    assert.match(brain, /hosts: \["brain","person-brain"\],/)
    assert.match(brain, /load: \(\) => import\("@\/lib\/crew\/runtime\/brain"\),/)
    assert.doesNotMatch(brain, /desktop/)
    const desktop = read("desktop")
    assert.match(desktop, /boot: "integrations",/)
    assert.match(desktop, /load: \(\) => import\("@\/lib\/crew\/runtime\/desktop"\),/)
    assert.doesNotMatch(desktop, /runtime\/brain/)
    assert.match(read("mobile"), /export const MOBILE_RUNTIMES: readonly RendererRuntimeEntry\[\] = \[\]/)
    // The host-neutral registry holds the manifests, whose adapters are only specifiers.
    assert.doesNotMatch(readFileSync(join(root, GENERATED_HOST), "utf8"), /runtime\//)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("--check reports a stale registry without writing it", () => {
  const root = tree({ "lib/modules/define.ts": "", "lib/crew/module.ts": MANIFEST })
  try {
    const result = generateModuleRegistries({ root, check: true })
    assert.equal(result.ok, false)
    assert.equal(existsSync(join(root, GENERATED_HOST)), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a manifest that is not data stops the generator", () => {
  const root = tree({
    "lib/modules/define.ts": "",
    "lib/crew/module.ts": `import { defineHostModule } from "@/lib/modules/define"
const id = "crew"
export default defineHostModule({ id, kind: "module", stage: "beta" })
`,
  })
  try {
    const result = generateModuleRegistries({ root })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((e) => e.startsWith("lib/crew/module.ts: line 2")))
    assert.equal(existsSync(join(root, GENERATED_HOST)), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("skips a partial checkout that has no module system yet", () => {
  const root = tree({ "package.json": "{}" })
  try {
    assert.deepEqual(generateModuleRegistries({ root }), {
      ok: true,
      skipped: true,
      stale: [],
      errors: [],
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
