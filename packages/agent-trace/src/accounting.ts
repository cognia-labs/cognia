import type { AgentTraceSpan, SpanUsage } from "./types"

export interface SpanAccountingContribution {
  span: AgentTraceSpan
  usage?: SpanUsage
  costUsdEstimate?: number
  /** Completeness of this measurement, including values supplied by its owner. */
  usageKnown?: boolean
  costKnown?: boolean
}

const identity = (span: AgentTraceSpan) => `${span.traceId}:${span.spanId}`
const isAggregate = (span: AgentTraceSpan) =>
  span.metadata?.accountingScope === "aggregate" || span.metadata?.role === "squad-run"
const TOKEN_KEYS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheCreationTokens",
] as const
const zeroUsage = (): SpanUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
})

/** Malformed cyclic ownership cannot justify suppressing a measurement. */
function removeCycles(parents: Map<string, string>): void {
  const done = new Set<string>()
  for (const start of parents.keys()) {
    const path: string[] = []
    const seen = new Map<string, number>()
    let current: string | undefined = start
    while (current && !done.has(current)) {
      const cycleAt = seen.get(current)
      if (cycleAt !== undefined) {
        for (const key of path.slice(cycleAt)) parents.delete(key)
        break
      }
      seen.set(current, path.length)
      path.push(current)
      current = parents.get(current)
    }
    for (const key of path) done.add(key)
  }
}

interface Measurement {
  key: string
  members: AgentTraceSpan[]
  anchor: AgentTraceSpan
  children: Measurement[]
  usage?: SpanUsage
  cost?: number
  usageFull: boolean
  costFull: boolean
}

/**
 * Collapse explicit mirrors of the SAME measurement before folding inclusive
 * aggregate ancestry. Partial aggregates contribute only their residual lower
 * bound. Missing owners and legacy unmarked spans stay additive. Raw span
 * values, structure, timing and outcomes are never mutated.
 */
