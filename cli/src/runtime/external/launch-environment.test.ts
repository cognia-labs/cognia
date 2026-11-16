/** @jest-environment node */
import {
  ISOLATED_SET,
  admitsRequestKey,
  inheritedEnvironment,
  isDangerousEnvKey,
} from "./launch-environment"

const ambient = {
  PATH: "/usr/bin",
  HOME: "/Users/owner",
  CARGO_HOME: "/Users/owner/.cargo",
  SSH_AUTH_SOCK: "/tmp/agent.sock",
  OPENROUTER_API_KEY: "owner-provider",
  CODEX_HOME: "/Users/owner/.codex",
  HTTPS_PROXY: "http://proxy",
  AWS_SECRET_ACCESS_KEY: "unrelated",
  NODE_OPTIONS: "--require /tmp/x.js",
  DYLD_INSERT_LIBRARIES: "/tmp/x.dylib",
  COGNIA_AGENT_STATE_KEY: "host-only",
  COGNIA_TOOLHOST_TOKEN: "host-only",
  UNSET: undefined,
}

describe("inheritedEnvironment", () => {
  it("gives the owner's run its session, SSH agent, provider and engine env, nothing unrelated", () => {
    expect(inheritedEnvironment(ambient, "owner")).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/owner",
      CARGO_HOME: "/Users/owner/.cargo",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      OPENROUTER_API_KEY: "owner-provider",
      CODEX_HOME: "/Users/owner/.codex",
      HTTPS_PROXY: "http://proxy",
    })
  })

  it("gives an isolated launch no credential, helper socket or owner root", () => {
    expect(inheritedEnvironment(ambient, "isolated")).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/owner",
      HTTPS_PROXY: "http://proxy",
    })
    expect(ISOLATED_SET.GIT_CONFIG_GLOBAL).toBe("/dev/null")
  })

  it("gives a brokered launch the essentials only, and a self-built one nothing", () => {
    expect(inheritedEnvironment(ambient, "essential")).toEqual({ PATH: "/usr/bin" })
    expect(inheritedEnvironment(ambient, "none")).toEqual({})
  })
})

it("admits host configuration and engine keys from a request, never a loader", () => {
  expect(admitsRequestKey("DSH_HOME")).toBe(true)
  expect(admitsRequestKey("COGNIA_TOOLHOST_TOKEN")).toBe(true)
  expect(admitsRequestKey("GOOSE_MODEL")).toBe(true)
  expect(admitsRequestKey("AWS_SECRET_ACCESS_KEY")).toBe(false)
  expect(admitsRequestKey("LD_PRELOAD")).toBe(false)
  expect(isDangerousEnvKey("node_options")).toBe(true)
})
