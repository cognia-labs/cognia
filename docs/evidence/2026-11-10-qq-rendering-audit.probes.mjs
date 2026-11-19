/**
 * Reproduce QQ rendering support and gaps without provider calls or persistence.
 * Passing gap assertions characterize current behavior; they do not fix it.
 * Run from the repository root:
 *   node docs/evidence/2026-11-10-qq-rendering-audit.probes.mjs
 * This companion is executable evidence for the existing QQ ledger.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"

const root = fileURLToPath(new URL("../../", import.meta.url))
const output = path.join(root, ".cache/qq-rendering-audit-2026-11-10")
await mkdir(output, { recursive: true })
const sourcePaths = [
  "lib/connectors/adapters/qq-official/serialize.ts",
  "lib/connectors/adapters/qq-official/a2ui-mapper.ts",
  "lib/connectors/adapters/qq-official/keyboard.ts",
  "lib/connectors/adapters/qq-official/parse.ts",
  "lib/connectors/adapters/qq-official/inbound-to-a2ui.ts",
  "lib/connectors/adapters/qq-official/capability.ts",
  "lib/connectors/adapters/_shared/a2ui-mapper.ts",
  "lib/connectors/adapters/_shared/inbound-media.ts",
  "lib/connectors/a2ui-bridge/a2ui-to-segments.ts",
]
async function sourceHashes() {
  return Object.fromEntries(
    await Promise.all(
      sourcePaths.map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(path.join(root, file)))
          .digest("hex"),
      ])
    )
  )
}
const before = await sourceHashes()
const bundle = path.join(output, "production-projection.cjs")
await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      'export * from "./lib/connectors/adapters/qq-official/serialize"',
      'export * from "./lib/connectors/adapters/qq-official/a2ui-mapper"',
      'export * from "./lib/connectors/adapters/qq-official/inbound-to-a2ui"',
      'export * from "./lib/connectors/adapters/qq-official/capability"',
      'export { buildA2UISegment, assistantReplyToSegments } from "./lib/connectors/a2ui-bridge/a2ui-to-segments"',
    ].join("\n"),
    resolveDir: root,
    loader: "ts",
  },
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "cjs",
  packages: "external",
  plugins: [
    {
      name: "deny-effects",
      setup(bundler) {
        // Keep the exact pure URL predicate while excluding the unrelated
        // attachment downloader/document runtime imported by this shared file.
        bundler.onResolve({ filter: /\/inbound-media$/ }, () => ({
          path: "lib/connectors/adapters/_shared/inbound-media.ts",
          namespace: "audit-pure-source",
        }))
        bundler.onLoad({ filter: /.*/, namespace: "audit-pure-source" }, async (args) => {
          const source = await readFile(path.join(root, args.path), "utf8")
          const predicate = source.match(
            /export function isPublicHttpUrl\(raw: string\): boolean \{[^}]+\}/
          )?.[0]
          assert.ok(predicate, "Pure URL predicate must still match the audited source shape")
          return {
            contents: 'import { evaluateFetchTarget } from "@cognia/network-guard"\n' + predicate,
            loader: "ts",
            resolveDir: root,
          }
        })
        bundler.onResolve({ filter: /^@\/lib\/(db\/schema|telemetry\/inbox-events)$/ }, (args) => ({
          path: args.path,
          namespace: "audit-boundary",
        }))
        bundler.onLoad({ filter: /.*/, namespace: "audit-boundary" }, (args) => ({
          contents: args.path.includes("db/schema")
            ? 'export function getDb() { throw new Error("Audit forbids database access") }'
            : 'export function trackInboxEvent() { throw new Error("Audit forbids telemetry") }',
          loader: "js",
        }))
      },
    },
  ],
})
const { default: api } = await import(pathToFileURL(bundle).href)
const observations = []
const request = (scene, segments) => ({
  conversationRef: {
    platform: "qq-official",
    adapterId: "audit",
    scene,
    sceneId: "fixture-chat",
    msgId: "fixture-message",
  },
  segments,
  metadata: { idempotencyKey: "audit-only" },
})
async function project(scene, surface) {
  const segment = api.buildA2UISegment("audit-surface", surface)
  const prepared = await api.prepareQQKeyboards(request(scene, [segment]))
  return { segment, calls: api.serializeOutboundParts(prepared.request, false) }
}
function record(id, evidence) {
  observations.push({ id, ...evidence })
}

