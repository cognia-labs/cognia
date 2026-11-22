import { runEndToEndMemoryEval } from "./e2e-memory-eval"

describe("runEndToEndMemoryEval", () => {
  it("passes all 6 end-to-end LongMemEval and governance dimensions with zero leaks", async () => {
    const report = await runEndToEndMemoryEval()

    expect(report.cases).toHaveLength(6)
    expect(report.cases.filter((c) => !c.passed)).toEqual([])
    expect(report.overallAccuracy).toBe(1)
    expect(report.knowledgeUpdateAccuracy).toBe(1)
    expect(report.abstentionAccuracy).toBe(1)
    expect(report.citationPrecision).toBe(1)
    expect(report.unsupportedAssertionRate).toBe(0)
    expect(report.provenanceBlockRate).toBe(1)

    expect(report.byAbility["single-session-extraction"].accuracy).toBe(1)
    expect(report.byAbility["knowledge-update"].accuracy).toBe(1)
    expect(report.byAbility["multi-session-reasoning"].accuracy).toBe(1)
    expect(report.byAbility["temporal-reasoning"].accuracy).toBe(1)
    expect(report.byAbility["abstention"].accuracy).toBe(1)
    expect(report.byAbility["provenance-and-sensitivity"].accuracy).toBe(1)

    expect(report.latencyMs.p95).toBeGreaterThanOrEqual(0)
    expect(report.tokens.maxUsed).toBeLessThanOrEqual(900)
    expect(report.tokens.budgetUtilization).toBeGreaterThan(0)
    expect(report.tokens.budgetUtilization).toBeLessThanOrEqual(1)
  })
})
