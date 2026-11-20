import { encodeHlc } from "@cognia/sync-protocol"

import {
  isSettingObject,
  ownProperties,
  propertyValueToPush,
  settingPropertyChange,
  wholeValueToPush,
} from "./settings-properties"

const at = (ms: number) => encodeHlc({ ms, c: 0, deviceId: "dev_" + "A".repeat(26) })

describe("settingPropertyChange", () => {
  it("names only the properties that changed", () => {
    expect(
      settingPropertyChange(
        { displayName: "Ada", bio: "old", pronouns: "she/her" },
        { displayName: "Ada", bio: "new", timezone: "Asia/Shanghai" }
      )
    ).toEqual({ fields: ["value.bio", "value.pronouns", "value.timezone"], clears: false })
  })

  it("treats null and a missing property alike", () => {
    expect(settingPropertyChange({ bio: null }, {})).toBeNull()
    expect(settingPropertyChange({ bio: "x" }, { bio: null, displayName: "Ada" })).toEqual({
      fields: ["value.bio", "value.displayName"],
      clears: false,
    })
  })

  it("compares a property's value structurally", () => {
    expect(settingPropertyChange({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } })).toBeNull()
  })

  it("is one whole write when nothing is left", () => {
    expect(settingPropertyChange({ bio: "x" }, undefined)).toEqual({
      fields: ["value"],
      clears: true,
    })
    expect(settingPropertyChange({ bio: "x" }, {})).toEqual({ fields: ["value"], clears: true })
    expect(settingPropertyChange(undefined, {})).toBeNull()
  })

  it("names every property of a value set from nothing", () => {
    expect(settingPropertyChange(undefined, { bio: "x", displayName: "Ada" })).toEqual({
      fields: ["value.bio", "value.displayName"],
      clears: false,
    })
  })
})

describe("values pushed for a key merged by property", () => {
  it("pushes the whole-write field as the properties without a clock of their own", () => {
    // A whole write from another device landed between this device's clear and
    // its push: sending null at that clock would remove what it set elsewhere.
    const value = { displayName: "Grace", bio: "mine" }
    expect(wholeValueToPush(value, { value: at(5), "value.bio": at(9) })).toEqual({
      displayName: "Grace",
    })
    expect(wholeValueToPush({ bio: "mine" }, { value: at(5), "value.bio": at(9) })).toBeNull()
    expect(wholeValueToPush(undefined, { value: at(5) })).toBeNull()
  })

  it("pushes a removed property as null", () => {
    expect(propertyValueToPush({ bio: "x" }, "value.bio")).toBe("x")
    expect(propertyValueToPush({ bio: "x" }, "value.displayName")).toBeNull()
    expect(propertyValueToPush(undefined, "value.bio")).toBeNull()
    expect(propertyValueToPush({ bio: "x" }, "value")).toBeNull()
  })
})

describe("ownProperties", () => {
  it("lists the properties that differ from the default's", () => {
    // The default profile is empty: every property set is this device's own.
    expect(ownProperties("profile", { displayName: "Ada", bio: null })).toEqual(["displayName"])
    expect(ownProperties("profile", {})).toEqual([])
    expect(ownProperties("profile", undefined)).toEqual([])
  })
})

describe("isSettingObject", () => {
  it("accepts plain objects only", () => {
    expect(isSettingObject({})).toBe(true)
    expect(isSettingObject([])).toBe(false)
    expect(isSettingObject(null)).toBe(false)
    expect(isSettingObject("x")).toBe(false)
  })
})
