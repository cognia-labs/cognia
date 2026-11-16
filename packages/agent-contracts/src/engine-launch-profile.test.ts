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
    const personal = { kind: "personal" as const, key: "task-1", loopbackPorts: [9900, 4100] }
    expect(readEngineLaunchProfile(engineLaunchProfileEnv(personal))).toEqual(personal)
    expect(isIsolatedLaunch(engineLaunchProfileEnv(personal))).toBe(true)
  })

  it.each([
    "not json",
    "null",
    JSON.stringify({ kind: "isolated", key: "../x", reason: "bot" }),
    JSON.stringify({ kind: "isolated", key: "x".repeat(129), reason: "bot" }),
    JSON.stringify({ kind: "isolated", key: "k", reason: "someone" }),
    JSON.stringify({ kind: "isolated", reason: "bot" }),
    JSON.stringify({ kind: "personal", key: "k" }),
    JSON.stringify({ kind: "personal", key: "k", loopbackPorts: [] }),
    JSON.stringify({ kind: "personal", key: "k", loopbackPorts: [0] }),
    JSON.stringify({ kind: "personal", key: "k", loopbackPorts: [65536] }),
    JSON.stringify({ kind: "personal", key: "k", loopbackPorts: ["9900"] }),
    JSON.stringify({ kind: "personal", key: "k", loopbackPorts: 9900 }),
    JSON.stringify({ kind: "personal", key: "../k", loopbackPorts: [9900] }),
    JSON.stringify({ kind: "visitor", key: "k" }),
  ])("refuses %s", (raw) => {
    expect(() => readEngineLaunchProfile({ [ENGINE_PROFILE_ENV]: raw })).toThrow(
      EngineLaunchProfileError
    )
  })
})
