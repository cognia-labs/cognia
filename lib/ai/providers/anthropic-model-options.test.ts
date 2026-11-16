import { getBuiltInProviderCatalogEntry } from "@cognia/provider-types/built-in-provider-catalog"

import { MODEL_PRESET_VALUES, modelPresetOptions } from "./anthropic-model-options"

describe("modelPresetOptions", () => {
  it("offers exactly the models the Anthropic catalog carries", () => {
    // The hand-maintained list had gone stale in every direction: two entries
    // with no i18n label, two orphaned keys with no entry, one id the catalog
    // does not use, and no Claude-5 even though the default is one.
    const anthropic = getBuiltInProviderCatalogEntry("anthropic")
    expect(
      modelPresetOptions()
        .map((option) => option.id)
        .sort()
    ).toEqual(anthropic?.models?.map((model) => model.id).sort())
  })

  it("leads with the catalog's default", () => {
    const anthropic = getBuiltInProviderCatalogEntry("anthropic")
    expect(modelPresetOptions()[0]?.id).toBe(anthropic?.defaultModel)
  })

  it("carries a display name for every option", () => {
    for (const option of modelPresetOptions()) {
      expect(option.name.length).toBeGreaterThan(0)
    }
  })

  it("has no duplicates", () => {
    expect(new Set(MODEL_PRESET_VALUES).size).toBe(MODEL_PRESET_VALUES.length)
  })
})
