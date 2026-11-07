/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import type { ExecutionRun } from "@/types/execution/run"
import { __enableDbRuntimeForTesting, __resetDbForTesting, getDb } from "@/lib/db/schema"
import { getExecutionRun, listExecutionRunEvents } from "@/lib/db/execution-runs"
import { startToolExecutionRun } from "./acting-authority"
import {
  __resetChildRunOwnershipForTesting,
  CHILD_RUN_LAUNCHER_MARK,
  inProcessOwnership,
  reconcileOrphanedChildRuns,
  webLockOwnership,
  type ChildRunOwnership,
  type OrphanReconcileDeps,
} from "./child-run-ownership"

/** A Web Lock manager shared by several "webviews", like the browser's. */
function fakeLocks() {
  const held = new Map<string, () => void>()
  const waiting: { name: string; grant: () => void }[] = []
  const manager = {
    request(name: string, callback: () => Promise<void>): Promise<void> {
      return new Promise((resolve) => {
        const grant = () => {
          held.set(name, () => undefined)
          void callback().then(() => {
            held.delete(name)
            const next = waiting.findIndex((w) => w.name === name)
            if (next >= 0) waiting.splice(next, 1)[0].grant()
            resolve()
          })
        }
        if (held.has(name)) waiting.push({ name, grant })
        else grant()
      })
    },
    async query() {
      return { held: [...held.keys()].map((name) => ({ name })) }
    },
  }
  return { manager, held }
}

