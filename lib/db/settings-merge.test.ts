import { mergeConcurrentSettingsRow, sameSettingsValue } from "./settings-merge"

describe("sameSettingsValue", () => {
  it("compares JSON-shaped values structurally, in any key order", () => {
    expect(sameSettingsValue({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true)
    expect(sameSettingsValue({ a: 1 }, { a: 2 })).toBe(false)
    expect(sameSettingsValue([1, 2], [2, 1])).toBe(false)
  })

  it("treats a missing key as undefined, but null as a value", () => {
    expect(sameSettingsValue({ a: 1, b: undefined }, { a: 1 })).toBe(true)
    expect(sameSettingsValue({ a: null }, { a: undefined })).toBe(false)
    expect(sameSettingsValue(null, undefined)).toBe(false)
  })

  it("compares dates by time", () => {
    expect(sameSettingsValue(new Date(5), new Date(5))).toBe(true)
    expect(sameSettingsValue(new Date(5), 5)).toBe(false)
  })
})

describe("mergeConcurrentSettingsRow", () => {
  const merge = (
    base: Record<string, unknown> | undefined,
    ours: Record<string, unknown>,
    theirs: Record<string, unknown> | undefined,
    explicit: string[] = []
  ) =>
    mergeConcurrentSettingsRow({
      base,
      ours,
      theirs,
      explicit: new Set(explicit),
      oursOnly: new Set(["id"]),
    })

  it("keeps the concurrent writer's change of a key this save did not touch", () => {
    expect(
      merge(
        { id: "s", theme: "light", mic: "a" },
        { id: "s", theme: "light", mic: "b" },
        { id: "s", theme: "dark", mic: "a" },
        ["mic"]
      )
    ).toEqual({ id: "s", theme: "dark", mic: "b" })
  })

  it("takes this save's change where the other writer left the key alone", () => {
    expect(merge({ theme: "light" }, { theme: "dark" }, { theme: "light" })).toEqual({
      theme: "dark",
    })
  })

  it("on a conflict, an explicit edit wins and a filled-in value yields", () => {
    const base = { theme: "light", profile: undefined }
    const ours = { theme: "system", profile: { displayName: "" } }
    const theirs = { theme: "dark", profile: { displayName: "Remote" } }
    expect(merge(base, ours, theirs, ["theme"])).toEqual({
      theme: "system",
      profile: { displayName: "Remote" },
    })
  })

  it("follows the other writer's removal of a key, unless this save set it", () => {
    expect(merge({ colorTheme: "ocean" }, { colorTheme: "ocean" }, {})).toEqual({})
    expect(merge({ colorTheme: "ocean" }, { colorTheme: "forest" }, {}, ["colorTheme"])).toEqual({
      colorTheme: "forest",
    })
  })

  it("adds what the other writer added", () => {
    expect(merge({}, { theme: "dark" }, { fontScale: "lg" }, ["theme"])).toEqual({
      theme: "dark",
      fontScale: "lg",
    })
  })

  it("always takes this save's own-only keys", () => {
    expect(merge({ id: "a" }, { id: "b" }, { id: "c" })).toEqual({ id: "b" })
  })

  it("writes this save's row when the stored one is gone", () => {
    expect(merge({ theme: "light" }, { theme: "dark", mic: "a" }, undefined)).toEqual({
      theme: "dark",
      mic: "a",
    })
  })
})
