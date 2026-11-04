/**
 * A2UI Constants Tests
 */

import { CATEGORY_KEYS, CATEGORY_I18N_MAP, surfaceStyles, contentStyles } from "./constants"

describe("CATEGORY_KEYS", () => {
  it("should contain expected category keys", () => {
    expect(CATEGORY_KEYS).toContain("productivity")
    expect(CATEGORY_KEYS).toContain("data")
    expect(CATEGORY_KEYS).toContain("form")
    expect(CATEGORY_KEYS).toContain("utility")
    expect(CATEGORY_KEYS).toContain("social")
  })

  it("should have 5 categories", () => {
    expect(CATEGORY_KEYS).toHaveLength(5)
  })
})

describe("CATEGORY_I18N_MAP", () => {
  it("should have an i18n key for every category", () => {
    for (const key of CATEGORY_KEYS) {
      expect(CATEGORY_I18N_MAP).toHaveProperty(key)
      expect(typeof CATEGORY_I18N_MAP[key]).toBe("string")
    }
  })

  it('should have i18n keys starting with "category"', () => {
    for (const value of Object.values(CATEGORY_I18N_MAP)) {
      expect(value).toMatch(/^category/)
    }
  })
})

describe("surfaceStyles", () => {
  it("should define styles for all surface types", () => {
    expect(surfaceStyles).toHaveProperty("inline")
    expect(surfaceStyles).toHaveProperty("dialog")
    expect(surfaceStyles).toHaveProperty("panel")
    expect(surfaceStyles).toHaveProperty("fullscreen")
  })

  it("should have string values for all surface types", () => {
    for (const value of Object.values(surfaceStyles)) {
      expect(typeof value).toBe("string")
    }
  })
})

describe("contentStyles", () => {
  it("should define styles for all surface types", () => {
    expect(contentStyles).toHaveProperty("inline")
    expect(contentStyles).toHaveProperty("dialog")
    expect(contentStyles).toHaveProperty("panel")
    expect(contentStyles).toHaveProperty("fullscreen")
  })

  it("should match surfaceStyles keys", () => {
    expect(Object.keys(contentStyles).sort()).toEqual(Object.keys(surfaceStyles).sort())
  })
})