function run(id: string, patch: Partial<ExecutionRun> = {}): ExecutionRun {
  return {
    id,
    kind: "job",
    sourceId: id.replace("execution:job:", ""),
    title: "t",
    status: "running",
    currentRevision: 0,
    startedAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

describe("ownership claims", () => {
  it("a Web Lock claim is visible to every webview until it is released", async () => {
    const { manager } = fakeLocks()
    const here = webLockOwnership(manager)
    const elsewhere = webLockOwnership(manager)
    const release = await here.hold("execution:job:a")
    expect(await elsewhere.held()).toEqual(new Set(["execution:job:a"]))
    release()
    await Promise.resolve()
    await Promise.resolve()
    expect(await elsewhere.held()).toEqual(new Set())
  })

  it("an in-process claim counts its holders", async () => {
    const claims = inProcessOwnership()
    const first = await claims.hold("r")
    const second = await claims.hold("r")
    first()
    first()
    expect(await claims.held()).toEqual(new Set(["r"]))
    second()
    expect(await claims.held()).toEqual(new Set())
  })
})

describe("reconcileOrphanedChildRuns", () => {
  function deps(
    rows: ExecutionRun[],
    options: {
      ownership: ChildRunOwnership
      launcher?: Set<string>
      outbox?: Set<string>
    }
  ) {
    const settled: string[] = []
    const value: OrphanReconcileDeps = {
      listOpenJobRuns: async () => rows,
      isLauncherRun: async (id) => options.launcher?.has(id) ?? true,
      hasOutboxEntry: async (childId) => options.outbox?.has(childId) ?? false,
      settleCancelled: async (id) => {
        settled.push(id)
        return true
      },
      ownership: options.ownership,
    }
    return { value, settled }
  }

  it("settles only the launcher's rows that no live process claims", async () => {
    const ownership = inProcessOwnership()
    await ownership.hold("execution:job:live")
    const { value, settled } = deps(
      [
        run("execution:job:live"),
        run("execution:job:orphan"),
        // An outbound or integration job shares the id space and is never touched.
        run("execution:job:outbound:o1"),
        // A child with an outbox entry is the outbox's to reconcile.
        run("execution:job:bg_1"),
      ],
      {
        ownership,
        launcher: new Set(["execution:job:live", "execution:job:orphan", "execution:job:bg_1"]),
        outbox: new Set(["bg_1"]),
      }
    )
    await expect(reconcileOrphanedChildRuns(value)).resolves.toEqual(["execution:job:orphan"])
    expect(settled).toEqual(["execution:job:orphan"])
  })

  it("picks no claims at all in a browser without Web Locks", async () => {
    // jsdom: a browser window, no `navigator.locks`.
    __resetChildRunOwnershipForTesting()
    const { value, settled } = deps([run("execution:job:x")], {
      ownership: undefined as unknown as ChildRunOwnership,
    })
    delete value.ownership
    await expect(reconcileOrphanedChildRuns(value)).resolves.toEqual([])
    expect(settled).toEqual([])
  })

  it("touches nothing on a host that cannot tell claims apart", async () => {
    const blind: ChildRunOwnership = { hold: async () => () => undefined, held: async () => null }
    const { value, settled } = deps([run("execution:job:x")], { ownership: blind })
    await expect(reconcileOrphanedChildRuns(value)).resolves.toEqual([])
    expect(settled).toEqual([])
  })

  it("reads the rows before the claims, so a run launched meanwhile is never settled", async () => {
    const { manager } = fakeLocks()
    const ownership = webLockOwnership(manager)
    const order: string[] = []
    const value: OrphanReconcileDeps = {
      listOpenJobRuns: async () => {
        order.push("rows")
        return []
      },
      isLauncherRun: async () => true,
      hasOutboxEntry: async () => false,
      settleCancelled: async () => true,
      ownership: {
        hold: ownership.hold,
        held: async () => {
          order.push("claims")
          return ownership.held()
        },
      },
    }
    await reconcileOrphanedChildRuns(value)
    // No open rows: nothing to ask about.
    expect(order).toEqual(["rows"])
    value.listOpenJobRuns = async () => {
      order.push("rows")
      return [run("execution:job:y")]
    }
    await reconcileOrphanedChildRuns(value)
    expect(order).toEqual(["rows", "rows", "claims"])
  })

  describe("against executionRuns", () => {
    let disableDbRuntime: (() => void) | undefined
    beforeEach(async () => {
      disableDbRuntime = __enableDbRuntimeForTesting()
      await getDb().delete()
      __resetDbForTesting()
      // A restarted single-process host: nothing it holds survived.
      __resetChildRunOwnershipForTesting(inProcessOwnership())
    })
    afterEach(async () => {
      await getDb().delete()
      __resetDbForTesting()
      disableDbRuntime?.()
      __resetChildRunOwnershipForTesting()
    })

    it("settles an orphaned launcher row cancelled, leaving other jobs and settled rows", async () => {
      await startToolExecutionRun(undefined, {
        runId: "execution:job:orphan",
        launchedBy: CHILD_RUN_LAUNCHER_MARK,
      })
      await startToolExecutionRun(undefined, { runId: "execution:job:outbound:o1" })
      await startToolExecutionRun(undefined, {
        runId: "execution:job:done",
        launchedBy: CHILD_RUN_LAUNCHER_MARK,
      })
      await getDb().executionRuns.update("execution:job:done", { status: "completed" })

      const settled = await reconcileOrphanedChildRuns()

      expect(settled).toEqual(["execution:job:orphan"])
      expect((await getExecutionRun("execution:job:orphan"))?.status).toBe("cancelled")
      expect((await getExecutionRun("execution:job:outbound:o1"))?.status).toBe("running")
      const events = await listExecutionRunEvents("execution:job:orphan")
      expect(events.at(-1)).toMatchObject({
        type: "run.cancelled",
        payload: { reason: "host_stopped" },
      })
    })

    it("leaves a launcher row whose child delivers through the outbox", async () => {
      await startToolExecutionRun(undefined, {
        runId: "execution:job:bg_9",
        launchedBy: CHILD_RUN_LAUNCHER_MARK,
      })
      await getDb().backgroundTasks.put({
        runId: "bg_9",
        kind: "plugin-agent",
        subagentId: "x",
        prompt: "p",
        sessionId: "",
        host: "renderer",
        startedAt: 1,
        mode: "background",
      } as never)
      await expect(reconcileOrphanedChildRuns()).resolves.toEqual([])
      expect((await getExecutionRun("execution:job:bg_9"))?.status).toBe("running")
    })
  })
})
