/**
 * Regression coverage for scripts/gates/check-static-export.mjs.
 *
 * Pure-function tests import the scanner directly; end-to-end behavior is
 * exercised in a tmp git fixture with a minimal next.config.ts.
 *
 * Run with: node --test scripts/gates/check-static-export.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import {
  parseNodeOnlyModules,
  buildDenySet,
  extractImports,
  scanSource,
  listSourceFiles,
} from "./check-static-export.mjs"

test("includes non-ignored new sources before staging, without scanning ignored output", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "static-new-sources-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const initialized = spawnSync("git", ["init", "--quiet", root], { encoding: "utf8" })
  assert.equal(initialized.status, 0, initialized.stderr)
  mkdirSync(join(root, "packages/example/src"), { recursive: true })
  writeFileSync(join(root, ".gitignore"), "ignored.ts\n")
  writeFileSync(join(root, "packages/example/src/new.ts"), 'import fs from "node:fs"')
  writeFileSync(join(root, "packages/example/src/ignored.ts"), 'import fs from "node:fs"')
  const files = await listSourceFiles(root)
  assert.ok(files.includes("packages/example/src/new.ts"))
  assert.ok(!files.includes("packages/example/src/ignored.ts"))
})

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(__dirname, "check-static-export.mjs")
const require = createRequire(import.meta.url)

const NEXT_CONFIG_FIXTURE = `
const NODE_ONLY_MODULES = [
  "fs",
  "node:fs",
  "child_process",
  "node:child_process",
]
export default {}
`

// --- pure function tests ---

test("parseNodeOnlyModules extracts the list and throws when absent", () => {
  assert.deepEqual(parseNodeOnlyModules(NEXT_CONFIG_FIXTURE), [
    "fs",
    "node:fs",
    "child_process",
    "node:child_process",
  ])
  assert.throws(() => parseNodeOnlyModules("export default {}"), /stale/)
})

test("buildDenySet includes builtins in both forms plus server SDKs", () => {
  const deny = buildDenySet(NEXT_CONFIG_FIXTURE)
  assert.ok(deny.has("fs"))
  assert.ok(deny.has("node:crypto"))
  assert.ok(deny.has("crypto"))
  assert.ok(deny.has("@modelcontextprotocol/sdk/server"))
})

test("extractImports covers static/export-from/require/dynamic forms", () => {
  const src = [
    `import { readFileSync } from "node:fs"`,
    `import "side-effect-pkg"`,
    `export { x } from "child_process"`,
    `const a = require("node:os")`,
    `const b = await import("node:net")`,
  ].join("\n")
  const mods = extractImports(src).map((i) => i.module)
  assert.deepEqual(mods.sort(), [
    "child_process",
    "node:fs",
    "node:net",
    "node:os",
    "side-effect-pkg",
  ])
})

test("import type and typeof import() are type-only (auto-exempt)", () => {
  const src = [
    `import type { Stats } from "node:fs"`,
    `type NetMod = typeof import("node:net")`,
    `export type { X } from "node:os"`,
  ].join("\n")
  const imports = extractImports(src)
  assert.ok(
    imports.every((i) => i.typeOnly),
    JSON.stringify(imports)
  )
})

test("named type-only imports and exports are erased while mixed and aliased values remain", () => {
  const imports = extractImports(
    [
      'import { type Stats, type Dirent } from "node:fs"',
      'export { type ChildProcess } from "node:child_process"',
      'import { spawn, type ChildProcess } from "node:child_process"',
      'import { type as valueType } from "node:events"',
      'import { type /* value */ as valueType } from "node:events"',
    ].join("\n")
  )
  assert.deepEqual(
    imports.sort((a, b) => a.line - b.line).map(({ typeOnly }) => typeOnly),
    [true, true, false, false, false]
  )
})

test("value import + typeof import on one line keeps exactly one value hit", () => {
  const src = `const net = (await import("node:net")) as typeof import("node:net")`
  const imports = extractImports(src)
  const values = imports.filter((i) => !i.typeOnly)
  assert.equal(values.length, 1)
  assert.equal(values[0].module, "node:net")
})