export function accountingContributions(
  spans: readonly AgentTraceSpan[]
): SpanAccountingContribution[] {
  const unique = [...new Map(spans.map((span) => [identity(span), span])).values()]
  const byId = new Map(unique.map((span) => [identity(span), span]))
  const mirrors = new Map<string, string>()
  for (const span of unique) {
    const owner = span.metadata?.accountingParentSpanId
    const key = typeof owner === "string" ? `${span.traceId}:${owner}` : undefined
    if (key && key !== identity(span) && byId.has(key)) mirrors.set(identity(span), key)
  }
  removeCycles(mirrors)
  const groups = new Map<string, Measurement>()
  const membership = new Map<string, string>()
  for (const span of unique) {
    let key = identity(span)
    while (mirrors.has(key)) key = mirrors.get(key)!
    membership.set(identity(span), key)
    const group = groups.get(key)
    if (group) group.members.push(span)
    else
      groups.set(key, {
        key,
        members: [span],
        anchor: byId.get(key)!,
        children: [],
        usageFull: false,
        costFull: false,
      })
  }
  for (const group of groups.values()) {
    const aggregates = group.members.filter(isAggregate)
    const authorities = aggregates.length ? aggregates : [group.anchor]
    const completeUsage = authorities.find(
      (span) => span.usage && span.metadata?.usageKnown !== false
    )
    if (completeUsage) {
      group.usage = completeUsage.usage
      group.usageFull = true
    } else {
      const reported = group.members.filter((span) => span.usage)
      if (reported.length) {
        group.usage = zeroUsage()
        for (const key of TOKEN_KEYS)
          group.usage[key] = Math.max(...reported.map((span) => span.usage![key]))
        if (!aggregates.length)
          group.usageFull = reported.some(
            (span) =>
              span.metadata?.usageKnown !== false &&
              TOKEN_KEYS.every((key) => span.usage![key] === group.usage![key])
          )
      }
    }
    const priced = group.members.filter(
      (span) =>
        typeof span.costUsdEstimate === "number" &&
        Number.isFinite(span.costUsdEstimate) &&
        span.costUsdEstimate >= 0
    )
    const positive = priced.some((span) => span.costUsdEstimate! > 0)
    const completeCost = authorities.find(
      (span) =>
        typeof span.costUsdEstimate === "number" &&
        Number.isFinite(span.costUsdEstimate) &&
        span.costUsdEstimate >= 0 &&
        span.metadata?.costKnown !== false &&
        (span.costUsdEstimate > 0 || !positive || span.metadata?.costKnown === true)
    )
    if (completeCost) {
      group.cost = completeCost.costUsdEstimate
      group.costFull = true
    } else if (priced.length) {
      group.cost = Math.max(...priced.map((span) => span.costUsdEstimate!))
      if (!aggregates.length)
        group.costFull = priced.some(
          (span) => span.metadata?.costKnown !== false && span.costUsdEstimate === group.cost
        )
    }
  }

  const parents = new Map<string, string>()
  for (const group of groups.values()) {
    if (group.members.some((span) => span.metadata?.accountingScope === "independent")) continue
    let closest: { key: string; depth: number } | undefined
    for (const span of group.members) {
      const seen = new Set<string>()
      let parentId = span.parentSpanId
      let depth = 0
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId)
        const parent = byId.get(`${span.traceId}:${parentId}`)
        if (!parent) break
        depth += 1
        const parentKey = membership.get(identity(parent))!
        if (parentKey !== group.key && isAggregate(parent)) {
          if (
            !closest ||
            depth < closest.depth ||
            (depth === closest.depth && parentKey < closest.key)
          )
            closest = { key: parentKey, depth }
          break
        }
        if (parent.metadata?.accountingScope === "independent") break
        parentId = parent.parentSpanId
      }
    }
    if (closest) parents.set(group.key, closest.key)
  }
  removeCycles(parents)
  for (const [child, parent] of parents) groups.get(parent)!.children.push(groups.get(child)!)
  const contributions = new Map(
    unique.map((span) => [identity(span), { span } as SpanAccountingContribution])
  )
  const clear = (group: Measurement, metric: "usage" | "costUsdEstimate") => {
    contributions.get(identity(group.anchor))![metric] = undefined
    for (const span of group.members)
      contributions.get(identity(span))![metric === "usage" ? "usageKnown" : "costKnown"] = true
    for (const child of group.children) clear(child, metric)
  }
  const visit = (group: Measurement): { usage: SpanUsage; cost: number } => {
    const descendants = group.children.map(visit)
    const childrenUsage = zeroUsage()
    for (const key of TOKEN_KEYS)
      childrenUsage[key] = descendants.reduce((sum, child) => sum + child.usage[key], 0)
    const childrenCost = descendants.reduce((sum, child) => sum + child.cost, 0)
    const contribution = contributions.get(identity(group.anchor))!
    for (const span of group.members)
      contributions.get(identity(span))!.usageKnown = group.usageFull
    if (group.usageFull) {
      for (const child of group.children) clear(child, "usage")
      contribution.usage = group.usage
    } else if (group.usage) {
      contribution.usage = zeroUsage()
      for (const key of TOKEN_KEYS)
        contribution.usage[key] = Math.max(0, group.usage[key] - childrenUsage[key])
    }
    // An unmarked zero SDK estimate cannot erase a priced child; an explicitly
    // reported known-free call remains authoritative.
    const fullCost =
      group.costFull &&
      (group.cost !== 0 || childrenCost === 0 || group.anchor.metadata?.costKnown === true)
    for (const span of group.members) contributions.get(identity(span))!.costKnown = fullCost
    if (fullCost) {
      for (const child of group.children) clear(child, "costUsdEstimate")
      contribution.costUsdEstimate = group.cost
    } else if (group.cost !== undefined)
      contribution.costUsdEstimate = Math.max(0, group.cost - childrenCost)
    const usage = zeroUsage()
    for (const key of TOKEN_KEYS)
      usage[key] = group.usageFull
        ? group.usage![key]
        : Math.max(group.usage?.[key] ?? 0, childrenUsage[key])
    return { usage, cost: fullCost ? group.cost! : Math.max(group.cost ?? 0, childrenCost) }
  }
  for (const group of groups.values()) if (!parents.has(group.key)) visit(group)
  return [...contributions.values()]
}

/** Statistical projection only; raw spans remain available for inspection. */
export function accountingSpans(spans: readonly AgentTraceSpan[]): AgentTraceSpan[] {
  return accountingContributions(spans).map(({ span, usage, costUsdEstimate }) => ({
    ...span,
    usage,
    costUsdEstimate,
  }))
}
