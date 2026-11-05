/**
 * The Squad bootstrap as a module runtime, on every host (ADR-0169,
 * ADR-0250 §14 M2): store hydration, runtime adapters, legacy history import,
 * interrupt and durable-run recovery, recovery arming.
 *
 * One adapter serves the brain, the desktop and the phone, because the
 * bootstrap is host-neutral and needs nothing from its host but a log: the
 * brain used to install only the adapters, so a team run interrupted by a
 * brain restart was never recovered (workflow resume leaves `__team__:` runs
 * to this coordinator). The renderer hosts restart it when the unlocked
 * account changes, so a mirror started against one account's database never
 * keeps writing into another's.
 */

import type { RendererRuntimeContext } from "@/lib/modules/manifest-types"

export async function start(ctx: Pick<RendererRuntimeContext, "log">): Promise<() => void> {
  const { runSquadBootstrap } = await import("@/lib/agent-team/bootstrap")
  const handle = runSquadBootstrap()
  let disposed = false
  void handle.done.then((outcome) => {
    // A run superseded by its own restart finishes "failed" on purpose.
    if (!outcome.ok && !disposed)
      ctx.log("warn", `agent team bootstrap failed at ${outcome.failedStage ?? "unknown stage"}`)
  })
  return () => {
    disposed = true
    handle.dispose()
  }
}
