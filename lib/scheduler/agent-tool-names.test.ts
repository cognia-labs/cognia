import { readFileSync } from "node:fs"
import { join } from "node:path"
import { SCHEDULER_AGENT_TOOL_NAMES } from "./agent-tool-names"

describe("SCHEDULER_AGENT_TOOL_NAMES", () => {
  it("names each scheduler tool the cognia MCP server registers, once", () => {
    const server = readFileSync(join(__dirname, "../external-bridge/mcp-server/server.ts"), "utf8")
    expect(new Set(SCHEDULER_AGENT_TOOL_NAMES).size).toBe(SCHEDULER_AGENT_TOOL_NAMES.length)
    for (const name of SCHEDULER_AGENT_TOOL_NAMES) {
      expect(name.startsWith("mcp__cognia__")).toBe(true)
      expect(server).toContain(`"${name.slice("mcp__cognia__".length)}",`)
    }
  })
})
