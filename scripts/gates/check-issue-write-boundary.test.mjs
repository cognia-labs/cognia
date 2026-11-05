import assert from "node:assert/strict"
import { test } from "node:test"
import {
  auditSource,
  collectViolations,
  guardedModuleOf,
  isReadName,
  loadWritesByModule,
  writeExportsOf,
} from "./check-issue-write-boundary.mjs"

const WRITES = new Map([
  ["issues", new Set(["createIssue", "moveIssue"])],
  ["issue-projects", new Set(["createIssueProject"])],
])

test("guards the issue modules by alias and by relative path, nothing else", () => {
  assert.equal(guardedModuleOf("@/lib/db/issues", "components/a.tsx"), "issues")
  assert.equal(guardedModuleOf("@/lib/db/issue-runs", "components/a.tsx"), "issue-runs")
  assert.equal(
    guardedModuleOf("@/lib/db/github-issue-mirror", "app/x/page.tsx"),
    "github-issue-mirror"
  )
  assert.equal(guardedModuleOf("../../lib/db/issues", "components/issues/a.tsx"), "issues")
  assert.equal(guardedModuleOf("@/lib/db/labels", "components/a.tsx"), null)
  assert.equal(guardedModuleOf("@/lib/issues/service", "components/a.tsx"), null)
  assert.equal(guardedModuleOf("dexie", "components/a.tsx"), null)
})

test("reads, types and constants cross; writes do not", () => {
  for (const name of [
    "listIssues",
    "getIssue",
    "parseGithubMirrorId",
    "isIssueOpen",
    "ISSUE_X",
    "IssueRow",
  ]) {
    assert.equal(isReadName(name), true, name)
  }
  for (const name of ["createIssue", "moveIssue", "deleteIssueCycle", "acceptIssueDeliverable"]) {
    assert.equal(isReadName(name), false, name)
  }
  assert.deepEqual(
    [
      ...writeExportsOf(
        `export async function createIssue() {}\nexport function getIssue() {}\nexport const reorderIssues = 1\nexport const ISSUE_MAX = 2`
      ),
    ],
    ["createIssue", "reorderIssues"]
  )
})

test("flags a named write import, and passes reads and type imports", () => {
  const source = [
    `import { listIssues, createIssue as make, type Issue } from "@/lib/db/issues"`,
    `import type { IssueProject } from "@/lib/db/issue-projects"`,
    `import { createIssueRecord } from "@/lib/issues/service"`,
  ].join("\n")
  assert.deepEqual(auditSource("components/x.tsx", source, WRITES), [
    { file: "components/x.tsx", module: "issues", name: "createIssue", how: "import" },
  ])
})

test("flags a namespace import, a dynamic import used for a write, and a getDb() write", () => {
  const source = [
    `import * as db from "@/lib/db/issue-projects"`,
    `const { moveIssue } = await import("@/lib/db/issues")`,
    `await getDb().issues.put(row)`,
  ].join("\n")
  assert.deepEqual(
    auditSource("hooks/x.ts", source, WRITES).map((v) => `${v.how}:${v.name}`),
    ["namespace import:*", "dynamic import:moveIssue", "getDb() write:issues.put"]
  )
})

test("a dynamic import used only for reads passes", () => {
  const source = `const [{ getIssue }] = await Promise.all([import("@/lib/db/issues")])`
  assert.deepEqual(auditSource("components/x.tsx", source, WRITES), [])
})

test("the guarded modules are found, and the tree holds the boundary today", () => {
  const writes = loadWritesByModule()
  assert.ok(writes.get("issues")?.has("createIssue"))
  assert.ok(writes.get("issue-projects")?.has("createIssueProject"))
  assert.equal(writes.get("issues")?.has("getIssue"), false)
  assert.deepEqual(collectViolations(), [])
})
