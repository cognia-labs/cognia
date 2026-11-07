import { TERMINAL_DOCK_TOOL_NAMES } from "./agent-tools"
import terminal from "./module"

describe("the terminal manifest", () => {
  it("declares a stable module whose real-world smoke is still owed", () => {
    expect(terminal).toMatchObject({ id: "terminal", kind: "module", stage: "stable" })
    expect(terminal.acceptance).toEqual({ realSmoke: "pending" })
  })

  it("declares the dock tools without a tier: two writes and two reads, none cancellable", async () => {
    expect(terminal.tools!.declare).toEqual({
      terminal_dock_spawn: { consent: "default", effect: "write", cancellable: false },
      terminal_dock_write: { consent: "default", effect: "write", cancellable: false },
      terminal_dock_read_recent: { consent: "default", effect: "read", cancellable: false },
      terminal_dock_wait_for_exit: { consent: "default", effect: "read", cancellable: false },
    })
    expect(Object.keys(terminal.tools!.declare)).toEqual([...TERMINAL_DOCK_TOOL_NAMES])
    const { toolFamily } = await terminal.tools!.load()
    expect(typeof toolFamily.run).toBe("function")
  })

  it("contributes its prompts lazily", async () => {
    const { prompts } = await terminal.prompts!()
    expect(prompts).toHaveLength(3)
  })
})
