import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { parseArgs, verifyPinnedCorpus, validateCorpus } from "./build-support-docs.mjs"

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pinned-docs-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, "integrations"))
  mkdirSync(join(root, "lib/support-agent"), { recursive: true })
  const bytes = JSON.stringify({ schemaVersion: 1, locales: { en: [{ path: "index.mdx", title: "Guide", text: "Help" }], zh: [{ path: "index.mdx", title: "指南", text: "帮助" }] } }) + "\n"
  const pageBytes = JSON.stringify({ schemaVersion: 1, urls: ["/en/docs", "/zh/docs"] }) + "\n"
  writeFileSync(join(root, "integrations/cognia-docs-pages.json"), pageBytes)
  const pin = { pagesSha256: createHash("sha256").update(pageBytes).digest("hex"), repository: "cognia-labs/cognia-docs", revision: "a".repeat(40), corpusSha256: createHash("sha256").update(bytes).digest("hex") }
  writeFileSync(join(root, "integrations/cognia-docs.json"), JSON.stringify(pin))
  writeFileSync(join(root, "lib/support-agent/support-docs.generated.json"), bytes)
  return { root, pin, bytes }
}

test("build and check validate a pinned corpus without reading any documentation source", (t) => {
  const { root, pin, bytes } = fixture(t)
  assert.equal(verifyPinnedCorpus(root).pin.revision, pin.revision)
  assert.equal(readFileSync(join(root, "lib/support-agent/support-docs.generated.json"), "utf8"), bytes)
})
test("rejects a tampered or missing corpus rather than rebuilding an incomplete ADR-only corpus", (t) => {
  const { root } = fixture(t)
  writeFileSync(join(root, "lib/support-agent/support-docs.generated.json"), "{}")
  assert.throws(() => verifyPinnedCorpus(root), /SHA-256/)
  rmSync(join(root, "lib/support-agent/support-docs.generated.json"))
  assert.throws(() => verifyPinnedCorpus(root), /ENOENT/)
})
test("rejects another repository, a floating revision and malformed bilingual data", (t) => {
  const { root, pin } = fixture(t)
  for (const change of [{ repository: "someone/other" }, { revision: "main" }]) {
    writeFileSync(join(root, "integrations/cognia-docs.json"), JSON.stringify({ ...pin, ...change }))
    assert.throws(() => verifyPinnedCorpus(root), /pinned/)
  }
  for (const data of [{ schemaVersion: 2, locales: {} }, { schemaVersion: 1, locales: { en: [], zh: [] } }, { schemaVersion: 1, locales: { en: [{ path: "../secret", title: "x", text: "x" }], zh: [] } }]) {
    assert.throws(() => validateCorpus(Buffer.from(JSON.stringify(data))), /corpus/)
  }
})
test("the optional docs checkout must match the exact published artifact and revision", (t) => {
  const { root, pin, bytes } = fixture(t)
  const docs = join(root, "docs-checkout")
  mkdirSync(join(docs, "artifacts"), { recursive: true })
  writeFileSync(join(docs, "artifacts/support-docs.json"), bytes)
  assert.throws(() => verifyPinnedCorpus(root, docs), /checkout|git/i)
  assert.equal(pin.repository, "cognia-labs/cognia-docs")
})
test("argument parsing preserves check mode and accepts an explicit consumer checkout", () => {
  assert.deepEqual(parseArgs([]), { check: false, docsRoot: undefined })
  assert.deepEqual(parseArgs(["--check"]), { check: true, docsRoot: undefined })
  assert.deepEqual(parseArgs(["--docs-root", "/tmp/docs"]), { check: false, docsRoot: "/tmp/docs" })
  assert.throws(() => parseArgs(["--unknown"]), /unknown option/)
  assert.throws(() => parseArgs(["--docs-root"]), /requires/)
})


test("a tampered page index fails the same offline pin verification", (t) => {
  const { root } = fixture(t)
  writeFileSync(join(root, "integrations/cognia-docs-pages.json"), "{}")
  assert.throws(() => verifyPinnedCorpus(root), /SHA-256/)
})
