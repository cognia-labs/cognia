import {
  externalTokenUsageToUsageInfo,
  usageInfoFromRecord,
  usageInfoFromUsageBlock,
} from "./usage-info"

describe("external token accounting", () => {
  it("splits explicitly cache-inclusive DSH prompts into uncached input plus cache buckets", () => {
    const usage = externalTokenUsageToUsageInfo({
      promptTokens: 33,
      promptTokensIncludeCache: true,
      completionTokens: 2,
      totalTokens: 35,
      cacheReadTokens: 20,
      cacheWriteTokens: 3,
      contextTokens: 35,
    })
    expect(usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 2,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 3,
    })
  })

  it("preserves the legacy uncached prompt convention when no inclusion marker is present", () => {
    expect(
      externalTokenUsageToUsageInfo({
        promptTokens: 10,
        completionTokens: 2,
        totalTokens: 35,
        cacheReadTokens: 20,
        cacheWriteTokens: 3,
      }).inputTokens
    ).toBe(10)
  })
})

describe("usageInfoFromUsageBlock", () => {
  it("reads the snake_case result block, cost and duration", () => {
    expect(
      usageInfoFromUsageBlock(
        {
          input_tokens: 100,
          output_tokens: 20,
          context_input_tokens: 80,
          cache_read_input_tokens: 64,
          cache_creation_input_tokens: 0,
          reasoning_tokens: 4,
          cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 0 },
          server_tool_use: { web_search: 2, web_fetch: 0 },
        },
        { totalCostUsd: 0.5, durationMs: 900 }
      )
    ).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      contextInputTokens: 80,
      cacheReadInputTokens: 64,
      cacheCreationInputTokens: 0,
      cacheCreation5mInputTokens: 3,
      reasoningTokens: 4,
      serverToolUse: { web_search: 2 },
      totalCostUsd: 0.5,
      durationMs: 900,
    })
  })

  it("keeps the ai-sdk channel's measured window apart from billing", () => {
    // A three-step turn: billing and cache reads are summed over the steps, the
    // window is the last call alone (60k prompt incl. cache + 400 output).
    const info = usageInfoFromUsageBlock({
      input_tokens: 177_000,
      output_tokens: 1_050,
      context_input_tokens: 60_000,
      context_tokens: 60_400,
      cache_read_input_tokens: 175_500,
      cache_creation_input_tokens: 0,
    })
    expect(info?.contextTokens).toBe(60_400)
    expect(info?.contextInputTokens).toBe(60_000)
  })

  it("returns null when nothing was reported", () => {
    expect(usageInfoFromUsageBlock(undefined)).toBeNull()
    expect(usageInfoFromUsageBlock({})).toBeNull()
  })
})

describe("usageInfoFromRecord", () => {
  it("converts a snake_case block and keeps a camel-case one", () => {
    expect(usageInfoFromRecord({ input_tokens: 7, output_tokens: 1 })).toEqual({
      inputTokens: 7,
      outputTokens: 1,
    })
    expect(usageInfoFromRecord({ inputTokens: 7, contextWindow: 200 })).toEqual({
      inputTokens: 7,
      contextWindow: 200,
    })
    expect(usageInfoFromRecord({ estimatedThinkingTokens: 5 })).toBeNull()
  })
})
