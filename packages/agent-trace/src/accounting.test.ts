import type { AgentTraceSpan } from "./types"
import { accountingContributions } from "./accounting"

const usage = (inputTokens: number) => ({
  inputTokens,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
})
const span = (spanId: string, extra: Partial<AgentTraceSpan> = {}): AgentTraceSpan => ({
  id: spanId,
  spanId,
  traceId: "trace",
  startTime: 0,
  operationName: "invoke_agent",
  providerName: "openai",
  sessionId: "s",
  surface: "chat",
  ...extra,
})
const totals = (spans: AgentTraceSpan[]) =>
  accountingContributions(spans).reduce(
    (sum, row) => ({
      cost: sum.cost + (row.costUsdEstimate ?? 0),
      input: sum.input + (row.usage?.inputTokens ?? 0),
    }),
    { cost: 0, input: 0 }
  )

it("counts one measurement for an explicit mirror, with independent metric fallback", () => {
  const root = span("root", { usage: usage(100), costUsdEstimate: 0.01 })
  const mirror = span("mirror", {
    parentSpanId: "root",
    operationName: "chat",
    usage: usage(100),
    costUsdEstimate: 0.01,
    metadata: { accountingParentSpanId: "root" },
  })
  expect(totals([root, mirror])).toEqual({ cost: 0.01, input: 100 })
  expect(totals([{ ...root, costUsdEstimate: undefined }, mirror])).toEqual({
    cost: 0.01,
    input: 100,
  })
  expect(totals([mirror])).toEqual({ cost: 0.01, input: 100 })
})

it("keeps full inclusive totals when only a partial child is present", () => {
  expect(
    totals([
      span("root", {
        usage: usage(100),
        costUsdEstimate: 1,
        metadata: { accountingScope: "aggregate" },
      }),
      span("child", { parentSpanId: "root", usage: usage(30), costUsdEstimate: 0.3 }),
    ])
  ).toEqual({ cost: 1, input: 100 })
})

it("preserves unrelated charges, legacy roots and trace boundaries", () => {
  const root = span("root", { usage: usage(100), costUsdEstimate: 1 })
  const independent = span("embed", {
    parentSpanId: "root",
    operationName: "embeddings",
    costUsdEstimate: 0.2,
  })
  const otherTrace = span("mirror", {
    traceId: "other",
    costUsdEstimate: 0.4,
    metadata: { accountingParentSpanId: "root" },
  })
  expect(totals([root, independent, otherTrace, root])).toEqual({ cost: 1.6, input: 100 })
})

it("handles cyclic and orphan parents without losing independent metrics", () => {
  expect(
    totals([
      span("a", { parentSpanId: "b", costUsdEstimate: 1 }),
      span("b", { parentSpanId: "a", costUsdEstimate: 2 }),
    ])
  ).toEqual({ cost: 3, input: 0 })
})

it("retains partial inclusive lower bounds independently for usage and cost", () => {
  const parent = span("p", {
    usage: usage(100),
    costUsdEstimate: 1,
    metadata: { accountingScope: "aggregate", usageKnown: false, costKnown: false },
  })
  const child = span("c", { parentSpanId: "p", usage: usage(30), costUsdEstimate: 0.3 })
  expect(totals([parent, child])).toEqual({ input: 100, cost: 1 })
  expect(totals([parent, { ...child, usage: usage(130), costUsdEstimate: 1.3 }])).toEqual({
    input: 130,
    cost: 1.3,
  })
  expect(
    totals([
      { ...parent, metadata: { accountingScope: "aggregate", usageKnown: true, costKnown: false } },
      child,
    ])
  ).toEqual({ input: 100, cost: 1 })
})

it("collapses sibling mirrors before folding partial ownership but retains missing-owner bills", () => {
  const parent = span("p", {
    usage: usage(10),
    costUsdEstimate: 0.1,
    metadata: { usageKnown: false, costKnown: false },
  })
  const mirror = (id: string) =>
    span(id, { usage: usage(30), costUsdEstimate: 0.3, metadata: { accountingParentSpanId: "p" } })
  expect(totals([parent, mirror("a"), mirror("b")])).toEqual({ input: 30, cost: 0.3 })
  expect(totals([span("p"), mirror("a"), mirror("b")])).toEqual({ input: 30, cost: 0.3 })
  expect(totals([mirror("a"), mirror("b")])).toEqual({ input: 60, cost: 0.6 })
})

it("does not erase cyclic aggregate/mirror bills or unrelated squad roots", () => {
  for (const extra of [{ accountingScope: "aggregate" }, { role: "squad-run" }] as const) {
    expect(
      totals([
        span("a", { parentSpanId: "b", costUsdEstimate: 1, metadata: extra }),
        span("b", { parentSpanId: "a", costUsdEstimate: 2, metadata: extra }),
      ]).cost
    ).toBe(3)
  }
  expect(
    totals([
      span("a", { costUsdEstimate: 1, metadata: { accountingParentSpanId: "b" } }),
      span("b", { costUsdEstimate: 2, metadata: { accountingParentSpanId: "a" } }),
    ]).cost
  ).toBe(3)
  expect(
    totals([
      span("a", { costUsdEstimate: 1, metadata: { role: "squad-run" } }),
      span("b", { costUsdEstimate: 2, metadata: { role: "squad-run" } }),
    ]).cost
  ).toBe(3)
})
