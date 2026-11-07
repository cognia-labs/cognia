// The squads module's implementation of the `twin-answer` port
// (`types/modules/ports/twin-answer.ts`, ADR-0252 §3). The launcher writes the
// child's row; this answers the question as the twin: the twin's persona and
// the knowledge relevant to the question join the system prompt
// (`applyTeammateTwinContext`), then the launcher's own agent engine runs it.
//
// The persona is best-effort, as it always was for a twin delegation: with
// the twin runtime unavailable (no vector store, the twin deleted) the
// question runs on the base instructions.

import type { TwinAnswerInput, TwinAnswerPort } from "@/types/modules/ports/twin-answer"
import type { StartedChildEngine } from "@/types/execution/child-run"
import { startAgentEngine } from "@/lib/execution/launch-child-run"

async function twinSystemPrompt(input: TwinAnswerInput): Promise<string | undefined> {
  try {
    const { tryBuildTwinDeps } = await import("@/lib/twin/runtime/build-deps")
    const twinDeps = await tryBuildTwinDeps()
    if (!twinDeps) return input.systemPrompt
    const [{ applyTeammateTwinContext }, { getTwin }] = await Promise.all([
      import("../teammate/twin-context"),
      import("@/lib/db/twins"),
    ])
    const twin = await getTwin(input.twinId).catch(() => undefined)
    const injected = await applyTeammateTwinContext({
      actorName: twin?.name ?? input.twinId,
      baseSystemPrompt: input.systemPrompt ?? "",
      userPrompt: input.question,
      twinId: input.twinId,
      twinDeps,
      source: "team-delegation",
    })
    return injected.systemPrompt
  } catch {
    return input.systemPrompt
  }
}

export const port: TwinAnswerPort = {
  start(input): StartedChildEngine {
    let stopped: string | undefined
    let engine: StartedChildEngine | undefined
    const outcome = twinSystemPrompt(input).then((systemPrompt) => {
      // Stopped while the persona was loading: the answer never starts.
      if (stopped !== undefined) return { status: "cancelled" as const, error: stopped }
      engine = startAgentEngine({
        prompt: input.question,
        ...(systemPrompt ? { systemPrompt } : {}),
        grants: input.grants,
      })
      return engine.outcome
    })
    return {
      outcome,
      stop: (reason) => {
        stopped = reason ?? "stopped"
        engine?.stop(reason)
      },
    }
  },
}
