import { resolveModelsDevProviderId, resolveOurProviderId } from "./models-dev-id-map"

describe("Provider catalog ID metadata", () => {
  it.each([
    ["qwen", "alibaba"],
    ["moonshot", "moonshotai"],
    ["zhipu", "zhipuai"],
  ])("keeps visual identity separate from the models.dev ID for %s", (id, devId) => {
    expect(resolveModelsDevProviderId(id)).toBe(devId)
    expect(resolveOurProviderId(devId)).toBe(id)
  })
  it.each(["constructor", "__proto__", "unknown"])("does not invent a catalog ID for %s", (id) => {
    expect(resolveModelsDevProviderId(id)).toBeUndefined()
    expect(resolveOurProviderId(id)).toBeUndefined()
  })
})