test("AST extraction ignores comments and strings while retaining runtime TS imports", () => {
  const imports = extractImports(
    [
      '// require("node:fs")',
      'const text = `require("node:fs")`',
      'import child = require("node:child_process"); const load = () => import(`node:net`, { with: { type: "json" } })',
      'import value, { type Stats } from "node:fs"',
      'type Module = import("node:os").Module',
      'const wrapped = require((("node:" + "http") satisfies string)!)',
    ].join("\n")
  )
  assert.deepEqual(imports, [
    { module: "node:child_process", line: 3, typeOnly: false },
    { module: "node:net", line: 3, typeOnly: false },
    { module: "node:fs", line: 4, typeOnly: false },
    { module: "node:os", line: 5, typeOnly: true },
    { module: "node:http", line: 6, typeOnly: false },
  ])
})

test("export declarations never turn later statements' strings into imports", () => {
  // Regression: `export interface ... { }` followed by unrelated strings must
  // not synthesize a bogus module from a later string literal.
  const src = [
    `import type { A } from "@/types/a"`,
    `export interface Options { target?: number }`,
    `const SEP = ",\\n  "`,
    `const joined = ["a", "b"].join(SEP)`,
  ].join("\n")
  const values = extractImports(src).filter((i) => !i.typeOnly)
  assert.deepEqual(values, [])
})

test("scanSource: deny hit without exemption is a violation; allowlist suppresses", () => {
  const deny = buildDenySet(NEXT_CONFIG_FIXTURE)
  const src = `import { readFileSync } from "node:fs"`
  const bare = scanSource("lib/x.ts", src, deny, [])
  assert.equal(bare.violations.length, 1)
  assert.equal(bare.violations[0].module, "node:fs")

  const allowed = scanSource("lib/x.ts", src, deny, [
    { file: "lib/x.ts", module: "node:fs", reason: "host-only" },
  ])
  assert.equal(allowed.violations.length, 0)
})

test("scanSource: inline exempt with reason suppresses; bare marker fails", () => {
  const deny = buildDenySet(NEXT_CONFIG_FIXTURE)
  const good = scanSource(
    "lib/x.ts",
    `// static-export-exempt: runs in sidecar only\nimport { spawn } from "node:child_process"`,
    deny,
    []
  )
  assert.equal(good.violations.length, 0)
  assert.equal(good.badExempts.length, 0)

  const bad = scanSource(
    "lib/x.ts",
    `// static-export-exempt:\nimport { spawn } from "node:child_process"`,
    deny,
    []
  )
  assert.equal(bad.violations.length, 0)
  assert.equal(bad.badExempts.length, 1)
})

test("scanSource: subpath of a denied server SDK is flagged", () => {
  const deny = buildDenySet(NEXT_CONFIG_FIXTURE)
  const { violations } = scanSource(
    "lib/x.ts",
    `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"`,
    deny,
    []
  )
  assert.equal(violations.length, 1)
})

// --- end-to-end fixture tests ---

function makeFixture({ tsFiles = [], allowlist = [] }) {
  const root = mkdtempSync(join(tmpdir(), "static-export-"))
  writeFileSync(join(root, "next.config.ts"), NEXT_CONFIG_FIXTURE, "utf8")
  for (const { path, contents } of tsFiles) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, contents, "utf8")
  }
  mkdirSync(join(root, "scripts", "gates"), { recursive: true })
  copyFileSync(SCRIPT, join(root, "scripts", "gates", "check-static-export.mjs"))
  writeFileSync(
    join(root, "scripts", "gates", "static-export-allowlist.json"),
    JSON.stringify(allowlist),
    "utf8"
  )
  spawnSync("git", ["init", "-q"], { cwd: root })
  spawnSync("git", ["config", "user.email", "audit@test"], { cwd: root })
  spawnSync("git", ["config", "user.name", "audit"], { cwd: root })
  spawnSync("git", ["add", "."], { cwd: root })
  spawnSync("git", ["commit", "-q", "-m", "fixture"], { cwd: root })
  mkdirSync(join(root, "node_modules"), { recursive: true })
  for (const dependency of ["jsonc-parser", "typescript"])
    symlinkSync(
      dirname(require.resolve(`${dependency}/package.json`)),
      join(root, "node_modules", dependency),
      "junction"
    )
  return root
}

