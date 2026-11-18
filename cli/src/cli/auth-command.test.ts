/**
 * @jest-environment node
 */
import { authCommand as runAuth, type AuthDeps } from "./auth-command"
import { parseArgv } from "./args"
import type { OutputSink } from "./output"

function sink() {
  const stdout: string[] = []
  const stderr: string[] = []
  const out: OutputSink = {
    write: (t) => stdout.push(t),
    error: (t) => stderr.push(t),
    json: () => undefined,
  }
  return { out, stdout: () => stdout.join(""), stderr: () => stderr.join("") }
}

/** Hermetic by default: no real env, files or cwd. */
function authCommand(args: Parameters<typeof runAuth>[0], deps: AuthDeps) {
  return runAuth(args, { env: {}, describeCredentials: () => ({}), ...deps })
}

describe("authCommand", () => {
  it("login stores a credential for the given provider", async () => {
    const s = sink()
    const setCredential = jest.fn().mockReturnValue("/home/.cognia/credentials.json")
    const code = await authCommand(
      parseArgv(["auth", "login", "--provider", "openai", "--api-key", "sk"]),
      {
        out: s.out,
        home: "/home/.cognia",
        setCredential,
      }
    )
    expect(code).toBe(0)
    expect(setCredential).toHaveBeenCalledWith("/home/.cognia", "openai", "sk", undefined, {
      kind: "apiKey",
    })
    expect(s.stdout()).toMatch(/Saved api key for "openai"/)
  })

  it("login stores a subscription token with --subscription", async () => {
    const s = sink()
    const setCredential = jest.fn().mockReturnValue("/p")
    const code = await authCommand(parseArgv(["auth", "login", "--subscription", "oauth-tok"]), {
      out: s.out,
      home: "/h",
      setCredential,
    })
    expect(code).toBe(0)
    expect(setCredential).toHaveBeenCalledWith("/h", "anthropic", "oauth-tok", undefined, {
      kind: "authToken",
    })
    expect(s.stdout()).toMatch(/Saved subscription token for "anthropic"/)
  })

  it("login falls back to CLAUDE_CODE_OAUTH_TOKEN env as a subscription token", async () => {
    const s = sink()
    const setCredential = jest.fn().mockReturnValue("/p")
    await authCommand(parseArgv(["auth", "login"]), {
      out: s.out,
      home: "/h",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-env" },
      setCredential,
    })
    expect(setCredential).toHaveBeenCalledWith("/h", "anthropic", "oauth-env", undefined, {
      kind: "authToken",
    })
  })

  it("login defaults to the anthropic provider", async () => {
    const s = sink()
    const setCredential = jest.fn().mockReturnValue("/p")
    await authCommand(parseArgv(["auth", "login", "--api-key", "sk"]), {
      out: s.out,
      home: "/h",
      setCredential,
    })
    expect(setCredential).toHaveBeenCalledWith("/h", "anthropic", "sk", undefined, {
      kind: "apiKey",
    })
  })

  it("login falls back to COGNIA_LOGIN_API_KEY env", async () => {
    const s = sink()
    const setCredential = jest.fn().mockReturnValue("/p")
    await authCommand(parseArgv(["auth", "login"]), {
      out: s.out,
      home: "/h",
      env: { COGNIA_LOGIN_API_KEY: "envkey" },
      setCredential,
    })
    expect(setCredential).toHaveBeenCalledWith("/h", "anthropic", "envkey", undefined, {
      kind: "apiKey",
    })
  })

  it("login without a key errors with exit 2", async () => {
    const s = sink()
    const code = await authCommand(parseArgv(["auth", "login"]), {
      out: s.out,
      home: "/h",
      env: {},
      setCredential: jest.fn(),
    })
    expect(code).toBe(2)
    expect(s.stderr()).toMatch(/--api-key/)
  })

  it("status lists stored providers", async () => {
    const s = sink()
    const code = await authCommand(parseArgv(["auth", "status"]), {
      out: s.out,
      home: "/h",
      listCredentialProviders: () => ["anthropic", "openai"],
    })
    expect(code).toBe(0)
    expect(s.stdout()).toMatch(/anthropic, openai/)
  })

  it("status reports when empty", async () => {
    const s = sink()
    await authCommand(parseArgv(["auth", "status"]), {
      out: s.out,
      home: "/h",
      listCredentialProviders: () => [],
    })
    expect(s.stdout()).toMatch(/No credentials/)
  })

  it("logout removes the provider credential", async () => {
    const s = sink()
    const deleteCredential = jest.fn()
    const code = await authCommand(parseArgv(["auth", "logout", "--provider", "openai"]), {
      out: s.out,
      home: "/h",
      deleteCredential,
    })
    expect(code).toBe(0)
    expect(deleteCredential).toHaveBeenCalledWith("/h", "openai")
  })

  it("errors with exit 2 on an unknown subcommand", async () => {
    const s = sink()
    const code = await authCommand(parseArgv(["auth"]), { out: s.out, home: "/h" })
    expect(code).toBe(2)
    expect(s.stderr()).toMatch(/login \| status \| logout/)
  })

  it("an explicit --api-key is saved even with a Claude token in the environment", async () => {
    const setCredential = jest.fn().mockReturnValue("/p")
    const code = await authCommand(
      parseArgv(["auth", "login", "--provider", "openai", "--api-key", "sk-openai"]),
      { out: sink().out, home: "/h", env: { CLAUDE_CODE_OAUTH_TOKEN: "claude-tok" }, setCredential }
    )
    expect(code).toBe(0)
    expect(setCredential).toHaveBeenCalledWith("/h", "openai", "sk-openai", undefined, {
      kind: "apiKey",
    })
  })

  it("never saves the Claude token from the environment for another provider", async () => {
    const s = sink()
    const setCredential = jest.fn()
    const code = await authCommand(parseArgv(["auth", "login", "--provider", "openai"]), {
      out: s.out,
      home: "/h",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "claude-tok" },
      setCredential,
    })
    expect(code).toBe(2)
    expect(setCredential).not.toHaveBeenCalled()
  })

  it("refuses both secret kinds at once, and an ambiguous environment", async () => {
    const both = sink()
    expect(
      await authCommand(parseArgv(["auth", "login", "--api-key", "k", "--subscription", "t"]), {
        out: both.out,
        home: "/h",
        setCredential: jest.fn(),
      })
    ).toBe(2)
    const ambient = sink()
    expect(
      await authCommand(parseArgv(["auth", "login"]), {
        out: ambient.out,
        home: "/h",
        env: { COGNIA_LOGIN_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t" },
        setCredential: jest.fn(),
      })
    ).toBe(2)
    expect(ambient.stderr()).toMatch(/say which to save/)
  })

  it("refuses a secret flag given without a value", async () => {
    const s = sink()
    const setCredential = jest.fn()
    expect(
      await authCommand(parseArgv(["auth", "login", "--provider", "openai", "--api-key"]), {
        out: s.out,
        home: "/h",
        env: { COGNIA_LOGIN_API_KEY: "ambient" },
        setCredential,
      })
    ).toBe(2)
    expect(setCredential).not.toHaveBeenCalled()
    expect(s.stderr()).toMatch(/--api-key needs a value/)
  })

  it("status names the source each provider's run uses", async () => {
    const s = sink()
    await authCommand(parseArgv(["auth", "status"]), {
      out: s.out,
      home: "/h",
      listCredentialProviders: () => ["openai"],
      describeCredentials: () => ({
        openai: [
          { layer: "credentials", kind: "apiKey", origin: "/h/credentials.json" },
          { layer: "env", kind: "apiKey", origin: "OPENAI_API_KEY" },
        ],
        anthropic: [
          { layer: "project-config", kind: "apiKey", origin: "/repo/.cognia/config.json" },
        ],
      }),
    })
    expect(s.stdout()).toContain("openai: api key from env OPENAI_API_KEY")
    expect(s.stdout()).toContain("anthropic: api key in project config /repo/.cognia/config.json")
  })

  it("logout says which sources still supply a key", async () => {
    const s = sink()
    await authCommand(parseArgv(["auth", "logout", "--provider", "openai"]), {
      out: s.out,
      home: "/h",
      deleteCredential: jest.fn(),
      describeCredentials: () => ({
        openai: [{ layer: "env", kind: "apiKey", origin: "OPENAI_API_KEY" }],
      }),
    })
    expect(s.stdout()).toContain("still provided by: api key from env OPENAI_API_KEY")
  })
})
