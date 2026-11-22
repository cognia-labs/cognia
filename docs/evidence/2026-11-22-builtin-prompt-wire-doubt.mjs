// Run from the repository root with pnpm exec tsx. All network is intercepted.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { getEncoding } from "js-tiktoken"
import { dispatchAiSdk } from "../../sidecar/src/runtimes/ai-sdk/index.ts"
import { textReplyFrames } from "../../tests/conformance/anthropic-server/sse.mjs"

const encoding = getEncoding("cl100k_base")
const count = (text) => encoding.encode(text).length
const report = (name, result) => console.log(JSON.stringify({ name, ...result }))

function rendererFixture() {
  const directory = mkdtempSync("lib/claude/prompt-doubt-")
  // Jest needs a file under lib/ and the inherited fixture's relative imports.
  // Place the copy beside the original, then remove it even if the test fails.
  const testFile = `${directory}.test.ts`
  const output = join(directory, "options.json")
  const marker = "SYNTHETIC_PER_TURN_CONTEXT"
  const inherited = readFileSync("lib/claude/build-options.test.ts", "utf8")
  try {
    writeFileSync(
      testFile,
      inherited +
        `

it("audit: capture real renderer prompt composition", async () => {
  const { writeFileSync } = await import("node:fs")
  const { __resetContextContributionsForTests } = await import(
    "@/lib/ai/agent/execution/contributions/context-contributions"
  )
  const contributions: readonly import("@/lib/modules/manifest-types").ContextContribution[] = [{
    id: "audit-fixture", cache: "turn", slot: "agent-knowledge",
    produce: () => ({ text: ${JSON.stringify(marker)} }),
  }]
  __resetContextContributionsForTests()
  mockContextEntries.push({ module: "crate", stage: "stable", load: async () => ({ contributions }) })
  try {
    const { BUILT_IN_AGENT_MODES, BUILT_IN_MODE_PROMPTS } = await import("@/lib/agent/modes/built-ins")
    const { selectionFromLegacyModeId } = await import("@/lib/agent/composition/legacy-mode-mapping")
    const { PLAN_MODE_PROMPT } = await import("@/lib/agent/prompts/plan-mode")
    const legacy = BUILT_IN_MODE_PROMPTS.get("plan")!.defaultBody
    const normalPlan = await resolveSendOptions({
      session: makeSession({ id: "normal-plan" }),
      compositionSelection: selectionFromLegacyModeId("plan", new Set()).selection,
    })
    expect(normalPlan.permissionMode).toBe("plan")
    expect(normalPlan.systemPrompt ?? "").not.toContain(legacy)
    expect(normalPlan.appendSystemPrompt).toContain(PLAN_MODE_PROMPT.defaultBody)
    const explicitPlan = await resolveSendOptions({
      session: makeSession({ id: "explicit-plan" }),
      agentMode: BUILT_IN_AGENT_MODES.find((mode) => mode.id === "plan"),
    })
    expect(explicitPlan.systemPrompt).toContain(legacy)

    const scenarios = [
      { id: "off", a2uiEnabled: false, chart: false },
      { id: "on", a2uiEnabled: true, chart: false },
      { id: "chart-off", a2uiEnabled: false, chart: true },
      { id: "chart-on", a2uiEnabled: true, chart: true },
    ]
    const options = await Promise.all(scenarios.map(async ({ id, a2uiEnabled, chart }) => {
      const result = await resolveSendOptions({
        session: makeSession({ id, a2uiEnabled } as ChatSession),
        character: makeChar({ systemPrompt: "SYNTHETIC_STABLE_BASE", a2uiEnabled }),
        ...(chart ? { skillIntents: ["chart"] as const } : {}),
      })
      const { systemPrompt, appendSystemPrompt, dynamicSystemPrompt, cacheOptimizationEnabled } = result
      expect(dynamicSystemPrompt).toBe(${JSON.stringify(marker)})
      expect(appendSystemPrompt?.endsWith(dynamicSystemPrompt!)).toBe(id !== "chart-off")
      expect(appendSystemPrompt?.includes("You have the ability to generate interactive UI components")).toBe(a2uiEnabled)
      return [id, { systemPrompt, appendSystemPrompt, dynamicSystemPrompt, cacheOptimizationEnabled }]
    }))
    writeFileSync(${JSON.stringify(output)}, JSON.stringify(Object.fromEntries(options)))
  } finally {
    mockContextEntries.pop()
    __resetContextContributionsForTests()
  }
})
`,
      { flag: "wx" }
    )
    execFileSync(
      "pnpm",
      [
        "test",
        "--runInBand",
        "--runTestsByPath",
        testFile,
        "-t",
        "audit: capture real renderer prompt composition",
      ],
      { stdio: ["ignore", "inherit", "inherit"], timeout: 60_000 }
    )
    return JSON.parse(readFileSync(output, "utf8"))
  } finally {
    rmSync(testFile, { force: true })
    rmSync(output, { force: true })
    rmSync(directory, { recursive: true })
  }
}

const endpoint = "https://prompt-audit.invalid/v1/messages"
const model = "claude-sonnet-4-6"
const originalFetch = globalThis.fetch
let lastBody
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init)
  assert.equal(request.url, endpoint)
  assert.equal(request.method, "POST")
  assert.equal(lastBody, undefined, "one provider request per fixture")
  lastBody = await request.json()
  const reply = textReplyFrames({ messageId: "fixture-result", model, text: "done" }).join("")
  return new Response(reply, { headers: { "content-type": "text/event-stream" } })
}

