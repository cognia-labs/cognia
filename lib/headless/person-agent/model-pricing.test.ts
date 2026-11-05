import type { SessionUsageRow } from "@/lib/db/session-usage"

import {
  currentPersonModelPricing,
  priceMemberUsageRow,
  readPersonModelPricing,
  rememberPersonModelPricing,
} from "./model-pricing"

function row(overrides: Partial<SessionUsageRow> = {}): SessionUsageRow {
  return {
    messageId: "assistant-1",
    sessionId: "s1",
    at: 1,
    model: "org-model",
    providerId: "org",
    inputTokens: 1_000_000,
    outputTokens: 500_000,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    costKnown: false,
    costSource: "unknown",
    durationMs: 0,
    surface: "chat",
    ...overrides,
  }
}

const noCatalog = () => null

describe("member usage pricing (ADR-0253 §10)", () => {
  afterEach(() => rememberPersonModelPricing({}))

  it("keeps a figure the runtime reported", () => {
    const reported = row({ costUsd: 0.42, costKnown: true, costSource: "sdk" })
    expect(
      priceMemberUsageRow(reported, {
        deployment: { org: { "org-model": { promptPer1M: 9, completionPer1M: 9 } } },
      })
    ).toBe(reported)
  })

  it("books the deployment's price first, with the rates it used", () => {
    const priced = priceMemberUsageRow(row(), {
      deployment: { org: { "org-model": { promptPer1M: 0.6, completionPer1M: 2.2 } } },
      catalog: () => ({ promptPer1M: 100, completionPer1M: 100 }),
    })
    expect(priced.costUsd).toBeCloseTo(0.6 + 1.1)
    expect(priced).toMatchObject({
      costKnown: true,
      costSource: "custom",
      priceSnapshot: { promptPer1M: 0.6, completionPer1M: 2.2, currency: "USD" },
    })
  })

  it("prices cached input at the deployment's cache rate", () => {
    const priced = priceMemberUsageRow(
      row({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }),
      {
        deployment: {
          org: { "org-model": { promptPer1M: 1, completionPer1M: 1, cachedInputPer1M: 0.25 } },
        },
      }
    )
    expect(priced.costUsd).toBeCloseTo(0.25)
  })

  it("falls back to the catalog by model id, then to unpriced, never to free", () => {
    const catalog = jest.fn((_provider: string | undefined, model: string | undefined) =>
      model === "known" ? { promptPer1M: 3, completionPer1M: 15 } : null
    )
    expect(priceMemberUsageRow(row({ model: "known" }), { deployment: {}, catalog })).toMatchObject(
      { costUsd: 3 + 7.5, costKnown: true, costSource: "derived" }
    )
    expect(catalog).toHaveBeenCalledWith("org", "known")
    expect(
      priceMemberUsageRow(row({ costSource: undefined, costKnown: undefined }), {
        deployment: {},
        catalog: noCatalog,
      })
    ).toMatchObject({ costUsd: 0, costKnown: false, costSource: "unknown" })
    // A catalog entry with no token rate is no price for a chat turn.
    expect(
      priceMemberUsageRow(row(), { deployment: {}, catalog: () => ({ perPageUsd: 1 }) })
    ).toMatchObject({ costSource: "unknown" })
  })

  it("uses the prices the Host gave last", () => {
    rememberPersonModelPricing({ org: { "org-model": { promptPer1M: 2, completionPer1M: 2 } } })
    expect(currentPersonModelPricing().org?.["org-model"]?.promptPer1M).toBe(2)
    expect(priceMemberUsageRow(row(), { catalog: noCatalog })).toMatchObject({
      costUsd: 3,
      costSource: "custom",
    })
  })

  it("reads only valid prices of served models", () => {
    expect(
      readPersonModelPricing(
        {
          org: {
            "org-model": { promptPer1M: 1, completionPer1M: 2 },
            ghost: { promptPer1M: 1, completionPer1M: 2 },
            wrong: { promptPer1M: "1", completionPer1M: 2 },
          },
          other: [],
        },
        { org: ["org-model", "wrong"] }
      )
    ).toEqual({ org: { "org-model": { promptPer1M: 1, completionPer1M: 2 } } })
    expect(readPersonModelPricing(null, {})).toEqual({})
  })
})
