import type { AgentIntegrationManifest } from "@cognia/agent-contracts/ecosystem"
import type { EngineLaunchDescriptor } from "@cognia/agent-contracts/engine-launch"

import { buildEngineLaunchTable } from "./launch-table"

const manifest = (launch: EngineLaunchDescriptor[]): AgentIntegrationManifest =>
  ({ ecosystem: { id: "x" }, protocols: [], launch }) as unknown as AgentIntegrationManifest

const codex: EngineLaunchDescriptor = {
  id: "codex",
  match: { kind: "contains", values: ["codex"] },
  stateRoots: [".codex"],
  isolation: { env: { CODEX_HOME: "codex" }, denyReadable: [".codex"] },
}

describe("buildEngineLaunchTable", () => {
  it("orders manifests first and resolves shared roots to the state roots", () => {
    const table = buildEngineLaunchTable(
      [manifest([codex])],
      [{ id: "npx", match: { kind: "base", values: ["npx"] }, stateRoots: [".npm"] }]
    )
    expect(table.engines.map((descriptor) => descriptor.id)).toEqual(["codex", "npx"])
    expect(table.engines[0].isolation).toEqual({
      env: { CODEX_HOME: "codex" },
      sharedRoots: [".codex"],
      denyReadable: [".codex"],
    })
  })

  it("keeps explicit shared roots", () => {
    const copilot: EngineLaunchDescriptor = {
      id: "copilot",
      match: { kind: "contains", values: ["copilot"] },
      stateRoots: [".copilot", ".cache/copilot"],
      isolation: {
        env: { COPILOT_HOME: "copilot" },
        sharedRoots: [".copilot"],
        denyReadable: [".copilot"],
      },
    }
    expect(buildEngineLaunchTable([], [copilot]).engines[0].isolation?.sharedRoots).toEqual([
      ".copilot",
    ])
  })

  it("refuses duplicate ids", () => {
    expect(() => buildEngineLaunchTable([manifest([codex])], [codex])).toThrow(/declared twice/)
  })

  it.each([
    ["an absolute root", { stateRoots: ["/etc"] }, /must be a relative path/],
    ["a parent segment", { stateRoots: [".codex/../.ssh"] }, /must not contain/],
    ["a home shorthand", { stateRoots: ["~/.codex"] }, /must be a relative path/],
    ["a file root outside the state roots", { fileRoots: [".codex.json"] }, /is not a state root/],
    ["an empty match", { match: { kind: "base", values: [] } }, /match has no values/],
  ] as const)("refuses %s", (_label, patch, message) => {
    expect(() =>
      buildEngineLaunchTable([], [{ ...codex, ...(patch as Partial<EngineLaunchDescriptor>) }])
    ).toThrow(message)
  })

  it("refuses an isolation that escapes or maps nothing into the private root", () => {
    const escaping = { ...codex, isolation: { env: { CODEX_HOME: "../codex" }, denyReadable: [] } }
    expect(() => buildEngineLaunchTable([], [escaping])).toThrow(/must not contain/)
    const empty = { ...codex, isolation: { env: {}, denyReadable: [] } }
    expect(() => buildEngineLaunchTable([], [empty])).toThrow(/maps no env key/)
    const badKey = { ...codex, isolation: { env: { "codex-home": "codex" }, denyReadable: [] } }
    expect(() => buildEngineLaunchTable([], [badKey])).toThrow(/is not an env name/)
    const foreignShared = {
      ...codex,
      isolation: { env: { CODEX_HOME: "codex" }, sharedRoots: [".ssh"], denyReadable: [] },
    }
    expect(() => buildEngineLaunchTable([], [foreignShared])).toThrow(
      /shared root ".ssh" is not a state root/
    )
  })

  it("refuses relocations, temps and companions a host could not apply safely", () => {
    const refuse = (patch: Partial<EngineLaunchDescriptor>, message: RegExp) =>
      expect(() => buildEngineLaunchTable([], [{ ...codex, ...patch }])).toThrow(message)
    refuse({ relocation: { env: [] } }, /names no env key or flag/)
    refuse({ relocation: { env: ["LD_PRELOAD"] } }, /not an env name a descriptor may set/)
    refuse({ relocation: { env: ["CODEX_HOME"], setEnv: { NODE_OPTIONS: "x" } } }, /NODE_OPTIONS/)
    refuse(
      { relocation: { env: ["CODEX_HOME"], args: { flags: ["-c"], pick: "last" } } },
      /long option/
    )
    refuse({ relocation: { env: ["CODEX_HOME"], temp: "../tmp" } }, /must not contain/)
    refuse(
      { temp: { home: ".t", isolated: { env: "OTHER_HOME", path: "tmp" } } },
      /not an isolation env key/
    )
    refuse({ companion: { sibling: "../helper", env: "HELPER" } }, /not a file name/)
    refuse({ platformArgs: { linux: ["uid="] } }, /not a long option/)
  })

  it("refuses engine env, files and MCP config files a host could not apply safely", () => {
    const refuse = (patch: Partial<EngineLaunchDescriptor>, message: RegExp) =>
      expect(() => buildEngineLaunchTable([], [{ ...codex, ...patch }])).toThrow(message)
    refuse({ env: { prefixes: ["CODEX"] } }, /not an env family/)
    refuse({ env: { prefixes: ["DYLD_"] } }, /not an env family/)
    refuse({ env: { keys: ["NODE_OPTIONS"] } }, /not an env name/)
    refuse({ env: { secret: ["LD_PRELOAD"] } }, /not an env name/)
    refuse({ env: { reviewedRequestOnly: true } }, /needs reviewedPrefixes/)
    refuse({ hiddenFiles: { searched: ["a/b"] } }, /not a file name/)
    refuse({ stderrNoise: [["ok", ""]] }, /nonempty substrings/)
    const mcpConfigFile = {
      subcommand: "acp",
      rootEnv: "XDG_CONFIG_HOME",
      rootDefault: ".config",
      directory: "engine",
      serversFile: "mcp.json",
      settingsFile: "config.json",
      project: { directory: ".engine", files: ["mcp.json"] },
      privateKeep: ["version"],
      privateSet: { "shell.ready": true },
    }
    expect(() => buildEngineLaunchTable([], [{ ...codex, mcpConfigFile }])).not.toThrow()
    refuse({ mcpConfigFile: { ...mcpConfigFile, directory: "../engine" } }, /not a file name/)
    refuse({ mcpConfigFile: { ...mcpConfigFile, settingsFile: "mcp.json" } }, /over its settings/)
    refuse({ mcpConfigFile: { ...mcpConfigFile, rootEnv: "LD_PRELOAD" } }, /not an env name/)
    refuse({ mcpConfigFile: { ...mcpConfigFile, rootDefault: "/etc" } }, /relative path/)
    refuse({ mcpConfigFile: { ...mcpConfigFile, privateKeep: ["a..b"] } }, /empty segment/)
  })
})
