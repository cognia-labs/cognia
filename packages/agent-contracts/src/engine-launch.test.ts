import { descriptorsFor, launchBaseCommand, launchMatches, launchTarget } from "./engine-launch"
import type { EngineLaunchDescriptor } from "./engine-launch"

const table: EngineLaunchDescriptor[] = [
  { id: "pi", match: { kind: "base", values: ["pi"] } },
  { id: "copilot", match: { kind: "contains", values: ["copilot"] } },
  { id: "claude", match: { kind: "target", values: ["@anthropic-ai/claude-code"] } },
  { id: "npx", match: { kind: "base", values: ["npx"] } },
]

describe("launch matching", () => {
  it("uses the executable file name without a Windows suffix", () => {
    expect(launchBaseCommand(" /opt/bin/Goose.EXE ")).toBe("goose")
    expect(launchBaseCommand("C:\\Tools\\codex.cmd")).toBe("codex")
    expect(launchBaseCommand("agy_acp_server.par")).toBe("agy_acp_server.par")
  })

  it("targets the package an npx launch runs", () => {
    expect(launchTarget("npx", ["-y", "@anthropic-ai/claude-code"])).toEqual({
      base: "npx",
      target: "@anthropic-ai/claude-code",
    })
    expect(launchTarget("npx", ["-y"])).toEqual({ base: "npx", target: "npx" })
    expect(launchTarget("codex", ["exec"])).toEqual({ base: "codex", target: "codex" })
  })

  it("matches base, target and substring exactly as declared", () => {
    expect(
      launchMatches({ kind: "base", values: ["pi"] }, { base: "copilot", target: "copilot" })
    ).toBe(false)
    expect(
      launchMatches(
        { kind: "contains", values: ["copilot"] },
        { base: "npx", target: "@github/copilot" }
      )
    ).toBe(true)
  })

  it("returns every matching descriptor in table order", () => {
    expect(
      descriptorsFor(table, "npx", ["-y", "@anthropic-ai/claude-code"]).map((d) => d.id)
    ).toEqual(["claude", "npx"])
    expect(descriptorsFor(table, "copilot").map((d) => d.id)).toEqual(["copilot"])
    expect(descriptorsFor(table, "/usr/bin/pi").map((d) => d.id)).toEqual(["pi"])
  })
})
