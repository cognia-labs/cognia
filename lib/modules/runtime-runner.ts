/**
 * Start a host's module runtimes and stop them again (ADR-0250 §14, M2).
 *
 * The renderer hosts' counterpart of `bootstrapHeadlessRuntimes`: one
 * runtime's failure never stops the rest, later runtimes may depend on
 * earlier ones so teardown runs in reverse, and a stop asked for while
 * runtimes are still starting waits for them and then tears down what did
 * start. `after` holds a run back until the previous run's teardown settles,
 * so a StrictMode replay or an account switch never has two instances of one
 * runtime alive at once (ADR-0250 §2: start, cancel, awaited teardown).
 *
 * Host-neutral and React-free; `components/providers/initializers/
 * module-runtime-host.tsx` owns the mount.
 */

import type {
  ModuleRuntimeTeardown,
  RendererRuntimeContext,
  RendererRuntimeEntry,
} from "./manifest-types"

export interface ModuleRuntimeStartReport {
  /** Names that started, in start order. */
  started: string[]
  /** Names whose adapter failed to load or start, with why. */
  failed: Array<{ name: string; error: string }>
  /** Names never started because the run was stopped first. */
  skipped: string[]
}

export interface ModuleRuntimeRun {
  /** Settles once every runtime has started, failed or been skipped. */
  started: Promise<ModuleRuntimeStartReport>
  /** Stop starting, then tear down what started, last first. Idempotent. */
  stop(): Promise<void>
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function startModuleRuntimes(
  entries: readonly RendererRuntimeEntry[],
  ctx: RendererRuntimeContext,
  options: { after?: Promise<unknown> } = {}
): ModuleRuntimeRun {
  let stopping = false
  const teardowns: Array<{ name: string; teardown: ModuleRuntimeTeardown }> = []

  const started = (async (): Promise<ModuleRuntimeStartReport> => {
    await options.after?.catch(() => undefined)
    const report: ModuleRuntimeStartReport = { started: [], failed: [], skipped: [] }
    for (const entry of entries) {
      if (stopping) {
        report.skipped.push(entry.name)
        continue
      }
      try {
        const adapter = await entry.load()
        if (stopping) {
          report.skipped.push(entry.name)
          continue
        }
        const teardown = await adapter.start(ctx)
        if (typeof teardown === "function") teardowns.push({ name: entry.name, teardown })
        report.started.push(entry.name)
        ctx.log("info", `module runtime started: ${entry.name} (${entry.module})`)
      } catch (error) {
        report.failed.push({ name: entry.name, error: describe(error) })
        ctx.log(
          entry.criticality === "required" ? "error" : "warn",
          `module runtime failed to start: ${entry.name} (${entry.module}): ${describe(error)}`
        )
      }
    }
    return report
  })()

  let stopped: Promise<void> | undefined
  return {
    started,
    stop() {
      stopping = true
      stopped ??= started.then(async () => {
        for (const { name, teardown } of teardowns.reverse()) {
          try {
            await teardown()
          } catch (error) {
            ctx.log("warn", `module runtime teardown failed: ${name}: ${describe(error)}`)
          }
        }
      })
      return stopped
    },
  }
}
