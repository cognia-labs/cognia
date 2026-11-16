/** @jest-environment node */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  acceptsExtraWritableRoots,
  admitsRequestEnv,
  checkPrivateLaunch,
  companionFor,
  engineTemp,
  hiddenFiles,
  loginRoots,
  privateBlankCredentials,
  programRoots,
  relocatedState,
  reviewedEnvRefused,
  takesPiPackages,
  withPlatformArgs,
  type RelocationInput,
} from "./launch-descriptor"

const relocate = (
  command: string,
  args: string[],
  env: Record<string, string>,
  overrides: Partial<RelocationInput> = {},
  host: Record<string, string> = {}
) =>
  relocatedState(
    { command, args, env, cwd: "/work", home: "/home/dev", hostEnvApplies: true, ...overrides },
    host
  )

describe("relocatedState", () => {
  it("defaults under home and sets every key and switch", () => {
    expect(relocate("grok", [], {})).toEqual({
      engine: "grok",
      root: "/home/dev/.grok",
      writable: ["/home/dev/.grok"],
      temp: "/home/dev/.grok/tmp",
      env: {
        GROK_HOME: "/home/dev/.grok",
        GROK_DISABLE_AUTOUPDATER: "1",
        GROK_CHANGELOG_OFFLINE: "1",
      },
    })
    expect(relocate("mcode", [], { MINIMAX_DATA_DIR: "", MAVIS_DATA_DIR: "state" })?.env).toEqual({
      MINIMAX_DATA_DIR: "/work/state",
      MAVIS_DATA_DIR: "/work/state",
    })
  })

  it("lets flags beat env in the engine's own order", () => {
    expect(
      relocate("qoder", ["--config-dir", "a", "--config-dir=b"], { QODER_CONFIG_DIR: "/env" })?.root
    ).toBe("/work/b")
    expect(relocate("cline", ["--config", " a ", "--config=b"], {})?.root).toBe("/work/a")
    expect(() => relocate("cline", ["--data-dir", "x"], {})).toThrow("--data-dir")
    expect(() => relocate("qoder", ["--config-dir="], {})).toThrow(/nonempty/)
  })

  it("applies the host's selection only outside a gateway task", () => {
    const host = { KIMI_CODE_HOME: "/host/kimi" }
    expect(relocate("kimi", [], {}, {}, host)?.root).toBe("/host/kimi")
    expect(relocate("kimi", [], {}, { hostEnvApplies: false }, host)?.root).toBe(
      "/home/dev/.kimi-code"
    )
    expect(relocate("kimi", [], { KIMI_CODE_HOME: "/request" }, {}, host)?.root).toBe("/request")
  })

  it("applies a relocation without a default only when selected", () => {
    expect(relocate("openclaude", [], {})).toBeUndefined()
    expect(relocate("hermes", [], { HERMES_HOME: "/owned/hermes" })?.env).toEqual({
      HERMES_HOME: "/owned/hermes",
    })
    expect(() => relocate("vibe-acp", [], { VIBE_HOME: " " })).toThrow(/nonempty/)
  })

  it("expands tilde and grants only the declared sub-paths", () => {
    expect(relocate("agy_acp_server", [], { GEMINI_HOME: "~/g" })).toMatchObject({
      root: "/home/dev/g",
      writable: ["/home/dev/g/antigravity-acp", "/home/dev/g/artifacts"],
      temp: "/home/dev/g/antigravity-acp/tmp",
    })
    expect(relocate("agy_acp_server", [], { GEMINI_HOME: "" })?.root).toBe("/home/dev/.gemini")
  })

  it("keeps a private launch's relocation inside its own state, physically too", () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relocate-")))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "relocate-outside-"))
    try {
      expect(relocate("kimi", [], {}, { privateBase: base })?.root).toBe(
        path.join(base, ".kimi-code")
      )
      expect(() =>
        relocate("kimi", [], { KIMI_CODE_HOME: path.join(base, "../x") }, { privateBase: base })
      ).toThrow(/own state/)
      fs.symlinkSync(outside, path.join(base, "link"))
      expect(() =>
        relocate("kimi", [], { KIMI_CODE_HOME: path.join(base, "link/new") }, { privateBase: base })
      ).toThrow(/own state/)
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it("leaves engines without a relocation alone", () => {
    expect(relocate("codex", [], {})).toBeUndefined()
  })
})

it("moves an engine's temp under its private root", () => {
  const env = { GOOSE_PATH_ROOT: "/state/goose" }
  expect(engineTemp("goose", [], env, "/home/dev", false)).toBe("/home/dev/.local/state/goose/tmp")
  expect(engineTemp("goose", [], env, "/home/dev", true)).toBe("/state/goose/state/tmp")
  expect(engineTemp("codex", [], env, "/home/dev", false)).toBeUndefined()
})

it("appends platform arguments once and only on their platform", () => {
  expect(withPlatformArgs("agy_acp_server.par", [], "linux")).toEqual(["--uid="])
  expect(withPlatformArgs("agy_acp_server.par", ["--uid="], "linux")).toEqual(["--uid="])
  expect(withPlatformArgs("agy_acp_server.par", ["--uid", "1"], "linux")).toEqual(["--uid", "1"])
  expect(withPlatformArgs("agy_acp_server.par", [], "darwin")).toEqual([])
})

it("refuses a private launch of an engine that cannot run one", () => {
  expect(() => checkPrivateLaunch("agy_acp_server", [], true)).toThrow(/keychain/)
  expect(() => checkPrivateLaunch("agy_acp_server", [], false)).not.toThrow()
  expect(() => checkPrivateLaunch("codex", [], true)).not.toThrow()
})

describe("companionFor", () => {
  it("binds the helper to the engine's canonical release directory", () => {
    const release = fs.mkdtempSync(path.join(os.tmpdir(), "companion-"))
    try {
      const server = path.join(release, "agy_acp_server.par")
      fs.writeFileSync(server, "server", { mode: 0o755 })
      const resolve = () => server
      expect(() => companionFor("agy_acp_server.par", resolve)).toThrow(/localharness_external/)
      const helper = path.join(release, "localharness_external")
      fs.writeFileSync(helper, "helper", { mode: 0o755 })
      expect(companionFor("agy_acp_server.par", resolve)).toEqual({
        engine: "antigravity-acp",
        env: "ANTIGRAVITY_HARNESS_PATH",
        executablePath: fs.realpathSync(server),
        helperPath: path.join(fs.realpathSync(release), "localharness_external"),
      })
      expect(() => companionFor("agy_acp_server.par", () => null)).toThrow(/not installed/)
      expect(companionFor("codex", resolve)).toBeUndefined()
    } finally {
      fs.rmSync(release, { recursive: true, force: true })
    }
  })
})

describe("engine environment", () => {
  it("admits the keys and families some engine reads", () => {
    expect(admitsRequestEnv("GOOSE_MODEL")).toBe(true)
    expect(admitsRequestEnv("XAI_API_KEY")).toBe(true)
    expect(admitsRequestEnv("AWS_SECRET_ACCESS_KEY")).toBe(false)
  })

  it("keeps reviewed families to their reviewed keys", () => {
    expect(reviewedEnvRefused("kimi", [], "KIMI_OAUTH_HOST", false, false)).toBe(true)
    expect(reviewedEnvRefused("kimi", [], "KIMI_MODEL_NAME", false, true)).toBe(false)
    expect(reviewedEnvRefused("kimi", [], "KIMI_MODEL_NAME", true, false)).toBe(false)
    expect(reviewedEnvRefused("kimi", [], "KIMI_MODEL_NAME", true, true)).toBe(true)
    expect(reviewedEnvRefused("aider", [], "AIDER_MODEL", true, false)).toBe(true)
    expect(reviewedEnvRefused("aider", [], "AIDER_MODEL", false, false)).toBe(false)
    expect(reviewedEnvRefused("codex", [], "KIMI_OAUTH_HOST", false, false)).toBe(false)
  })

  it("names the credentials a private launch blanks", () => {
    expect(privateBlankCredentials("grok", [])).toEqual(["XAI_API_KEY"])
    expect(privateBlankCredentials("codex", [])).toEqual([])
  })
})

describe("engine files", () => {
  it("hides searched files in home and every ancestor of the working directory", () => {
    const files = hiddenFiles("aider", [], "/work/repo", "/home/dev")
    for (const file of [
      "/home/dev/.aider.conf.yml",
      "/work/repo/.env",
      "/work/.aider.conf.yml",
      "/.env",
      "/home/dev/.aider/oauth-keys.env",
    ])
      expect(files).toContain(file)
    expect(hiddenFiles("codex", [], "/work", "/home/dev")).toEqual([])
  })

  it("resolves program and login roots under home", () => {
    expect(programRoots("qoder", [], "/home/dev")).toEqual([
      "/home/dev/.qoder/entry",
      "/home/dev/.qoder/bin",
    ])
    const logins = loginRoots("/home/dev")
    expect(logins).toContain("/home/dev/.aider")
    expect(logins).toContain("/home/dev/.codex")
  })
})

it("reads engine feature flags", () => {
  expect(acceptsExtraWritableRoots("codex", [])).toBe(true)
  expect(acceptsExtraWritableRoots("goose", [])).toBe(false)
  expect(takesPiPackages("pi", [])).toBe(true)
  expect(takesPiPackages("codex", [])).toBe(false)
})