for (const scene of ["group", "c2c"]) {
  const md =
    "# Heading\n## Subheading\n**bold** _italic_ ~~deleted~~\n\n- one\n\n> quote\n\n[Docs](https://example.org/docs)\n![image #100px #100px](https://example.org/image.png)"
  const call = api.serializeOutbound(request(scene, [{ type: "markdown", md }]), false)
  assert.equal(call.payload.msg_type, 2)
  assert.equal(call.payload.markdown.content, md)
  assert.equal(call.payload.content, undefined)
  record(`supported-markdown-${scene}`, { nativeType: 2, sourcePreserved: true })

  const basic = await project(scene, {
    rootId: "card",
    dataModel: {},
    components: {
      card: { component: "Card", title: "Summary", children: ["body", "go"] },
      body: { component: "Text", text: "Literal **text**", variant: "heading3" },
      go: { component: "Button", text: "Open", href: "https://example.org" },
    },
  })
  assert.equal(basic.calls[0].payload.msg_type, 2)
  assert.match(basic.calls[0].payload.markdown.content, /## Summary/)
  assert.match(basic.calls[0].payload.markdown.content, /\*\*Literal/)
  assert.equal(basic.calls[0].payload.keyboard.content.rows[0].buttons[0].action.type, 0)
  record(`supported-basic-card-${scene}`, { nativeMarkdown: true, linkButton: true })

  const tuwen = {
    type: "card",
    card: {
      kind: "qq-tuwen",
      payload: {
        type: "tuwen",
        content: {
          title: "Article",
          description: "Article summary",
          url: "https://example.org/article",
          pic_url: "https://example.org/cover.png",
        },
      },
    },
  }
  const prepared = await api.prepareQQKeyboards(request(scene, [tuwen]))
  assert.throws(() => api.serializeOutboundParts(prepared.request, false), /opaque cards/)
  assert.equal(api.QQ_OFFICIAL_CAPS.includes("send.card"), false)
  record(`gap-tuwen-${scene}`, { documentedType: 8, adapterRejects: true })

  const rich = {
    rootId: "card",
    dataModel: {},
    components: {
      card: { component: "Card", title: "Article", children: ["image", "link"] },
      image: { component: "Image", src: "https://example.org/cover.png", alt: "Cover" },
      link: { component: "Link", href: "https://example.org/article", text: "Read article" },
    },
  }
  const richResult = await project(scene, rich)
  const richPayload = JSON.stringify(richResult.calls[0].payload)
  assert.equal(richResult.calls[0].payload.msg_type, 0)
  assert.equal(richPayload.includes("https://example.org"), false)
  record(`limit-rich-projection-${scene}`, {
    content: richResult.calls[0].payload.content,
    sourceImageAndLinkLost: true,
    downgrades: richResult.calls[0].downgrades,
  })

  const fallback = {
    rootId: "card",
    dataModel: {},
    widget: { fallbackText: "Revenue: 123 units; see https://example.org/report" },
    components: {
      card: { component: "Card", title: "Report", children: ["table"] },
      table: {
        component: "Table",
        columns: [{ key: "amount", label: "Revenue" }],
        data: [{ amount: 123 }],
      },
    },
  }
  const plain = await project(scene, fallback)
  assert.equal(plain.calls[0].payload.content, fallback.widget.fallbackText)
  const withButton = await project(scene, {
    ...fallback,
    components: {
      ...fallback.components,
      card: { ...fallback.components.card, children: ["table", "go"] },
      go: { component: "Button", text: "Details", href: "https://example.org/report" },
    },
  })
  assert.equal(withButton.calls[0].payload.markdown.content.includes("123"), false)
  assert.match(withButton.calls[0].payload.markdown.content, /Table/)
  record(`gap-fallback-with-button-${scene}`, {
    withoutButton: plain.calls[0].payload.content,
    withButton: withButton.calls[0].payload.markdown.content,
    providedFallbackLost: true,
  })

  const keyboardOnly = await api.prepareQQKeyboards(
    request(scene, [
      {
        type: "card",
        card: {
          kind: "qq-keyboard",
          payload: { content: "Choose", keyboard: { id: "fixture-template" } },
        },
      },
    ])
  )
  const keyboardCall = api.serializeOutboundParts(keyboardOnly.request, false)[0]
  assert.equal(keyboardCall.payload.msg_type, 0)
  assert.deepEqual(keyboardCall.payload.keyboard, { id: "fixture-template" })
  record(`gap-keyboard-text-${scene}`, {
    msgType: 0,
    markdownMissing: keyboardCall.payload.markdown === undefined,
    scope: "low-level qq-keyboard segment; ordinary A2UI uses Markdown",
  })
}

for (const scene of ["channel", "direct"]) {
  const call = api.serializeOutbound(request(scene, [{ type: "markdown", md: "**Bold**" }]), false)
  assert.equal(call.payload.markdown, undefined)
  assert.equal(call.payload.content, "**Bold**")
  record(`limit-guild-markdown-${scene}`, { payload: call.payload, downgrades: call.downgrades })
}

const inbound = api.qqOfficialInboundToA2UI({
  op: 0,
  t: "GROUP_MESSAGE_CREATE",
  d: {
    id: "fixture",
    group_openid: "fixture-group",
    message_type: 3,
    ark_data: {
      ark_type: "contact_card",
      ark_name: "Contact",
      fields: {
        nickname: "Alice",
        avatar: "https://example.org/avatar.png",
        source_logo: "https://example.org/source.png",
      },
    },
  },
})
assert.ok(inbound)
assert.equal(inbound.raw.d.ark_data.fields.avatar, "https://example.org/avatar.png")
assert.equal(JSON.stringify(inbound.body).includes("https://example.org/avatar.png"), false)
assert.equal(JSON.stringify(inbound.body).includes("https://example.org/source.png"), false)
record("limit-inbound-card-portraits", { rawFieldsRetained: true, body: inbound.body })

const dialect =
  "### Heading three\n\n```ts\nconst x = 1\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n$x^2$"
const dialectCalls = api.serializeOutboundParts(
  request("group", api.assistantReplyToSegments({ text: dialect })),
  false
)
assert.equal(dialectCalls[0].payload.markdown.content, dialect)
record("limit-markdown-dialect", {
  deepHeadingsCodeTablesMathPassedThrough: true,
  scope: "no QQ dialect conversion; actual unsupported-syntax display is not observed",
})

const after = await sourceHashes()
assert.deepEqual(after, before)
await writeFile(
  path.join(output, "probe-results.json"),
  JSON.stringify(
    {
      date: "2026-11-10",
      environment: { platform: process.platform, arch: process.arch, node: process.version },
      productionSourceHashes: after,
      scope: "Real projection/parser/serializer code; DB and telemetry boundaries throw; no HTTP.",
      observations,
    },
    null,
    2
  ) + "\n"
)
console.log(`${observations.length} characterization probes passed; source hashes unchanged.`)
