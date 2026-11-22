import assert from "node:assert/strict"
import { hasNoLeakingPii } from "@cognia/redact"
import { getEncoding } from "js-tiktoken"
import { clearRegistry, registerComponent } from "../../lib/a2ui/catalog.ts"
import { port as a2ui } from "../../lib/a2ui/ports/system-prompt.ts"
import { resolveA2UICatalogId } from "../../lib/a2ui/runtime-settings.ts"
import {
  COMMAND_JUDGE_PROMPT,
  judgeCommandSafety,
} from "../../lib/ai/agent/execution/permissions/command-judge.ts"
import { estimateFallbackTokens } from "../../lib/ai/tokens/fallback-estimator.ts"
import { buildVisualOutputSection } from "../../lib/ai/prompts/visual-output-prompts.ts"
import {
  digestEvalDependency,
  readEvalTargetDependency,
} from "../../lib/ai/eval/project-service.ts"
import { listPromptDefinitions, loadPromptCatalog } from "../../lib/prompts/catalog.ts"
import { recentPromptResolutions } from "../../lib/prompts/resolution-log.ts"
import { renderPromptTemplate, validatePromptBody } from "../../lib/prompts/template.ts"
import { createAiSdkToolSearchController } from "../../sidecar/src/tools/adapters/ai-sdk-tool-search.ts"

const cl100k = getEncoding("cl100k_base")
const o200k = getEncoding("o200k_base")
const tokens = (text) => ({
  cl100k: cl100k.encode(text).length,
  o200k: o200k.encode(text).length,
})
const report = (name, result) => console.log(JSON.stringify({ name, ...result }))

