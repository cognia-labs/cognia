/** Read-only compatibility probes; the upstream checkout and npm artifact live in .cache/. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { transformSync } from "esbuild"
import {
  DSH_VERSION,
  resolveProductLauncher,
  transformManagedAcp,
} from "../../packages/agent-dsh/runtime/launcher.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const ts = createRequire(join(root, "package.json"))("typescript")
const cache = join(root, ".cache/dsh-support-20261114")
const upstream = resolve(process.argv[2] ?? join(cache, "upstream"))
const read = (path) => readFileSync(path, "utf8")
const codecSource = read(join(root, "packages/agent-dsh/src/event-codec.ts"))
const codecJs = transformSync(codecSource, { loader: "ts", format: "esm", target: "node26" }).code
const { translateDshNotification, translateDshNotifications, DshVersionDriftError } = await import(
  `data:text/javascript;base64,${Buffer.from(codecJs).toString("base64")}`
)
const checks = []
const check = (name, run) => {
  const detail = run()
  checks.push({ name, result: "passed", ...(detail === undefined ? {} : { detail }) })
}

check("latest-session-format-remains-4", () => {
  assert.match(
    read(join(upstream, "packages/core/session/src/types.ts")),
    /SESSION_FORMAT_VERSION = 4/
  )
})

check("managed-launcher-refuses-new-release", () => {
  const temporary = mkdtempSync(join(cache, "version-probe-"))
  try {
    const manifest = join(temporary, "package.json")
    writeFileSync(manifest, JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.2-rc.3" }))
    assert.throws(
      () => resolveProductLauncher({ resolve: () => manifest }),
      /Unsupported @deepseek-ai\/dsh version 0\.2\.2-rc\.3/
    )
    return { managedVersion: DSH_VERSION, refusedVersion: "0.2.2-rc.3" }
  } finally {
    rmSync(temporary, { recursive: true })
  }
})

check("latest-acp-artifact-integrity", () => {
  const metadata = JSON.parse(read(join(cache, "dsh-acp-rc3-metadata.json")))
  const tarball = readFileSync(join(cache, "dsh-acp-rc3.tgz"))
  assert.equal(metadata.version, "0.2.2-rc.3")
  assert.equal(
    `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
    metadata.dist.integrity
  )
})

check("managed-acp-transform-refuses-new-release", () => {
  const source = read(join(cache, "acp-rc3/package/lib/index.js"))
  assert.throws(() => transformManagedAcp(source), /ACP source differs from the certified release/)
  return { latestAcpSha256: createHash("sha256").update(source).digest("hex") }
})

check("event-vocabulary-diff", () => {
  const known = new Set(
    [
      ...codecSource
        .slice(
          codecSource.indexOf("const KNOWN_EVENT_TYPES"),
          codecSource.indexOf("export interface")
        )
        .matchAll(/"([^"\n]+)"/g),
    ].map((match) => match[1])
  )
  const declarations = new Map()
  const packages = join(upstream, "packages")
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!["tests", "node_modules", "lib", "dist"].includes(entry.name)) walk(path)
      } else if (entry.name.endsWith(".ts")) {
        const source = read(path)
        if (!source.includes("interface SessionEventMap")) continue
        const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
        const visit = (node) => {
          if (ts.isInterfaceDeclaration(node) && node.name.text === "SessionEventMap") {
            for (const member of node.members) {
              if (member.name && ts.isStringLiteral(member.name)) {
                declarations.set(member.name.text, relative(upstream, path))
              }
            }
          }
          ts.forEachChild(node, visit)
        }
        visit(ast)
      }
    }
  }
  walk(packages)
  const missing = [...declarations].filter(([name]) => !known.has(name))
  assert.equal(known.size, 62)
  assert.equal(declarations.size, 63)
  assert.deepEqual(
    missing.map(([name]) => name),
    ["team/mode"]
  )
  return { current: known.size, upstream: declarations.size, missing }
})

check("team-mode-is-rejected-by-current-codec", () => {
  assert.throws(
    () =>
      translateDshNotification({
        method: "session.event",
        params: {
          sessionId: "audit-root",
          event: { type: "team/mode", seq: 0, time: 1, data: { enabled: true } },
        },
      }),
    (error) => error instanceof DshVersionDriftError && error.eventType === "team/mode"
  )
})

check("new-opt-in-notifications-are-rejected-by-current-codec", () => {
  for (const [method, params] of [
    [
      "session.query.completed",
      {
        sessionId: "audit-root",
        commandId: "audit-command",
        finalResponse: "",
        finishReason: "completed",
      },
    ],
    ["user-question.cancelled", { sessionId: "audit-root", requestId: "audit-question" }],
  ]) {
    assert.throws(
      () => translateDshNotification({ method, params }),
      (error) => error instanceof DshVersionDriftError && error.eventType === method
    )
  }
})

check("recorded-rc3-bash-conversation-remains-readable", () => {
  const fixture = "snapshots/sdk/bash-tool/notifications.expected.jsonl"
  const frames = read(join(upstream, fixture))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  const result = translateDshNotifications(frames)
  assert.equal(frames.length, 23)
  assert.deepEqual(result.warnings, [])
  assert.equal(
    result.events
      .filter((event) => event.type === "message_delta")
      .map((event) => event.delta.text)
      .join(""),
    "dsh-sdk-proof-7391"
  )
  assert.equal(result.events.filter((event) => event.type === "tool_result").length, 1)
  return { fixture, frames: frames.length, canonicalEvents: result.events.length }
})

console.log(
  JSON.stringify(
    {
      scope: "rejection probes and recorded fixture replay, not latest-runtime acceptance",
      checks,
    },
    null,
    2
  )
)
