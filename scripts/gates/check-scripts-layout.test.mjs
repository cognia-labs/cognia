import assert from "node:assert/strict"
import test from "node:test"

import {
  auditScriptsLayout,
  isCheckedScript,
  isOwnTest,
  readmeLayoutFolders,
  referencedScripts,
} from "./check-scripts-layout.mjs"

const README =
  "# scripts\n\n## Layout\n\n```\nscripts/\n  build/   builds\n  smoke/   smokes\n```\n"
const CONFIG = {
  topLevelFiles: ["README.md"],
  folders: { build: "builds", smoke: "smokes" },
  manual: [],
}

function audit({ files, config = CONFIG, readme = README }) {
  return auditScriptsLayout({
    tracked: Object.keys(files),
    readText: (path) => files[path] ?? null,
    config,
    readme,
  }).problems
}

test("only entry points and helpers are checked, never tests or fixtures", () => {
  assert.equal(isCheckedScript("scripts/build/a.mjs"), true)
  assert.equal(isCheckedScript("scripts/eval/grader.py"), true)
  assert.equal(isCheckedScript("scripts/build/a.test.mjs"), false)
  assert.equal(isCheckedScript("scripts/eval/grader_test.py"), false)
  assert.equal(isCheckedScript("scripts/smoke/fixtures/x/build.mjs"), false)
  assert.equal(isCheckedScript("scripts/tauri/client.d.mts"), false)
  assert.equal(isCheckedScript("scripts/build/data.json"), false)
  assert.equal(isCheckedScript("lib/a.mjs"), false)
})

test("a co-located test with the same stem is the script's own test", () => {
  assert.equal(isOwnTest("scripts/dev/a.test.mjs", "scripts/dev/a.mjs"), true)
  assert.equal(isOwnTest("scripts/eval/g_test.py", "scripts/eval/g.py"), true)
  assert.equal(isOwnTest("scripts/dev/b.test.mjs", "scripts/dev/a.mjs"), false)
  assert.equal(isOwnTest("scripts/sync/a.test.mjs", "scripts/dev/a.mjs"), false)
  assert.equal(isOwnTest("lib/x.test.ts", "scripts/dev/a.mjs"), false)
})

test("repo paths in any spelling resolve to the tracked script", () => {
  const tracked = new Set([
    "scripts/build/a.mjs",
    "scripts/ci/b.mjs",
    "scripts/sync/presets.json",
    "scripts/smoke/c.ts",
  ])
  const text = [
    `"x": "node scripts/build/a.mjs --check"`,
    `const re = /^scripts\\/ci\\/b\\.mjs$/`,
    `import catalog from "@/scripts/sync/presets.json"`,
    `await import("../../../scripts/smoke/c")`,
  ].join("\n")
  assert.deepEqual([...referencedScripts("package.json", text, tracked)].sort(), [
    "scripts/build/a.mjs",
    "scripts/ci/b.mjs",
    "scripts/smoke/c.ts",
    "scripts/sync/presets.json",
  ])
  assert.deepEqual(
    [...referencedScripts(".github/x.yml", "run: $ROOT/scripts/build/a.mjs", tracked)],
    ["scripts/build/a.mjs"]
  )
})

test("globs, folders and other projects' scripts/ folders are not calls", () => {
  const tracked = new Set(["scripts/build/a.mjs", "scripts/a.mjs"])
  const text = [
    `- "scripts/build/**"`,
    `node --test scripts/build/*.test.mjs`,
    `node mobile/scripts/a.mjs`,
    `see scripts/build/ for more`,
  ].join("\n")
  assert.deepEqual([...referencedScripts(".github/workflows/x.yml", text, tracked)], [])
})

test("relative imports resolve with or without an extension", () => {
  const tracked = new Set(["scripts/build/lib/helper.mjs", "scripts/sync/gen.mjs"])
  const text = [
    `import { h } from "./lib/helper.mjs"`,
    `const { g } = await import("../sync/gen")`,
  ].join("\n")
  assert.deepEqual([...referencedScripts("scripts/build/main.mjs", text, tracked)].sort(), [
    "scripts/build/lib/helper.mjs",
    "scripts/sync/gen.mjs",
  ])
})

test("bare sibling file names count inside scripts/ only, and a file never calls itself", () => {
  const tracked = new Set(["scripts/build/job.ps1", "scripts/build/main.mjs"])
  const text = `const job = join(here, "job.ps1"); const me = "main.mjs"`
  assert.deepEqual(
    [...referencedScripts("scripts/build/main.mjs", text, tracked)],
    ["scripts/build/job.ps1"]
  )
  assert.deepEqual([...referencedScripts("lib/main.ts", text, tracked)], [])
})

