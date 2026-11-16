import {
  quiescePersonalEgress,
  releasePersonalEgressOperations,
} from "../../policy/personal-egress.ts"
import type { PumpContext } from "./runtime-types.ts"
import { randomUUID } from "node:crypto"
import { createRunBudgetGuard, type StepUsage } from "../common/run-budget.ts"

import { PLUGIN_TOOLS_SERVER_NAME } from "../../policy/tool-catalog/names.ts"

import { restorePluginToolNamesInSdkMessage } from "../../policy/tool-catalog/plugin-aliases.ts"

import { extractHttpErrorMeta } from "../../providers/http-error-meta.ts"
import { sessionEndedFromResult } from "./result-terminal.ts"
import { createProviderStreamLogger } from "../../providers/stream-log.ts"

export function startAnthropicPump({
  sessionId,
  sendOptions,
  emit,
  log,
  q,
  mcpAutoReconnect,
  pluginToolNameAliases,
  session,
  state,
  mcpStderrSink,
  toolSession,
  waitForProcessExit,
  waitForLeaderExit,
}: PumpContext) {
  const closeInput = session.closeInput
  const executorId = randomUUID()
  emit({ type: "executor_started", sessionId, executorId })
  // Pipe SDK events to the parent. Captures the SDK-issued session id on the
  // first event that carries one (powers resume continuity).
  let sdkSessionIdSeen = false
  // Separates "the provider never answered" from "the stream broke mid-flight"
  // when a turn stalls — see `../src/providers/stream-log.ts`.
  const streamLog = createProviderStreamLogger({ sessionId, turnId: sendOptions.turnId, log })
  // `session_ended` is emitted exactly once per turn, from whichever of the
  // three exits below is reached first (the `result` frame, the iterator
  // draining, or a throw).
  let turnEnded = false
  let liveSdkTasks = new Set<string>()
  Object.assign(session, {
    fencePersonalEgress: async (excludedToolUseIds: readonly string[] = []) => {
      await quiescePersonalEgress(sendOptions, excludedToolUseIds)
      await toolSession.disposeProcesses()
      if ((await toolSession.hasLiveProcesses()) || liveSdkTasks.size > 0)
        throw new Error("Personal process isolation unconfirmed; private content withheld")
    },
  })
  const endTurn = (event: Record<string, unknown>) => {
    if (turnEnded) return
    releasePersonalEgressOperations(sendOptions)
    turnEnded = true
    emit(event)
  }
  // ADR-0243 hold: the SDK sizes its own requests, so a spent hold or a passed
  // deadline interrupts the query before it takes another step.
  const budget = sendOptions.runBudget ? createRunBudgetGuard(sendOptions.runBudget) : undefined
  const stopForBudget = () =>
    void Promise.resolve()
      .then(() => q.interrupt())
      .catch((error: unknown) => log("warn", `budget interrupt failed: ${String(error)}`))
  const deadlineTimer =
    sendOptions.runBudget?.deadlineAt === undefined
      ? undefined
      : setTimeout(stopForBudget, Math.max(0, sendOptions.runBudget.deadlineAt - Date.now()))
  void (async () => {
    try {
      for await (const evt of q) {
        if (budget && evt.type === "assistant") {
          // The SDK emits one assistant frame per content block, each
          // carrying its API message's usage.
          const message = evt.message as { id?: string; usage?: StepUsage } | undefined
          budget.observe(message?.usage ?? {}, message?.id)
          if (budget.spent()) stopForBudget()
        }
        streamLog.onEvent()
        if (!sdkSessionIdSeen && evt && typeof evt.session_id === "string") {
          sdkSessionIdSeen = true
          emit({
            type: "sdk_session_id",
            sessionId,
            sdkSessionId: evt.session_id,
          })
        }
        mcpAutoReconnect.onEvent(evt)
        // The SDK's level signal covers native background Bash and Task jobs.
        // Keep observing after result until input EOF reaps those jobs.
        if (evt.type === "system" && evt.subtype === "background_tasks_changed") {
          const tasks = evt.tasks
          if (Array.isArray(tasks))
            liveSdkTasks = new Set(tasks.map((task) => String(task.task_id)))
        }
        emit({
          type: "event",
          sessionId,
          event: restorePluginToolNamesInSdkMessage(
            pluginToolNameAliases,
            PLUGIN_TOOLS_SERVER_NAME,
            evt
          ),
        })
        // THE turn boundary. `query()` is driven by a streaming input iterable,
        // so the SDK keeps the query open for another prompt after the `result`
        // frame and this `for await` does not end on its own — it ends when the
        // input stream closes, which for this rail only happens at session
        // teardown. Waiting for that meant `session_ended` never fired per
        // turn, and `run-and-capture` (CLI, connectors, goal runner) completes
        // on nothing else: every turn ran to its wall-clock deadline, and an
        // upstream failure carried on this frame — a 404 from a mistyped
        // `ANTHROPIC_BASE_URL` — never reached the caller at all.
        //
        // The desktop adapter has always treated `result` as the end of the
        // turn (`turnComplete: true` in `lib/chat/sdk-message-adapter.ts`); this makes
        // the sidecar say the same thing to everyone else.
        if (evt?.type === "result") {
          state.outstandingPrompts -= 1
          // A steer pushed a second prompt into this same query; its `result`
          // is still to come, so the turn is not over.
          if (state.outstandingPrompts > 0) continue
          streamLog.onEnd()
          endTurn(sessionEndedFromResult(sessionId, evt))
          // Every prompt has been answered. Context is rebuilt next turn via
          // SDK `resume` (see `restartReason` in agent-host.mjs, which retires
          // an Anthropic session on every `session_ended`), so close the input
          // and let the subprocess exit instead of idling until teardown.
          closeInput()
        }
      }
      // Reached when the iterator drained without a `result` frame (input
      // closed, or the query was torn down). Already-ended turns skip it.
      if (!turnEnded) {
        streamLog.onEnd()
        endTurn({ type: "session_ended", sessionId })
      }
    } catch (err) {
      streamLog.onError(err)
      endTurn({
        type: "session_ended",
        sessionId,
        error: err instanceof Error ? err.message : String(err),
        // Forward the real HTTP status + Retry-After so the renderer classifies
        // the failure and times the breaker cooldown off authoritative data
        // instead of string-matching the message.
        ...extractHttpErrorMeta(err),
      })
    } finally {
      session.finishRuntime?.()
      session.drainPending("Claude invocation ended")
      session._ended = true
      // Flush any trailing partial stderr line so the last unterminated MCP log
      // isn't dropped at session end.
      mcpStderrSink.end()
      clearTimeout(deadlineTimer)
      // Close the per-session LSP servers and code-graph store + file watcher.
      toolSession.disposeResolvers()

      // Closing a Query can precede the CLI's real exit, and SDK-native Bash /
      // Task jobs are separate from Cognia's tool-session process registry.
      q.close?.()
      const proof = waitForProcessExit()
      const [cliExit, disposal, leaderExit] = await Promise.allSettled([
        proof,
        toolSession.disposeProcesses(),
        waitForLeaderExit ? waitForLeaderExit() : proof,
      ])
      // Leader-settled signal: the executor's power and turn lifecycle follow
      // the CLI and the leaders of its jobs, never stop proof (ADR-0244). It
      // releases the wake hold even where proof stays unconfirmed (Windows).
      let backgroundProcessesRunning = true
      try {
        backgroundProcessesRunning =
          leaderExit.status === "rejected" ||
          liveSdkTasks.size > 0 ||
          (await toolSession.hasRunningProcesses())
      } catch {
        // An unreadable process registry must not look idle.
      }
      emit({ type: "turn_settled", sessionId, executorId, backgroundProcessesRunning })
      try {
        if (cliExit.status === "rejected") throw cliExit.reason
        if (disposal.status === "rejected") throw disposal.reason
        if (await toolSession.hasLiveProcesses())
          throw new Error("session process group stop unconfirmed")
        if (liveSdkTasks.size > 0)
          throw new Error("Claude runtime still reports live background tasks")
        // WP1 proves the Claude CLI and Cognia Bash/jobs/PTY TOOL groups;
        // MCP/hooks/LSP and other helper processes are deferred (ADR-0244).
        emit({ type: "session_disposed", sessionId, executorId })
      } catch (error) {
        log("error", `Claude runtime disposal unconfirmed: ${String(error)}`)
      }
    }
  })()
}
