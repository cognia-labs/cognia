/**
 * A plan approved in chat and handed to ONE implementing turn (ADR-0045,
 * Claude Code parity for `exit_plan_mode` and other orchestrated-shape plans
 * the approval dock resumes conversationally).
 *
 * The plan runtime has two executors — the in-session driver (one turn per
 * step) and the orchestrator (a synthesized workflow). A handed-off plan uses
 * neither: the model works the whole plan through in the turn the approval
 * sends, tracking its own progress with its task list. Before this record the
 * plan sat at `approved` forever — no tracker, and the next capture cancelled
 * it as if it had never run.
 *
 * The handoff is recorded in `metadata.chatHandoff` (no new status, so the
 * plugin contract is unchanged):
 *
 *   approve  → `executing`, `chatHandoff` stamped with the turn's prompt / mode
 *   the turn ends cleanly            → `completed`
 *   the turn fails or is stopped     → `paused`, with `chatResumeFailure` so the
 *                                      approval dock offers Resume / Mark done
 *   the renderer restarts mid-turn   → `paused` the same way (boot recovery)
 *
 * The settlement hook is `finishDirectChatExecutionRun`, the one function every
 * chat turn's end funnels through, on every runtime lane.
 */

import type { AgentPlan } from "@/types/agent/plan"

export interface PlanChatHandoff {
  prompt: string
  mode: "default" | "acceptEdits" | "auto"
  /** When the implementing turn was handed the plan; earlier turns never settle it. */
  startedAt: number
  /** The renderer load that sent it (boot recovery tells orphans apart by it). */
  bootId: string
}

const MODES = new Set(["default", "acceptEdits", "auto"])

/** The handoff record of a plan, or null for a plan run any other way. */
export function readChatHandoff(plan: Pick<AgentPlan, "metadata">): PlanChatHandoff | null {
  const raw = plan.metadata?.chatHandoff
  if (!raw || typeof raw !== "object") return null
  const value = raw as Record<string, unknown>
  if (typeof value.prompt !== "string" || !value.prompt.trim()) return null
  if (typeof value.mode !== "string" || !MODES.has(value.mode)) return null
  if (typeof value.startedAt !== "number" || typeof value.bootId !== "string") return null
  return {
    prompt: value.prompt,
    mode: value.mode as PlanChatHandoff["mode"],
    startedAt: value.startedAt,
    bootId: value.bootId,
  }
}

export function isChatHandoffPlan(plan: Pick<AgentPlan, "metadata">): boolean {
  return readChatHandoff(plan) !== null
}

/**
 * Settle the session's handed-off plan after a chat turn ended. A turn that
 * started before the handoff (still running when the user approved) is not the
 * implementing turn and leaves the plan alone. Errors are logged, never thrown:
 * plan bookkeeping must not fail the turn's own teardown.
 */
export async function settlePlanChatHandoffAfterTurn(
  sessionId: string,
  outcome: "completed" | "failed" | "cancelled",
  turnStartedAt: number,
  detail?: string
): Promise<void> {
  try {
    const { getPlanRuntime } = await import("./runtime")
    const runtime = getPlanRuntime()
    const plan = await runtime.getExecutingPlanForSession(sessionId)
    if (!plan) return
    const handoff = readChatHandoff(plan)
    if (!handoff || turnStartedAt < handoff.startedAt) return
    await runtime.settleChatHandoff(plan.id, outcome, detail)
  } catch (error) {
    console.warn("plan chat handoff settle failed", error)
  }
}
