import { expect } from "@playwright/test"
import expected from "./expected/chat-tool-turn.json"
import { defineDualHostBehaviour } from "./harness"
import { ledgerDiff } from "./ledger"
import { TOOL_TURN_MARKER, TOOL_TURN_FINAL_TEXT } from "../real-e2e/scenarios/tool-turn.mjs"

defineDualHostBehaviour(
  "a TodoWrite chat turn has the same settled ledger",
  async (host, { page, testInfo }) => {
    await host.openNewChat()
    await host.send(`${TOOL_TURN_MARKER} Update the fixed todo list, then finish.`)
    await host.waitForAssistantText(
      new RegExp(TOOL_TURN_FINAL_TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    )
    await host.waitForIdle()
    const sessionId = await host.activeSessionId()
    const ledger = await host.readLedger(sessionId)
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({ source: "direct-chat", status: "succeeded" })
    expect(ledger[0].toolCalls).toEqual([{ name: "TodoWrite", status: "completed" }])
    expect(ledger, ledgerDiff(expected, ledger)).toEqual(expected)

    if (host.kind === "web-headless") {
      const evidence = await page.evaluate(async (session) => {
        const [run] = await window.__cogniaReadExecutionRuns!(session)
        try {
          const detail = (await window.__cogniaE2ECompanion!.call("execution_run_detail", {
            runId: run.id,
          })) as { run?: { id?: string } } | null
          return detail?.run?.id === run.id ? "present" : "absent"
        } catch (error) {
          return `unavailable: ${error instanceof Error ? error.message : String(error)}`
        }
      }, sessionId)
      // ADR-0250 phase 1 still has to decide who owns the brain ledger. Record
      // this separately: renderer parity is blocking; brain possession is observational.
      testInfo.annotations.push({ type: "brain-ledger", description: evidence })
    }
  }
)
