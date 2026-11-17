import { partLabelsFrom } from "./labels"

const t = (key: string, values?: Record<string, string | number | Date>) =>
  values ? `${key}:${JSON.stringify(values)}` : key

describe("partLabelsFrom", () => {
  it("reads every label under parts.*", () => {
    const labels = partLabelsFrom(t)
    expect(labels.thinking).toBe("parts.thinking")
    expect(labels.tool("Bash")).toBe('parts.tool:{"name":"Bash"}')
    expect(labels.privateSources(2)).toBe('parts.privateSources:{"count":2}')
    expect(labels.artifact("Plan", "code")).toBe('parts.artifact:{"title":"Plan","kind":"code"}')
  })

  it("translates a known gate decision and verdict, and shows an unknown one as stored", () => {
    const labels = partLabelsFrom(t)
    expect(labels.squadGate("Budget", "approved")).toBe(
      'parts.squadGate:{"title":"Budget","decision":"parts.gateDecision.approved"}'
    )
    expect(labels.squadGate("Budget", "escalated")).toBe(
      'parts.squadGate:{"title":"Budget","decision":"escalated"}'
    )
    expect(labels.verification("pass")).toBe('parts.verification:{"verdict":"parts.verdict.pass"}')
    expect(labels.verification("odd")).toBe('parts.verification:{"verdict":"odd"}')
  })
})