function runScript(root) {
  return spawnSync("node", [join(root, "scripts", "gates", "check-static-export.mjs")], {
    cwd: root,
    encoding: "utf8",
  })
}

const NODE_BRIDGE_FILE = "packages/example/src/node-bridge.ts"
const NODE_BRIDGE_RULE = {
  file: NODE_BRIDGE_FILE,
  module: "node:fs",
  reason: "Standalone Node entrypoint with an enforced renderer import boundary.",
  nodeOnly: true,
}

for (const [name, importer, contents] of [
  [
    "relative JS path",
    "packages/example/src/client.ts",
    'export { bridge } from "./node-bridge.js"',
  ],
  ["root alias", "app/main.tsx", 'import "@/packages/example/src/node-bridge"'],
  ["workspace alias", "lib/main.ts", 'import "@cognia/example/node-bridge"'],
  ["custom alias", "lib/main.ts", 'import "@private/worker"'],
  ["dynamic template", "lib/main.ts", "const load = () => import(`@private/worker`)"],
  ["parenthesized dynamic", "lib/main.ts", 'const load = () => import(("@private/worker"))'],
  ["constant concatenation", "lib/main.ts", 'const load = () => import("@private/" + "worker")'],
  [
    "second import on one line",
    "app/main.tsx",
    'import "./browser-helper"; import "@/packages/example/src/node-bridge";',
  ],
  [
    "commented value alias",
    "app/main.tsx",
    'import { type /* value */ as valueType } from "@/packages/example/src/node-bridge"; console.log(valueType)',
  ],
]) {
  test(`e2e: ${name} cannot import an allowlisted standalone Node module`, () => {
    const root = makeFixture({
      tsFiles: [
        { path: NODE_BRIDGE_FILE, contents: 'import fs from "node:fs"; export const bridge = 1' },
        { path: importer, contents },
        {
          path: "tsconfig.json",
          contents: `// Repo aliases are JSONC, including trailing commas.
{"compilerOptions":{"baseUrl":".","paths":{"@/*":["./*"],"@cognia/example/*":["./packages/example/src/*"],"@private/worker":["./${NODE_BRIDGE_FILE}"],}}}`,
        },
      ],
      allowlist: [NODE_BRIDGE_RULE],
    })
    try {
      const result = runScript(root)
      assert.equal(result.status, 1, result.stderr + result.stdout)
      assert.match(result.stderr, /imports standalone Node module/)
      assert.match(result.stderr, /packages\/example\/src\/node-bridge\.ts/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test("e2e: isolated Node modules may import one another and expose erased types", () => {
  const root = makeFixture({
    tsFiles: [
      { path: NODE_BRIDGE_FILE, contents: 'import fs from "node:fs"; export type Handle = string' },
      {
        path: "packages/example/src/helper.ts",
        contents: 'import "./node-bridge"; import path from "node:path"',
      },
      {
        path: "lib/types.ts",
        contents:
          'import type { Handle } from "../packages/example/src/node-bridge"; type Module = typeof import("../packages/example/src/node-bridge")',
      },
    ],
    allowlist: [
      NODE_BRIDGE_RULE,
      {
        file: "packages/example/src/helper.ts",
        module: "node:path",
        reason: "Standalone Node helper.",
        nodeOnly: true,
      },
    ],
  })
  try {
    const result = runScript(root)
    assert.equal(result.status, 0, result.stderr + result.stdout)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("actual agent browser entrypoints bundle without their standalone Node bridges", async () => {
  const { build } = await import("esbuild")
  const root = resolve(__dirname, "../..")
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["packages/agent-codebuff/src/index.ts", "packages/agent-crush/src/index.ts"],
    outdir: "browser-boundary-proof",
    platform: "browser",
    format: "esm",
    bundle: true,
    write: false,
    metafile: true,
    logLevel: "silent",
  })
  assert.equal(result.outputFiles.length, 2)
  assert.deepEqual(
    Object.keys(result.metafile.inputs).filter((file) =>
      /packages\/agent-(?:codebuff|crush)\/src\/(?:node-bridge|native-process)\.ts$/.test(file)
    ),
    []
  )
})

test("e2e: clean tree exits 0; violation exits 1 with file:line", () => {
  const clean = makeFixture({
    tsFiles: [{ path: "lib/ok.ts", contents: `export const x = 1` }],
  })
  const okResult = runScript(clean)
  assert.equal(okResult.status, 0, okResult.stderr + okResult.stdout)
  rmSync(clean, { recursive: true, force: true })

  const dirty = makeFixture({
    tsFiles: [{ path: "components/bad.tsx", contents: `import { readFileSync } from "node:fs"\n` }],
  })
  const badResult = runScript(dirty)
  assert.equal(badResult.status, 1)
  assert.match(badResult.stderr, /components\/bad\.tsx:1\s+imports "node:fs"/)
  rmSync(dirty, { recursive: true, force: true })
})

test("e2e: stale allowlist entry warns but does not fail", () => {
  const root = makeFixture({
    tsFiles: [{ path: "lib/ok.ts", contents: `export const x = 1` }],
    allowlist: [{ file: "lib/gone.ts", module: "node:fs", reason: "was removed" }],
  })
  const result = runScript(root)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stderr + result.stdout, /stale allowlist/)
  rmSync(root, { recursive: true, force: true })
})

test("e2e: tracked files deleted in the working tree are skipped", () => {
  const root = makeFixture({
    tsFiles: [{ path: "lib/deleted.ts", contents: `import fs from "node:fs"` }],
  })
  rmSync(join(root, "lib", "deleted.ts"))
  const result = runScript(root)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  rmSync(root, { recursive: true, force: true })
})

test("e2e: a git index larger than the default child buffer is fully scanned", () => {
  const root = makeFixture({
    tsFiles: [{ path: "lib/z-last.ts", contents: "export const ok = true" }],
  })
  try {
    const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: root,
      input: "export const fixture = true",
      encoding: "utf8",
    })
    assert.equal(blob.status, 0)
    const entries = Array.from(
      { length: 12000 },
      (_, index) => `100644 ${blob.stdout.trim()}\tlib/${"nested/".repeat(12)}fixture-${index}.ts\n`
    ).join("")
    assert.ok(entries.length > 1024 * 1024)
    const indexed = spawnSync("git", ["update-index", "--index-info"], {
      cwd: root,
      input: entries,
      encoding: "utf8",
    })
    assert.equal(indexed.status, 0, indexed.stderr)
    const clean = runScript(root)
    assert.equal(clean.status, 0, clean.stderr.slice(0, 1000))
    writeFileSync(join(root, "lib/z-last.ts"), 'import fs from "node:fs"')
    const violation = runScript(root)
    assert.equal(violation.status, 1)
    assert.match(violation.stderr, /lib\/z-last\.ts:1\s+imports "node:fs"/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("e2e: git paths with spaces or newlines remain in the scan", () => {
  const filename = "lib/space and\nnewline.ts"
  const root = makeFixture({ tsFiles: [{ path: filename, contents: 'import fs from "node:fs"' }] })
  try {
    const result = runScript(root)
    assert.equal(result.status, 1)
    assert.ok(result.stderr.includes(`${filename}:1`))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("e2e: .test/.stories/.mjs files are out of scope", () => {
  const root = makeFixture({
    tsFiles: [
      { path: "lib/x.test.ts", contents: `import fs from "node:fs"` },
      { path: "components/y.stories.tsx", contents: `import fs from "node:fs"` },
      { path: "hooks/builtin/hook.mjs", contents: `import fs from "node:fs"` },
    ],
  })
  const result = runScript(root)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  rmSync(root, { recursive: true, force: true })
})
