import type { RendererRuntimeContext, RendererRuntimeEntry } from "./manifest-types"
import { startModuleRuntimes } from "./runtime-runner"

function entry(
  name: string,
  start: () => unknown,
  over: Partial<RendererRuntimeEntry> = {}
): RendererRuntimeEntry {
  return {
    module: "demo",
    stage: "stable",
    name,
    criticality: "optional",
    load: async () => ({ start: start as never }),
    ...over,
  }
}

function context() {
  const log = jest.fn<void, Parameters<RendererRuntimeContext["log"]>>()
  const ctx: RendererRuntimeContext = { host: "desktop", accountId: "acct", log }
  return { ctx, log }
}

describe("startModuleRuntimes", () => {
  it("starts in order and tears down in reverse", async () => {
    const events: string[] = []
    const { ctx } = context()
    const run = startModuleRuntimes(
      [
        entry("a", () => {
          events.push("start a")
          return () => events.push("stop a")
        }),
        entry("b", async () => {
          events.push("start b")
          return async () => {
            events.push("stop b")
          }
        }),
        // No teardown: nothing to stop.
        entry("c", () => {
          events.push("start c")
        }),
      ],
      ctx
    )
    await expect(run.started).resolves.toEqual({
      started: ["a", "b", "c"],
      failed: [],
      skipped: [],
    })
    await run.stop()
    expect(events).toEqual(["start a", "start b", "start c", "stop b", "stop a"])
  })

  it("passes the host context to every adapter", async () => {
    const { ctx } = context()
    const start = jest.fn()
    await startModuleRuntimes([entry("a", start)], ctx).started
    expect(start).toHaveBeenCalledWith(ctx)
  })

  it("keeps starting after one runtime fails to load or start", async () => {
    const { ctx, log } = context()
    const run = startModuleRuntimes(
      [
        entry("broken-load", () => undefined, {
          load: () => Promise.reject(new Error("chunk missing")),
        }),
        entry(
          "broken-start",
          () => {
            throw new Error("no database")
          },
          { criticality: "required" }
        ),
        entry("fine", () => undefined),
      ],
      ctx
    )
    await expect(run.started).resolves.toEqual({
      started: ["fine"],
      failed: [
        { name: "broken-load", error: "chunk missing" },
        { name: "broken-start", error: "no database" },
      ],
      skipped: [],
    })
    expect(log).toHaveBeenCalledWith(
      "warn",
      "module runtime failed to start: broken-load (demo): chunk missing"
    )
    expect(log).toHaveBeenCalledWith(
      "error",
      "module runtime failed to start: broken-start (demo): no database"
    )
  })

  it("waits for the previous run's teardown before starting", async () => {
    const { ctx } = context()
    let release!: () => void
    const previousStop = new Promise<void>((resolve) => {
      release = resolve
    })
    const start = jest.fn()
    const run = startModuleRuntimes([entry("a", start)], ctx, { after: previousStop })
    await Promise.resolve()
    await Promise.resolve()
    expect(start).not.toHaveBeenCalled()
    release()
    await run.started
    expect(start).toHaveBeenCalledTimes(1)
  })

  it("starts even when the previous teardown failed", async () => {
    const { ctx } = context()
    const start = jest.fn()
    const run = startModuleRuntimes([entry("a", start)], ctx, {
      after: Promise.reject(new Error("teardown threw")),
    })
    await run.started
    expect(start).toHaveBeenCalledTimes(1)
  })

  it("skips what has not started once stopped, and stops what was starting", async () => {
    const events: string[] = []
    const { ctx } = context()
    let finishStart!: () => void
    const run = startModuleRuntimes(
      [
        entry(
          "slow",
          () =>
            new Promise<() => void>((resolve) => {
              finishStart = () => resolve(() => events.push("stop slow"))
            })
        ),
        entry("later", () => events.push("start later")),
      ],
      ctx
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    const stopped = run.stop()
    finishStart()
    await stopped
    await expect(run.started).resolves.toEqual({
      started: ["slow"],
      failed: [],
      skipped: ["later"],
    })
    expect(events).toEqual(["stop slow"])
  })

  it("tears down the rest when one teardown throws, and stops once", async () => {
    const { ctx, log } = context()
    const stopA = jest.fn()
    const run = startModuleRuntimes(
      [
        entry("a", () => stopA),
        entry("b", () => () => {
          throw new Error("stuck")
        }),
      ],
      ctx
    )
    await run.started
    const first = run.stop()
    expect(run.stop()).toBe(first)
    await first
    expect(stopA).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith("warn", "module runtime teardown failed: b: stuck")
  })
})
