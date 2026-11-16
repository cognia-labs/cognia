import {
  ENGINE_LAUNCH_DESCRIPTORS,
  agentStateFileRoots,
  agentStateIsolationFor,
  agentStateWritableRoots,
} from "./engine-launch"

describe("agentStateWritableRoots", () => {
  it("keeps new ACP state in the correct vendor roots instead of their ancestors' accounts", () => {
    expect(agentStateWritableRoots("omp")).toEqual([".omp"])
    expect(agentStateWritableRoots("mimo")).toEqual([
      ".config/mimocode",
      ".local/share/mimocode",
      ".local/state/mimocode",
      ".cache/mimocode",
    ])
    expect(agentStateWritableRoots("kilo")).toEqual([
      ".config/kilo",
      ".local/share/kilo",
      ".local/state/kilo",
      ".cache/kilo",
    ])
    expect(agentStateWritableRoots("muse-acp")).toEqual([".config/muse", ".local/state/muse-acp"])
    expect(agentStateWritableRoots("zcode-acp")).toEqual([".zcode", ".zcode-acp"])
    expect(agentStateWritableRoots("not-omp")).toEqual([])
    expect(agentStateWritableRoots("not-mimo")).toEqual([])
  })

  it("grants Cline and Qoder only their documented config roots", () => {
    expect(agentStateWritableRoots("cline", ["--acp"])).toEqual([".cline"])
    expect(agentStateWritableRoots("qoder", ["--acp"])).toEqual([".qoder"])
    expect(agentStateWritableRoots("npx", ["-y", "qoder-adapter"])).toEqual([".npm"])
  })

  it("gives Goose its roots only for the actual binary, wherever it is installed", () => {
    const goose = [
      ".config/goose",
      ".local/share/goose",
      ".local/state/goose",
      "Library/Application Support/Block/goose",
    ]
    for (const command of ["goose", "/opt/bin/goose", "C:\\Tools\\goose.exe"])
      expect(agentStateWritableRoots(command, ["acp"])).toEqual(goose)
    expect(agentStateWritableRoots("npx", ["-y", "goose-adapter"])).toEqual([".npm"])
  })

  it("gives only the Devin binary its config, sessions, and cache roots", () => {
    expect(agentStateWritableRoots("devin", ["acp"])).toEqual([
      ".config/devin",
      ".local/share/devin",
      ".cache/devin",
    ])
    expect(agentStateWritableRoots("npx", ["-y", "devin-adapter"])).toEqual([".npm"])
  })

  it("resolves an npx launch to the package's state as well as npx's", () => {
    expect(agentStateWritableRoots("npx", ["-y", "@zed-industries/codex-acp"])).toEqual([
      ".codex",
      ".npm",
    ])
  })

  it("gives OpenCode its state roots", () => {
    expect(agentStateWritableRoots("opencode")).toEqual([
      ".config/opencode",
      ".local/share/opencode",
    ])
  })

  it("does not hand copilot Pi's state directory", () => {
    // "copilot" contains "pi", which is why Pi matches the base command.
    expect(agentStateWritableRoots("copilot")).not.toContain(".pi")
    expect(agentStateWritableRoots("pi")).toContain(".pi")
    expect(agentStateWritableRoots("npx", ["-y", "pi-acp"])).not.toContain(".pi")
  })

  it("matches the executable file name, not its directory", () => {
    expect(agentStateWritableRoots("codex.cmd")).toContain(".codex")
    expect(agentStateWritableRoots("/usr/local/bin/claude")).toContain(".claude")
    expect(agentStateWritableRoots("/home/me/codex-tools/bin/agent")).toEqual([])
  })

  it("keeps the installed ACP binaries' state roots", () => {
    for (const command of ["codex-acp", "gemini", "qwen"])
      expect(agentStateWritableRoots(command)).not.toEqual([])
  })

  it("confines MiniMax and Grok to their exact executables", () => {
    expect(agentStateWritableRoots("mcode", ["acp"])).toEqual([".minimax"])
    expect(agentStateWritableRoots("not-mcode")).toEqual([])
    expect(agentStateWritableRoots("grok")).toEqual([".grok"])
    expect(agentStateWritableRoots("not-grok")).toEqual([])
  })
})

describe("agentStateFileRoots", () => {
  it("marks the Claude and OpenClaude json files as files", () => {
    expect(agentStateFileRoots("claude-agent-acp")).toEqual([".claude.json", ".claude.json.backup"])
    expect(agentStateFileRoots("openclaude")).toEqual([".openclaude.json"])
    expect(agentStateFileRoots("opencode")).toEqual([])
  })
})

describe("agentStateIsolationFor", () => {
  it("recognizes resolved Goose executables without matching unrelated binaries", () => {
    for (const command of ["goose", "/opt/bin/goose", "C:\\Tools\\goose.exe"]) {
      expect(agentStateIsolationFor(command)?.env).toEqual({ GOOSE_PATH_ROOT: "goose" })
      expect(agentStateIsolationFor(command)?.setEnv).toEqual({ GOOSE_DISABLE_KEYRING: "1" })
    }
    expect(agentStateIsolationFor("/opt/not-goose")).toBeNull()
  })

  it("isolates both MiniMax directory aliases", () => {
    expect(agentStateIsolationFor("mcode", ["acp"])).toEqual({
      env: { MINIMAX_DATA_DIR: "minimax", MAVIS_DATA_DIR: "minimax" },
      setEnv: {},
      sharedRoots: [".minimax"],
      denyReadable: [".minimax"],
    })
  })

  it("scopes Grok by its documented home", () => {
    expect(agentStateIsolationFor("grok")).toEqual({
      env: { GROK_HOME: "grok" },
      setEnv: {},
      sharedRoots: [".grok"],
      denyReadable: [".grok"],
    })
  })

  it("replaces only Copilot's login root, leaving its cache shared", () => {
    expect(agentStateIsolationFor("copilot")).toEqual({
      env: { COPILOT_HOME: "copilot" },
      setEnv: {},
      sharedRoots: [".copilot"],
      denyReadable: [".copilot"],
    })
  })

  it("keeps OpenClaude credentials separate from Claude Code", () => {
    expect(agentStateWritableRoots("openclaude", [])).toEqual([".openclaude", ".openclaude.json"])
    expect(agentStateIsolationFor("openclaude")?.env).toEqual({
      OPENCLAUDE_CONFIG_DIR: "openclaude",
    })
    for (const command of ["claude", "claude-agent-acp", "claude-code-acp"])
      expect(agentStateIsolationFor(command)?.env).toEqual({ CLAUDE_CONFIG_DIR: "claude" })
    expect(agentStateIsolationFor("not-claude-agent")).toBeNull()
    expect(agentStateWritableRoots("not-claude-agent", [])).not.toContain(".claude")
  })

  it.each([
    ["vibe-acp", "VIBE_HOME", "vibe"],
    ["mimo", "MIMOCODE_HOME", "mimocode"],
    ["hermes", "HERMES_HOME", "hermes"],
  ])("relocates %s only through its documented home variable", (command, key, leaf) => {
    expect(agentStateIsolationFor(command)?.env).toEqual({ [key]: leaf })
  })

  it("has no isolation for engines without a documented home", () => {
    for (const command of ["gemini", "devin", "kiro-cli", "droid", "cursor-agent", "aider"])
      expect(agentStateIsolationFor(command)).toBeNull()
  })
})

it("reads every descriptor with its shared roots resolved", () => {
  for (const descriptor of ENGINE_LAUNCH_DESCRIPTORS) {
    if (descriptor.isolation) expect(descriptor.isolation.sharedRoots).toBeDefined()
  }
})
