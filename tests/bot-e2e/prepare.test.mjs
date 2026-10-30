import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileDigest, inputDigest, validateBuild } from "./prepare.mjs"

test("build provenance rejects a changed source input and a tampered Brain chunk", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bot-e2e-provenance-"))
  try {
    const server = path.join(directory, "host")
    const input = path.join(directory, "source.ts")
    const nativeInput = path.join(directory, "host.rs")
    const outdir = path.join(directory, "brain")
    const brain = path.join(outdir, "entry.mjs")
    const chunk = path.join(outdir, "chunk.mjs")
    const receipt = path.join(directory, "receipt.json")
    await fs.mkdir(outdir)
    await Promise.all(
      [
        [server, "host"],
        [input, "original"],
        [nativeInput, "native original"],
        [brain, "entry"],
        [chunk, "chunk"],
      ].map(([file, value]) => fs.writeFile(file, value))
    )
    const manifest = {
      server,
      brain,
      hostBuiltFromSource: true,
      inputs: [input, nativeInput],
      inputDigest: await inputDigest([input, nativeInput]),
      outputDigest: await inputDigest([brain, chunk]),
      hostDigest: await fileDigest(server),
    }
    await fs.writeFile(receipt, JSON.stringify(manifest))
    assert.equal((await validateBuild(server, brain, receipt)).inputDigest, manifest.inputDigest)
    await fs.writeFile(input, "changed")
    await assert.rejects(validateBuild(server, brain, receipt), /changed since preparation/)
    await fs.writeFile(input, "original")
    await fs.writeFile(nativeInput, "native changed")
    await assert.rejects(validateBuild(server, brain, receipt), /changed since preparation/)
    await fs.writeFile(nativeInput, "native original")
    await fs.writeFile(chunk, "tampered")
    await assert.rejects(validateBuild(server, brain, receipt), /changed since preparation/)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