async function main() {
  const { failures } = await loadPromptCatalog()
  const definitions = listPromptDefinitions()
  const editable = definitions.filter((definition) => definition.operation !== "inspect-only")
  const invalidDefaults = editable.flatMap((definition) =>
    validatePromptBody(definition, definition.defaultBody).map((issue) => ({
      id: definition.id,
      issue,
    }))
  )
  assert.equal(failures.length, 0)
  assert.equal(invalidDefaults.length, 0)
  const bodies = definitions
    .map(({ id, defaultBody }) => ({ id, ...tokens(defaultBody) }))
    .sort((left, right) => right.cl100k - left.cl100k)
  const quantile = (encoding, fraction) => {
    const ordered = bodies.map((body) => body[encoding]).sort((left, right) => left - right)
    return ordered[Math.ceil(ordered.length * fraction) - 1]
  }
  report("catalog", {
    total: definitions.length,
    editable: editable.length,
    inspectOnly: definitions.length - editable.length,
    failures: failures.length,
    invalidDefaults: invalidDefaults.length,
    p50: { cl100k: quantile("cl100k", 0.5), o200k: quantile("o200k", 0.5) },
    p95: { cl100k: quantile("cl100k", 0.95), o200k: quantile("o200k", 0.95) },
    longerThan1000: bodies.filter((body) => body.cl100k > 1000).length,
    largest: bodies.slice(0, 10),
  })

  const visual = (enabled) =>
    buildVisualOutputSection({ artifacts: "tools", a2ui: enabled, inlineCharts: true })
  const a2uiSection = a2ui.systemSection({})
  const plainChat = visual(false)
  const a2uiChat = [a2uiSection, visual(true)].join("\n\n")
  const a2uiWithoutOtherChartRoutes = buildVisualOutputSection({
    artifacts: "disabled",
    a2ui: true,
    inlineCharts: false,
  })
  assert.match(
    a2uiSection,
    /Use an A2UI Chart or Table when it sits inside a surface that also has controls/
  )
  assert.match(a2uiWithoutOtherChartRoutes, /prefer an A2UI Chart when this channel supports it/)
  report("visualPrompt", {
    defaultA2uiProtocol: tokens(a2uiSection),
    visualRoutingOnly: tokens(plainChat),
    a2uiPlusVisualRouting: tokens(a2uiChat),
    staticChartRouteDisagreement: true,
  })

  const catalogId = "audit-catalog"
  const component = "AuditStatus"
  registerComponent(component, () => null, { catalogId })
  try {
    assert.equal(resolveA2UICatalogId(undefined, catalogId), catalogId)
    assert.ok(!a2ui.systemSection({}).includes(component))
    assert.ok(a2ui.systemSection({ catalogId }).includes(component))
    report("a2uiAppCatalog", { rendererSelectsIt: true, promptWithNoAgentCatalogIncludesIt: false })
  } finally {
    clearRegistry()
  }

  const fixtureTool = { description: "查找历史订单并按收货城市过滤" }
  const orderSearch = createAiSdkToolSearchController({
    tools: { lookup_orders_by_city: fixtureTool },
    sendOptions: { toolSearchEnabled: true },
  })
  const search = orderSearch.tools.ToolSearch.execute
  const zh = JSON.parse(await search({ query: "历史订单" }))
  const en = JSON.parse(await search({ query: "orders city" }))
  const exact = JSON.parse(await search({ query: "select:lookup_orders_by_city" }))
  assert.deepEqual(zh.activated, [])
  // Control: the controller can find and activate the same tool.
  assert.deepEqual(en.activated, ["lookup_orders_by_city"])
  assert.deepEqual(exact.activated, ["lookup_orders_by_city"])
  report("toolSearchQueries", {
    chineseActivated: zh.activated.length,
    englishActivated: en.activated.length,
    exactActivated: exact.activated.length,
  })

  for (const cap of [1, 2, 5]) {
    const controller = createAiSdkToolSearchController({
      tools: {
        search_records: { description: "find matching records" },
        zed: { description: "search records" },
        zzed: { description: "search records" },
      },
      sendOptions: { toolSearchEnabled: true },
      maxActiveTools: cap,
    })
    const result = JSON.parse(
      await controller.tools.ToolSearch.execute({ query: "search records" })
    )
    assert.equal(result.matches[0].name, "search_records")
    assert.deepEqual(
      result.activated,
      {
        1: [],
        2: ["zzed"],
        5: ["search_records", "zed", "zzed"],
      }[cap]
    )
    report("toolSearchLowCap", { cap, bestMatch: result.matches[0].name, active: result.activated })
  }

  const catalog = (size) =>
    createAiSdkToolSearchController({
      tools: Object.fromEntries(
        Array.from({ length: size }, (_, index) => [
          `mcp__sales_workspace__lookup_purchase_orders_by_customer_${String(index).padStart(3, "0")}`,
          fixtureTool,
        ])
      ),
      sendOptions: { toolSearchEnabled: true },
    })
  report("deferredToolNamesOnly", {
    ten: tokens(catalog(10).deferredToolsPrompt()),
    hundred: tokens(catalog(100).deferredToolsPrompt()),
    fiveHundred: tokens(catalog(500).deferredToolsPrompt()),
  })

  const template = { variables: [{ name: "excerpt", required: true, maxChars: 1024 }] }
  const enText = "The parser reads messages and checks the selected mode. ".repeat(30)
  const zhText = "收到新消息后解析器会检查所选模式以及工作区中的设置。".repeat(50)
  const render = (excerpt) => renderPromptTemplate(template, "{{excerpt}}", { excerpt })
  for (const [language, sample] of [
    ["en", enText],
    ["zh", zhText],
  ]) {
    const text = render(sample)
    assert.equal(text.length, 1024)
    report("sameCharacterBudget", {
      language,
      chars: text.length,
      fallbackEstimate: estimateFallbackTokens(text),
      ...tokens(text),
    })
  }

  // The target is scoped to agent A. Supply DB reads with one agent B binding
  // and no account settings, so the probe never reads a user's database.
  let bindings = []
  const scope = {
    assertActive() {},
    db: {
      settings: { get: async () => undefined },
      characters: { get: async (id) => ({ id }) },
      promptOverrides: { toArray: async () => bindings },
      promptOverrideRevisions: {
        bulkGet: async (ids) =>
          ids.map(() => ({ kind: "published", body: "Agent B only", contractVersion: 1 })),
      },
    },
  }
  const variant = { kind: "chat", id: "fixture", targetId: "agent-A" }
  const hash = async (selected) =>
    digestEvalDependency(await readEvalTargetDependency(selected, scope))
  const before = await hash(variant)
  const model = { ...variant, kind: "model" }
  const modelBefore = await hash(model)
  bindings = [
    {
      promptId: "chat.brief-mode",
      scope: "agent",
      targetId: "agent-B",
      activeRevisionId: "published-B",
    },
  ]
  const after = await hash(variant)
  const modelAfter = await hash(model)
  assert.notEqual(before, after)
  assert.equal(modelBefore, modelAfter)
  report("evalDigest", {
    unrelatedAgentPublishChangedDigest: before !== after,
    modelControlChanged: modelBefore !== modelAfter,
  })

  let modelCalls = 0
  const client = {
    async complete() {
      modelCalls++
      return '{"safe":true,"risk":"low","reason":"Read-only fixture"}'
    },
  }
  // No command executes. The stub records calls to the model boundary.
  const fixture = "pwd"
  const opts = { contextKey: "audit-fixture", cwd: "/synthetic" }
  assert.equal((await judgeCommandSafety(client, fixture, opts)).safe, true)
  assert.equal((await judgeCommandSafety(client, fixture, opts)).safe, true)
  const resolutions = recentPromptResolutions().filter(
    ({ promptId }) => promptId === COMMAND_JUDGE_PROMPT.id
  ).length
  assert.equal(modelCalls, 1)
  assert.equal(resolutions, 2)
  report("promptUsage", { resolutions, modelCalls })

  const fixtureContact = "sample@example.invalid"
  const captured = []
  const captureClient = {
    async complete(prompt) {
      captured.push(prompt)
      return '{"safe":true,"risk":"low","reason":"Read-only fixture"}'
    },
  }
  assert.equal(await judgeCommandSafety(captureClient, fixtureContact), null)
  assert.deepEqual(captured, [])
  await judgeCommandSafety(captureClient, fixture, { cwd: "/synthetic/neutral" })
  await judgeCommandSafety(captureClient, fixture, { cwd: `/synthetic/${fixtureContact}` })
  assert.equal(captured.length, 2)
  assert.ok(hasNoLeakingPii(captured[0]))
  assert.ok(!hasNoLeakingPii(captured[1]))
  report("judgeFinalInputGate", {
    commandGateWorked: true,
    cwdInputReachedClientBeforeWholePromptGate: true,
  })
}

await main()