async function capture(id, sendOptions, buildMcpTools) {
  lastBody = undefined
  let settle
  const ended = new Promise((resolve) => {
    settle = resolve
  })
  const session = dispatchAiSdk({
    provider: "anthropic",
    sessionId: id,
    firstPrompt: "Give a one-word status.",
    sendOptions: {
      model,
      providerCredentials: {
        apiKey: "synthetic",
        protocol: "anthropic",
        baseURL: "https://prompt-audit.invalid/v1",
      },
      apiSdkMaxSteps: 1,
      ...sendOptions,
    },
    emit(event) {
      if (event.type === "session_ended") settle()
    },
    log() {},
    ...(buildMcpTools ? { buildMcpTools } : {}),
  })
  assert.ok(session)
  let timer
  try {
    await Promise.race([
      ended,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Fixture timed out: ${id}`)), 8_000)
      }),
    ])
    assert.ok(lastBody, `SDK did not issue a request for ${id}`)
    return lastBody
  } finally {
    clearTimeout(timer)
    session.closeInput()
    await session.closed
  }
}

const summarize = (body) => ({
  systemTextTokens: count((body.system ?? []).map((block) => block.text).join("\n\n")),
  serializedSystemTokens: count(JSON.stringify(body.system ?? [])),
  serializedToolTokens: count(JSON.stringify(body.tools ?? [])),
  serializedRequestTokens: count(JSON.stringify(body)),
  activeToolDefinitions: body.tools?.length ?? 0,
  systemBreakpoints: (body.system ?? []).filter((block) => block.cache_control).length,
})

try {
  const options = rendererFixture()
  for (const [id, sendOptions] of Object.entries(options)) {
    const body = await capture(id, sendOptions)
    const summary = summarize(body)
    assert.equal(summary.systemBreakpoints, id === "chart-off" ? 1 : 2)
    assert.equal(
      body.system.some((block) =>
        block.text.includes("You have the ability to generate interactive UI components")
      ),
      id.endsWith("on")
    )
    report("rendererAnthropicWire", { id, ...summary })
  }
  const onlyAppend = { ...options.on }
  delete onlyAppend.systemPrompt
  const noBase = await capture("no-base", onlyAppend)
  assert.equal(noBase.system.length, 1)
  assert.ok(noBase.system[0].cache_control)
  assert.match(noBase.system[0].text, /SYNTHETIC_PER_TURN_CONTEXT/)
  const nextTail = "OTHER_PER_TURN_CONTEXT"
  const nextNoBase = await capture("no-base-2", {
    ...onlyAppend,
    appendSystemPrompt: onlyAppend.appendSystemPrompt.replace(
      onlyAppend.dynamicSystemPrompt,
      nextTail
    ),
    dynamicSystemPrompt: nextTail,
  })
  assert.ok(nextNoBase.system[0].cache_control)
  assert.notEqual(nextNoBase.system[0].text, noBase.system[0].text)
  report("dynamicTailInsideFirstBreakpoint", { ...summarize(noBase), changedAfterTailOnly: true })

  const tiny = ["alpha", "bravo", "charlie"].map((name) => ({
    name,
    description: "Lookup.",
    pluginId: "synthetic",
    jsonSchema: { type: "object" },
  }))
  const tinyCounts = []
  for (const enabled of [false, true]) {
    const body = await capture(`tiny-${enabled}`, { pluginTools: tiny, toolSearchEnabled: enabled })
    assert.equal(body.tools.length, enabled ? 1 : 3)
    tinyCounts.push(summarize(body).serializedRequestTokens)
  }
  assert.ok(tinyCounts[1] > tinyCounts[0])
  report("tinyToolSearchReversal", { eager: tinyCounts[0], deferred: tinyCounts[1] })

  for (const size of [10, 100, 500]) {
    const pluginTools = Array.from({ length: size }, (_, index) => ({
      name: `mcp__sales_workspace__lookup_purchase_orders_by_customer_${String(index).padStart(3, "0")}`,
      description: "Find purchase orders by customer, city and shipping window.",
      pluginId: "synthetic",
      jsonSchema: {
        type: "object",
        properties: {
          customerId: { type: "string", description: "Customer identifier" },
          city: { type: "string", description: "City the order shipped to" },
          since: { type: "string", description: "First shipping date, ISO format" },
        },
        required: ["customerId"],
      },
    }))
    for (const enabled of [false, true]) {
      const body = await capture(`tools-${size}-${enabled}`, {
        systemPrompt: "SYNTHETIC_STABLE_BASE",
        pluginTools,
        toolSearchEnabled: enabled,
      })
      assert.equal(Boolean(body.tools?.some((tool) => tool.name === "ToolSearch")), enabled)
      assert.equal(body.tools?.length, enabled ? 1 : size)
      const catalogBlock = body.system.find((block) =>
        block.text.startsWith("Some tools are not loaded")
      )
      assert.equal(Boolean(catalogBlock), enabled)
      if (catalogBlock) assert.ok(catalogBlock.text.includes(pluginTools.at(-1).name))
      report("deferredAnthropicWire", {
        size,
        enabled,
        catalogTextTokens: catalogBlock ? count(catalogBlock.text) : 0,
        ...summarize(body),
      })
    }
  }
} finally {
  globalThis.fetch = originalFetch
}
