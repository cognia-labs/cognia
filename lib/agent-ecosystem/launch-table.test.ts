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
})
