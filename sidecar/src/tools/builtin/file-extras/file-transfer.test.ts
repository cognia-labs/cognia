import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"

import { execFileCopy, execFileRename, execFileMove } from "./file-transfer.ts"

let TMP: string
before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-fe-transfer-"))
})
after(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

test("file_copy refuses to overwrite by default", async () => {
  const a = path.join(TMP, "src.txt")
  const b = path.join(TMP, "dst.txt")
  fs.writeFileSync(a, "x")
  fs.writeFileSync(b, "y")
  const r = await execFileCopy({ source: a, destination: b, overwrite: false })
  assert.equal(r.isError, true)
  assert.equal(fs.readFileSync(a, "utf-8"), "x")
  assert.equal(fs.readFileSync(b, "utf-8"), "y")
})

test("file_copy overwrites with overwrite:true", async () => {
  const a = path.join(TMP, "src2.txt")
  const b = path.join(TMP, "dst2.txt")
  fs.writeFileSync(a, "fresh")
  fs.writeFileSync(b, "stale")
  const r = await execFileCopy({ source: a, destination: b, overwrite: true })
  assert.equal(r.isError, undefined)
  assert.equal(fs.readFileSync(b, "utf-8"), "fresh")
})

test("file_rename moves the file", async () => {
  const a = path.join(TMP, "ren-a.txt")
  const b = path.join(TMP, "ren-b.txt")
  fs.writeFileSync(a, "x")
  const r = await execFileRename({ overwrite: false, oldPath: a, newPath: b })
  assert.equal(r.isError, undefined)
  assert.equal(fs.existsSync(a), false)
  assert.equal(fs.readFileSync(b, "utf-8"), "x")
})

test("file_move renames on the same filesystem", async () => {
  const a = path.join(TMP, "mv-a.txt")
  const b = path.join(TMP, "mv-b.txt")
  fs.writeFileSync(a, "z")
  const r = await execFileMove({ overwrite: false, source: a, destination: b })
  assert.equal(r.isError, undefined)
  assert.equal(fs.readFileSync(b, "utf-8"), "z")
  assert.equal(fs.existsSync(a), false)
})

for (const overwrite of [false, true]) {
  test(`file_move copies bytes and deletes the source on EXDEV with overwrite:${overwrite}`, async (t) => {
    const source = path.join(TMP, `exdev-source-${overwrite}.bin`)
    const destination = path.join(TMP, `exdev-destination-${overwrite}.bin`)
    const bytes = Buffer.from([0, 255, 13, 10, 128, 42])
    fs.writeFileSync(source, bytes)
    if (overwrite) fs.writeFileSync(destination, "old destination")
    t.mock.method(fs.promises, "rename", async () => {
      throw Object.assign(new Error("cross-device rename"), { code: "EXDEV" })
    })
    const result = await execFileMove({ source, destination, overwrite })
    assert.equal(result.isError, undefined)
    assert.deepEqual(fs.readFileSync(destination), bytes)
    assert.equal(fs.existsSync(source), false)
  })
}

test("file_move preserves the source if its EXDEV copy fails", async (t) => {
  const source = path.join(TMP, "failed-copy-source.txt")
  const destination = path.join(TMP, "failed-copy-destination.txt")
  fs.writeFileSync(source, "only copy")
  t.mock.method(fs.promises, "rename", async () => {
    throw Object.assign(new Error("cross-device rename"), { code: "EXDEV" })
  })
  t.mock.method(fs.promises, "copyFile", async () => {
    throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" })
  })
  const result = await execFileMove({ source, destination, overwrite: false })
  assert.equal(result.isError, true)
  const error = result.content[0]
  assert(error?.type === "text")
  assert.match(error.text, /no space left on device/)
  assert.equal(fs.readFileSync(source, "utf-8"), "only copy")
  assert.equal(fs.existsSync(destination), false)
})

for (const operation of ["copy", "EXDEV move"] as const) {
  test(`file ${operation} preserves a destination created after the overwrite precheck`, async (t) => {
    const source = path.join(TMP, `${operation}-race-source.txt`)
    const destination = path.join(TMP, `${operation}-race-destination.txt`)
    fs.writeFileSync(source, "source bytes")
    const realCopy = fs.promises.copyFile
    t.mock.method(fs.promises, "copyFile", async (...args: Parameters<typeof realCopy>) => {
      const [src, dst, mode] = args
      // Simulate the competing writer after statOrNull but before the copy.
      await fs.promises.writeFile(dst, "concurrent writer", { flag: "wx" })
      return realCopy(src, dst, mode)
    })
    if (operation === "EXDEV move") {
      t.mock.method(fs.promises, "rename", async () => {
        throw Object.assign(new Error("cross-device rename"), { code: "EXDEV" })
      })
    }
    const args = { source, destination, overwrite: false }
    const result = await (operation === "copy" ? execFileCopy(args) : execFileMove(args))
    assert.equal(fs.readFileSync(destination, "utf-8"), "concurrent writer")
    assert.equal(fs.readFileSync(source, "utf-8"), "source bytes")
    assert.equal(result.isError, true)
  })
}

test("file_rename refuses to clobber an existing destination by default", async () => {
  const a = path.join(TMP, "rc-a.txt")
  const b = path.join(TMP, "rc-b.txt")
  fs.writeFileSync(a, "keep")
  fs.writeFileSync(b, "precious")
  const r = await execFileRename({ overwrite: false, oldPath: a, newPath: b })
  assert.equal(r.isError, true)
  // The destination and source are both untouched.
  assert.equal(fs.readFileSync(b, "utf-8"), "precious")
  assert.equal(fs.existsSync(a), true)
  // overwrite:true allows it.
  const r2 = await execFileRename({ oldPath: a, newPath: b, overwrite: true })
  assert.equal(r2.isError, undefined)
  assert.equal(fs.readFileSync(b, "utf-8"), "keep")
})

test("file_move refuses to clobber an existing destination by default", async () => {
  const a = path.join(TMP, "mc-a.txt")
  const b = path.join(TMP, "mc-b.txt")
  fs.writeFileSync(a, "keep")
  fs.writeFileSync(b, "precious")
  const r = await execFileMove({ overwrite: false, source: a, destination: b })
  assert.equal(r.isError, true)
  assert.equal(fs.readFileSync(b, "utf-8"), "precious")
  const r2 = await execFileMove({ source: a, destination: b, overwrite: true })
  assert.equal(r2.isError, undefined)
  assert.equal(fs.readFileSync(b, "utf-8"), "keep")
})

test("file_move surfaces non-EXDEV errors", async () => {
  const r = await execFileMove({
    overwrite: false,
    source: path.join(TMP, "nope-src"),
    destination: path.join(TMP, "nope-dst"),
  })
  assert.equal(r.isError, true)
})
