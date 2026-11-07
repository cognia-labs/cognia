import { councilLedgerFor, executeCouncilCommand, type CouncilCommandDeps } from "./council"
import type { SlashContext } from "../builtin"

function makeCtx(args: string, chatStatus: SlashContext["chatStatus"] = "idle") {
  const messages: string[] = []
  const ctx = {
    args,
    chatStatus,
    activeSessionId: "s1",
    currentPermissionMode: null,
    startNewSession: () => {},
    openSettings: () => {},
    setPermissionMode: () => {},
    pushSystemMessage: (m: string) => messages.push(typeof m === "string" ? m : JSON.stringify(m)),
  } as unknown as SlashContext
  return { ctx, messages }
}

/** Councillors (no systemPrompt) echo; synthesizer (has systemPrompt) reports. */
function fakeDeps(aliases: string[]): CouncilCommandDeps {
  return {
    loadAliases: async () => aliases,
    runPrompt: async (input) =>
      input.systemPrompt
        ? {
            completion: "## Council Response\nX\n## Council Summary\nConfidence: majority",
            model: "synth",
          }
        : { completion: `from ${input.modelAlias}`, model: input.modelAlias },
  }
}

describe("executeCouncilCommand", () => {
  it("refuses to run mid-turn", async () => {
    const { ctx, messages } = makeCtx("q", "streaming")
    await executeCouncilCommand(ctx, fakeDeps(["a", "b"]))
    expect(messages[0]).toMatch(/turn is in progress/)
  })

  it("shows usage when no prompt is given", async () => {
    const { ctx, messages } = makeCtx("--models a,b")
    await executeCouncilCommand(ctx, fakeDeps(["a", "b"]))
    expect(messages[0]).toMatch(/Usage: `\/council/)
  })

  it("guides the user when no aliases are configured", async () => {
    const { ctx, messages } = makeCtx("pick a db")
    await executeCouncilCommand(ctx, fakeDeps([]))
    expect(messages[0]).toMatch(/No models to convene/)
  })

  it("convenes a council and posts the synthesized report", async () => {
    const { ctx, messages } = makeCtx("queue or outbox?")
    await executeCouncilCommand(ctx, fakeDeps(["fast", "smart", "judge"]))
    expect(messages[0]).toMatch(/Convening a council of 3/)
    expect(messages[1]).toMatch(/Council Response/)
    expect(messages[1]).toMatch(/councillors responded/)
  })

  it("reports a council failure gracefully", async () => {
    const deps: CouncilCommandDeps = {
      loadAliases: async () => ["a", "b"],
      runPrompt: async (input) => {
        if (input.systemPrompt) throw new Error("synth down")
        return { completion: "ok" }
      },
    }
    const { ctx, messages } = makeCtx("q")
    await executeCouncilCommand(ctx, deps)
    expect(messages[messages.length - 1]).toMatch(/Council failed: synth down/)
  })
})

describe("councilLedgerFor", () => {
  it("books the command on utilityLedger under the conversation's own workspace", async () => {
    const loadSession = jest.fn(async () => ({ projectId: "ws-7" }))
    await expect(councilLedgerFor("s1", loadSession)).resolves.toEqual({
      surface: "utilityLedger",
      origin: "chat",
      featureId: "slash-council",
      workspaceId: "ws-7",
    })
    expect(loadSession).toHaveBeenCalledWith("s1")
  })

  it("attributes no workspace when there is no conversation or it cannot be read", async () => {
    const loadSession = jest.fn(async () => {
      throw new Error("db closed")
    })
    await expect(councilLedgerFor(null, loadSession)).resolves.toMatchObject({ workspaceId: null })
    expect(loadSession).not.toHaveBeenCalled()
    await expect(councilLedgerFor("s1", loadSession)).resolves.toMatchObject({ workspaceId: null })
  })
})
