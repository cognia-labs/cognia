/** @jest-environment node */
import {
  ENGINE_PROFILE_ENV,
  EngineLaunchProfileError,
  engineLaunchProfileEnv,
  isIsolatedLaunch,
  readEngineLaunchProfile,
} from "./engine-launch-profile"

const isolated = { kind: "isolated", key: "bot-1", reason: "bot" } as const

describe("engine launch profile", () => {
  it("reads an absent profile as the owner's and round-trips an isolated one", () => {
    expect(readEngineLaunchProfile(undefined)).toEqual({ kind: "owner" })
    expect(readEngineLaunchProfile({})).toEqual({ kind: "owner" })
    expect(engineLaunchProfileEnv({ kind: "owner" })).toEqual({})
    expect(readEngineLaunchProfile(engineLaunchProfileEnv(isolated))).toEqual(isolated)
    expect(isIsolatedLaunch(engineLaunchProfileEnv(isolated))).toBe(true)
    expect(isIsolatedLaunch({})).toBe(false)
  })

  it.each([
    "not json",
    "null",
    JSON.stringify({ kind: "isolated", key: "../x", reason: "bot" }),
    JSON.stringify({ kind: "isolated", key: "x".repeat(129), reason: "bot" }),
    JSON.stringify({ kind: "isolated", key: "k", reason: "someone" }),
    JSON.stringify({ kind: "isolated", reason: "bot" }),
    JSON.stringify({ kind: "personal", key: "k" }),
  ])("refuses %s", (raw) => {
    expect(() => readEngineLaunchProfile({ [ENGINE_PROFILE_ENV]: raw })).toThrow(
      EngineLaunchProfileError
    )
  })
})
