import {
  __resetDocsProvidersForTests,
  docsProviderPrefixes,
  getDocsProvider,
  getDocsProviderByPrefix,
  googleDocsProvider,
  larkDocsProvider,
  listDocsProviders,
} from "./index"

beforeEach(() => __resetDocsProvidersForTests())

describe("built-in docs providers", () => {
  it("registers Feishu and Google at module load, so the composer sees them synchronously", () => {
    expect(listDocsProviders().map((provider) => provider.id)).toEqual([
      larkDocsProvider.id,
      googleDocsProvider.id,
    ])
    expect(getDocsProvider("lark")).toMatchObject({
      id: larkDocsProvider.id,
      mentionPrefix: larkDocsProvider.mentionPrefix,
    })
    expect(getDocsProvider("google")).toMatchObject({
      id: googleDocsProvider.id,
      mentionPrefix: googleDocsProvider.mentionPrefix,
    })
  })

  it("claims distinct, colon-terminated mention prefixes", () => {
    expect(docsProviderPrefixes()).toEqual([
      { prefix: "lark:", providerId: "lark" },
      { prefix: "gdoc:", providerId: "google" },
    ])
    expect(getDocsProviderByPrefix("lark:")).toBe(getDocsProvider(larkDocsProvider.id))
    expect(getDocsProviderByPrefix("gdoc:")).toBe(getDocsProvider(googleDocsProvider.id))
  })

  it("keeps every provider id a valid Rust callback slug", () => {
    // `is_docs_provider_slug` in crates/cognia-connectors/src/axum_app.rs.
    for (const provider of listDocsProviders()) {
      expect(provider.id).toMatch(/^[a-z0-9-]{1,32}$/)
    }
  })

  it("declares at least one readable kind per provider", () => {
    for (const provider of listDocsProviders()) {
      expect(provider.kinds.length).toBeGreaterThan(0)
    }
  })

  it("restores exactly the built-in set after a reset", () => {
    __resetDocsProvidersForTests()
    expect(listDocsProviders()).toHaveLength(2)
  })
})
