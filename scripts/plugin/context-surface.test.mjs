import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import ts from "typescript"
import { assertContextSurfaceParity, inspectContextSurface } from "./context-surface.mjs"

test("extracts every namespace, nested and optional method without reflecting host data", () => {
  const directory = mkdtempSync(join(tmpdir(), "plugin-context-"))
  try {
    const file = join(directory, "context.ts")
    writeFileSync(
      file,
      `
      interface Shared { read(): string }
      class Handle { close(): void {} }
      export interface PluginContext {
        missing: { nested: Shared; optional?: () => void };
        also: Shared;
        optionalNamespace?: { list(): string[] };
        data: "one" | "two";
        array: Shared[];
        signal: AbortSignal;
        handle: Handle;
      }
    `
    )
    const program = ts.createProgram([file], { strict: true, noEmit: true, types: [] })
    const methods = inspectContextSurface(program, file)
    assert.deepEqual(methods, [
      "also.read",
      "missing.nested.read",
      "missing.optional",
      "optionalNamespace.list",
    ])
    const catalog = { apiNamespaces: [{ methods: methods.map((id) => ({ id })) }] }
    assert.doesNotThrow(() => assertContextSurfaceParity(catalog, methods))
    assert.throws(
      () => assertContextSurfaceParity({ apiNamespaces: [] }, methods),
      /missing catalog method missing.nested.read/
    )
    assert.throws(
      () => assertContextSurfaceParity(catalog, methods.slice(1)),
      /catalog method has no public context member also.read/
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
