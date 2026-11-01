import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { syncDocs } from "./docs-sync.mjs"
import { verifyPinnedCorpus } from "../build/build-support-docs.mjs"

function fixture(t, artifact) {
  const root = mkdtempSync(join(tmpdir(), "docs-sync-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const docs = join(root, "docs")
  mkdirSync(join(docs, "artifacts"), { recursive: true })
  const run = (args) => execFileSync("git", ["-C", docs, ...args], { stdio: "pipe" })
  run(["init", "-q", "-b", "fixture"])
  run(["config", "user.name", "Fixture"])
  run(["config", "user.email", "fixture@example.invalid"])
  writeFileSync(join(docs, "artifacts/support-docs.json"), artifact)
  writeFileSync(
    join(docs, "artifacts/doc-pages.json"),
    JSON.stringify({ schemaVersion: 1, urls: ["/en/docs", "/zh/docs"] }) + "\n"
  )
  run(["add", "artifacts/support-docs.json", "artifacts/doc-pages.json"])
  run(["commit", "-q", "-m", "test: record publication fixture"])
  return { root, docs, run }
}
const valid =
  JSON.stringify({
    schemaVersion: 1,
    locales: {
      en: [{ path: "index.mdx", title: "Guide", text: "Help" }],
      zh: [{ path: "index.mdx", title: "指南", text: "帮助" }],
    },
  }) + "\n"

test("imports the committed artifact and verifies the pinned consumer checkout", (t) => {
  const { root, docs, run } = fixture(t, valid)
  const pin = syncDocs(root, docs)
  assert.equal(pin.revision, run(["rev-parse", "HEAD"]).toString().trim())
  assert.equal(verifyPinnedCorpus(root, docs).corpus.locales.en[0].title, "Guide")
  assert.equal(
    readFileSync(join(root, "lib/support-agent/support-docs.generated.json"), "utf8"),
    valid
  )
})
test("uncommitted artifact changes are never imported as published documentation", (t) => {
  const { root, docs } = fixture(t, valid)
  writeFileSync(join(docs, "artifacts/support-docs.json"), "uncommitted")
  syncDocs(root, docs)
  assert.equal(
    readFileSync(join(root, "lib/support-agent/support-docs.generated.json"), "utf8"),
    valid
  )
})
test("rejects invalid published data before changing either consumer file", (t) => {
  const { root, docs } = fixture(t, "{}")
  mkdirSync(join(root, "integrations"))
  mkdirSync(join(root, "lib/support-agent"), { recursive: true })
  writeFileSync(join(root, "integrations/cognia-docs.json"), "original pin")
  writeFileSync(join(root, "lib/support-agent/support-docs.generated.json"), "original corpus")
  assert.throws(() => syncDocs(root, docs), /corpus/)
  assert.equal(readFileSync(join(root, "integrations/cognia-docs.json"), "utf8"), "original pin")
  assert.equal(
    readFileSync(join(root, "lib/support-agent/support-docs.generated.json"), "utf8"),
    "original corpus"
  )
})

test("moving HEAD cannot mix publication artifacts with an earlier revision", (t) => {
  const { root, docs, run } = fixture(t, valid)
  const first = run(["rev-parse", "HEAD"]).toString().trim()
  let advanced = false
  const movingGit = (command, args, options) => {
    const result = execFileSync(command, args, options)
    if (!advanced && args.includes("rev-parse")) {
      advanced = true
      writeFileSync(join(docs, "artifacts/support-docs.json"), valid.replace("Guide", "Future"))
      writeFileSync(
        join(docs, "artifacts/doc-pages.json"),
        JSON.stringify({ schemaVersion: 1, urls: ["/en/docs", "/zh/docs", "/en/docs/future"] }) +
          "\n"
      )
      run(["add", "artifacts/support-docs.json", "artifacts/doc-pages.json"])
      run(["commit", "-q", "-m", "test: move publication HEAD"])
    }
    return result
  }
  const pin = syncDocs(root, docs, movingGit)
  assert.ok(advanced)
  assert.equal(pin.revision, first)
  assert.equal(
    readFileSync(join(root, "lib/support-agent/support-docs.generated.json"), "utf8"),
    valid
  )
  assert.deepEqual(verifyPinnedCorpus(root).pages.urls, ["/en/docs", "/zh/docs"])
})

test("pinned checkout verification also reads both artifacts from its captured revision", (t) => {
  const { root, docs, run } = fixture(t, valid)
  const pin = syncDocs(root, docs)
  let advanced = false
  const movingGit = (command, args, options) => {
    const result = execFileSync(command, args, options)
    if (!advanced && args.includes("rev-parse")) {
      advanced = true
      writeFileSync(join(docs, "artifacts/support-docs.json"), valid.replace("Guide", "Future"))
      run(["add", "artifacts/support-docs.json"])
      run(["commit", "-q", "-m", "test: advance consumer checkout"])
    }
    return result
  }
  assert.equal(verifyPinnedCorpus(root, docs, movingGit).pin.revision, pin.revision)
  assert.ok(advanced)
})
