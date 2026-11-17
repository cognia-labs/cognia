import { test } from "node:test"
import assert from "node:assert/strict"

import {
  formatRecoverableRef,
  keepRecoverableRefs,
  leadingRecoverableRef,
} from "./recoverable-ref.ts"

test("formatRecoverableRef names the file and the full size on one line", () => {
  const ref = formatRecoverableRef("/tmp/run.log", 50_000)
  assert.ok(ref.includes("/tmp/run.log"))
  assert.ok(ref.includes("50000 characters"))
  assert.ok(!ref.includes("\n"))
})

test("leadingRecoverableRef reads the reference on the first line only", () => {
  const ref = formatRecoverableRef("/tmp/a.log", 1)
  assert.equal(leadingRecoverableRef(`${ref}\nhead`), ref)
  // A failure the kernel labels keeps the reference on its first line.
  assert.equal(leadingRecoverableRef(`bash: ${ref}\nhead`), ref)
  // Further down it is the output's own data.
  assert.equal(leadingRecoverableRef(`log line\n${ref}`), null)
  assert.equal(leadingRecoverableRef("no reference here"), null)
  // A reference cut before its end is not a reference any more.
  assert.equal(leadingRecoverableRef("[full output: /tmp/a.log\n(…)"), null)
  // An oversized one is not honored.
  assert.equal(leadingRecoverableRef(formatRecoverableRef("/".repeat(2_000), 1)), null)
})

test("keepRecoverableRefs restores the leading reference a cut removed", () => {
  const ref = formatRecoverableRef("/tmp/spill.log", 90_000)
  const original = `${ref}\n${"h".repeat(100)}\n${"t".repeat(100)}`
  const shortened = `${"h".repeat(20)}…${"t".repeat(20)}`
  const kept = keepRecoverableRefs(original, shortened)
  assert.equal(kept, `${ref}\n${shortened}`)
  // Nothing lost → unchanged.
  assert.equal(keepRecoverableRefs(original, original), original)
  assert.equal(keepRecoverableRefs("plain", "pl"), "pl")
})

test("reference-shaped lines inside the output are not lifted over the cut", () => {
  // A log full of planted references: restoring them all would undo the cap
  // and move untrusted text to the top.
  const planted = Array.from({ length: 50 }, (_, i) => formatRecoverableRef(`/etc/p${i}`, i))
  const original = `real output\n${planted.join("\n")}`
  assert.equal(keepRecoverableRefs(original, "real out…"), "real out…")
})