test("readme layout folders come from the fenced Layout block", () => {
  assert.deepEqual([...readmeLayoutFolders(README)], ["build", "smoke"])
  assert.equal(readmeLayoutFolders("# no layout"), null)
})

test("a consolidated tree with callers passes", () => {
  assert.deepEqual(
    audit({
      files: {
        "package.json": `{"scripts":{"b":"node scripts/build/a.mjs"}}`,
        "scripts/README.md": "",
        "scripts/build/a.mjs": `import "./lib/h.mjs"`,
        "scripts/build/lib/h.mjs": "",
        "scripts/build/a.test.mjs": `import "./a.mjs"`,
      },
      config: { ...CONFIG, folders: { build: "builds" } },
    }),
    []
  )
})

test("loose top-level files, unknown and stale folders, and README gaps are reported", () => {
  const problems = audit({
    files: {
      "package.json": `node scripts/build/a.mjs node scripts/extra/x.mjs node scripts/loose.mjs`,
      "scripts/README.md": "",
      "scripts/loose.mjs": "",
      "scripts/build/a.mjs": "",
      "scripts/extra/x.mjs": "",
    },
    config: { ...CONFIG, folders: { ...CONFIG.folders, gone: "x", build: "b" } },
    readme: README.replace("  build/   builds\n", ""),
  })
  assert.ok(problems.some((p) => p.startsWith("scripts/loose.mjs: loose top-level file")))
  assert.ok(problems.some((p) => p.startsWith("scripts/extra/: folder is not in")))
  assert.ok(problems.some((p) => p.includes("folders lists scripts/gone/")))
  assert.ok(problems.some((p) => p.includes("folders lists scripts/smoke/")))
  assert.ok(problems.some((p) => p.includes("layout block does not list build/")))
})

test("a script that only its own test or Markdown mentions has no caller", () => {
  const problems = audit({
    files: {
      "scripts/README.md": "run `node scripts/smoke/live.mjs`",
      "docs/evidence/2026-01-01-x.md": "node scripts/smoke/live.mjs",
      "docs/evidence/2026-01-01-x.json": `"node scripts/smoke/live.mjs"`,
      "scripts/smoke/live.mjs": "",
      "scripts/smoke/live.test.mjs": `import { x } from "./live.mjs"`,
    },
    config: { ...CONFIG, folders: { smoke: "smokes" } },
  })
  assert.equal(problems.length, 1, problems.join("\n"))
  assert.match(problems[0], /^scripts\/smoke\/live\.mjs: nothing runs it/)
})

test("a manual entry covers a hand-run script and must stay exact", () => {
  const files = {
    "scripts/README.md": "",
    "scripts/smoke/live.mjs": "",
    "scripts/build/a.mjs": "",
    "package.json": "node scripts/build/a.mjs",
  }
  assert.deepEqual(
    audit({
      files,
      config: { ...CONFIG, manual: [{ path: "scripts/smoke/live.mjs", why: "real service" }] },
    }),
    []
  )
  const problems = audit({
    files,
    config: {
      ...CONFIG,
      manual: [
        { path: "scripts/smoke/live.mjs", why: "" },
        { path: "scripts/smoke/live.mjs", why: "twice" },
        { path: "scripts/smoke/gone.mjs", why: "deleted" },
        { path: "scripts/build/a.mjs", why: "has a command" },
      ],
    },
  })
  assert.ok(problems.some((p) => p.includes("lists scripts/smoke/live.mjs twice")))
  assert.ok(problems.some((p) => p.includes('scripts/smoke/live.mjs has no "why"')))
  assert.ok(problems.some((p) => p.includes("manual lists missing scripts/smoke/gone.mjs")))
  assert.ok(problems.some((p) => p.includes("package.json now calls it")))
})

test("the config's own manual list is not a caller", () => {
  const problems = audit({
    files: {
      "scripts/README.md": "",
      "scripts/smoke/live.mjs": "",
      "scripts/gates/scripts-layout.json": `{"manual":[{"path":"scripts/smoke/live.mjs"}]}`,
      "scripts/gates/check.mjs": "",
      "package.json": "node scripts/gates/check.mjs",
    },
    config: {
      ...CONFIG,
      folders: { gates: "gates", smoke: "smokes" },
      manual: [{ path: "scripts/smoke/live.mjs", why: "real service" }],
    },
    readme: README.replace("  build/   builds\n", "  gates/   gates\n"),
  })
  assert.deepEqual(problems, [])
})
