import { contextSourcesOf } from "./context-sources"

describe("contextSourcesOf", () => {
  it("reads one contribution's report from SendOptions.contextSources", () => {
    const sources = {
      "knowledge-base.retrieval": {
        retrievedChunks: [],
        citations: [],
        failures: [],
        budget: { limit: 10, used: 0, truncated: false },
        degraded: true,
      },
    }
    expect(contextSourcesOf(sources, "knowledge-base.retrieval")?.degraded).toBe(true)
    expect(contextSourcesOf(undefined, "knowledge-base.retrieval")).toBeUndefined()
    expect(contextSourcesOf({}, "knowledge-base.retrieval")).toBeUndefined()
  })
})
