import {
  TERMINAL_DOCK_ACTIONS,
  TERMINAL_DOCK_READ_RECENT_SCHEMA,
  TERMINAL_DOCK_SPAWN_SCHEMA,
  TERMINAL_DOCK_TOOL_PREFIX,
  TERMINAL_DOCK_WAIT_FOR_EXIT_SCHEMA,
  TERMINAL_DOCK_WRITE_SCHEMA,
  type TerminalDockAction,
} from "./dock-tool-schemas"

describe("terminal-dock-schemas", () => {
  it("exposes the prefix every dock tool name carries", () => {
    expect(TERMINAL_DOCK_TOOL_PREFIX).toBe("terminal_dock_")
  })

  it("enumerates exactly four actions in stable order", () => {
    expect(TERMINAL_DOCK_ACTIONS).toEqual(["spawn", "write", "read_recent", "wait_for_exit"])
  })

  it("write + read_recent + wait_for_exit require a tabId", () => {
    expect(TERMINAL_DOCK_WRITE_SCHEMA.required).toContain("tabId")
    expect(TERMINAL_DOCK_READ_RECENT_SCHEMA.required).toContain("tabId")
    expect(TERMINAL_DOCK_WAIT_FOR_EXIT_SCHEMA.required).toContain("tabId")
  })

  it("write requires command alongside tabId", () => {
    expect(TERMINAL_DOCK_WRITE_SCHEMA.required).toEqual(
      expect.arrayContaining(["tabId", "command"])
    )
  })

  it("spawn requires nothing — every field is optional", () => {
    expect(TERMINAL_DOCK_SPAWN_SCHEMA.required).toEqual([])
  })

  it("rejects unknown properties on every schema (additionalProperties=false)", () => {
    for (const schema of [
      TERMINAL_DOCK_SPAWN_SCHEMA,
      TERMINAL_DOCK_WRITE_SCHEMA,
      TERMINAL_DOCK_READ_RECENT_SCHEMA,
      TERMINAL_DOCK_WAIT_FOR_EXIT_SCHEMA,
    ]) {
      expect(schema.additionalProperties).toBe(false)
      expect(schema.type).toBe("object")
    }
  })

  it("timeoutSec range is consistent across schemas (5–600 seconds)", () => {
    for (const schema of [
      TERMINAL_DOCK_SPAWN_SCHEMA,
      TERMINAL_DOCK_WRITE_SCHEMA,
      TERMINAL_DOCK_WAIT_FOR_EXIT_SCHEMA,
    ]) {
      const t = (schema.properties as Record<string, { minimum?: number; maximum?: number }>)
        .timeoutSec
      expect(t.minimum).toBe(5)
      expect(t.maximum).toBe(600)
    }
  })

  it("typed action names line up with the runtime list", () => {
    const sample: TerminalDockAction = "spawn"
    expect(TERMINAL_DOCK_ACTIONS).toContain(sample)
  })
})
