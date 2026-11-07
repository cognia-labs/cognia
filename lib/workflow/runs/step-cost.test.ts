import { stepCostUsd, stepUsageFromPayload } from "./step-cost"

const tokens = { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }

describe("stepCostUsd", () => {
  it("uses the cost the node reported, zero included", () => {
    expect(stepCostUsd({ ...tokens, costUsd: 0.25, modelId: "gpt-4o" })).toBe(0.25)
    expect(stepCostUsd({ ...tokens, costUsd: 0 })).toBe(0)
  })

  it("prices a report without a cost from the model's pricing table", () => {
    const cost = stepCostUsd({ ...tokens, modelId: "gpt-4o" })
    expect(cost).toBeGreaterThan(0)
  })

  it("ignores a negative or non-finite reported cost and estimates instead", () => {
    expect(stepCostUsd({ ...tokens, costUsd: -1, modelId: "gpt-4o" })).toBe(
      stepCostUsd({ ...tokens, modelId: "gpt-4o" })
    )
    expect(stepCostUsd({ ...tokens, costUsd: Number.NaN })).toBeUndefined()
  })

  it("is undefined when nothing prices the call", () => {
    expect(stepCostUsd({ ...tokens, modelId: "mystery-model-xyz" })).toBeUndefined()
    expect(stepCostUsd(tokens)).toBeUndefined()
  })
})

describe("stepUsageFromPayload", () => {
  it("reads a usage payload, deriving totalTokens and dropping junk fields", () => {
    expect(
      stepUsageFromPayload({
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: "x",
        modelId: 3,
        providerId: "openai",
        costUsd: Number.POSITIVE_INFINITY,
      })
    ).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      providerId: "openai",
      modelId: undefined,
      costUsd: undefined,
    })
  })

  it("is null for a payload that is not an object", () => {
    expect(stepUsageFromPayload(null)).toBeNull()
    expect(stepUsageFromPayload("usage")).toBeNull()
  })
})
