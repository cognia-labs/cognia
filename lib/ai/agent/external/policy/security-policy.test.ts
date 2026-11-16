import {
  EXTERNAL_AGENT_BINARY_ALLOWLIST,
  EXTERNAL_AGENT_NPX_ALLOWLIST,
  baseCommandName,
  externalAgentSandboxSupportsPlatform,
} from "./security-policy"

describe("sandbox platform gate", () => {
  it("allows exactly the platforms with a real sandbox", () => {
    expect(externalAgentSandboxSupportsPlatform("darwin")).toBe(true)
    expect(externalAgentSandboxSupportsPlatform("linux")).toBe(true)
    expect(externalAgentSandboxSupportsPlatform("win32")).toBe(false)
    expect(externalAgentSandboxSupportsPlatform("freebsd")).toBe(false)
  })

  it("accepts Tauri's platform spelling as well as Node's", () => {
    // The renderer asks `@tauri-apps/plugin-os`, which says "macos"/"windows";
    // the CLI asks `process.platform`, which says "darwin"/"win32". A helper
    // that only understood one of them would answer "unsupported" for macOS
    // desktop users.
    expect(externalAgentSandboxSupportsPlatform("macos")).toBe(true)
    expect(externalAgentSandboxSupportsPlatform("windows")).toBe(false)
  })
})

describe("allowlists", () => {
  it("admits inspected agent executables without admitting the Windows command shell", () => {
    for (const command of [
      "auggie",
      "autohand",
      "codebuddy",
      "commandcode",
      "kilo",
      "vibe-acp",
      "mimo",
      "hermes",
      "omp",
      "muse-acp",
      "amp-acp",
      "zcode-acp",
    ]) {
      expect(EXTERNAL_AGENT_BINARY_ALLOWLIST).toContain(command)
    }
    expect(EXTERNAL_AGENT_BINARY_ALLOWLIST).not.toContain("cmd")
    expect(EXTERNAL_AGENT_BINARY_ALLOWLIST).not.toContain("sh")
    expect(EXTERNAL_AGENT_BINARY_ALLOWLIST).not.toContain("bash")
  })
  it("admits the installed Devin ACP binary", () => {
    expect(EXTERNAL_AGENT_BINARY_ALLOWLIST).toContain("devin")
  })

  it("admits the binary the claude-code preset actually spawns", () => {
    // `ecosystem-adapters.ts` launches the bare `claude-agent-acp` binary for
    // the `claude-code` preset. Rust's allowlist only carried the npx package,
    // so a headless spawn of the shipped preset was rejected by policy.
    expect(EXTERNAL_AGENT_BINARY_ALLOWLIST).toContain("claude-agent-acp")
  })

  it("admits Cline now that its native ACP preset reaches the binary", () => {
    expect(EXTERNAL_AGENT_BINARY_ALLOWLIST).toContain("cline")
  })

  it("keeps the npx bridges the presets use", () => {
    for (const pkg of ["@zed-industries/codex-acp", "@google/gemini-cli", "@qwen-code/qwen-code"]) {
      expect(EXTERNAL_AGENT_NPX_ALLOWLIST).toContain(pkg)
    }
  })

  it("no longer admits the removed Pi ACP bridge", () => {
    // Pi launches its own binary now. Re-adding the package here would restore
    // an unpinned `npx` launch that the runtime catalog no longer waives.
    expect(EXTERNAL_AGENT_NPX_ALLOWLIST).not.toContain("pi-acp")
  })
})

it("strips a Windows executable suffix for admission", () => {
  expect(baseCommandName("Codex.EXE")).toBe("codex")
})

it("admits the binaries with their own launch descriptors", () => {
  for (const command of ["cline", "qoder", "goose", "codex-acp", "gemini", "qwen", "mcode", "grok"])
    expect(EXTERNAL_AGENT_BINARY_ALLOWLIST).toContain(command)
})
