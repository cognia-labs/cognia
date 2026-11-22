/** @jest-environment jsdom */
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { getProjectMiningRun, listProjectMiningRuns } from "@/lib/db/project-mining-runs"
import {
  cancelWorkspaceBackfill,
  confirmWorkspaceBackfill,
  estimateWorkspaceBackfill,
  proposeWorkspaceBackfill,
  tickActiveWorkspaceBackfills,
  tickWorkspaceBackfill,
} from "./backfill-service"
import { composeTurnText } from "@/lib/chat/prompt-preamble"
import { enqueueProjectMiningJobs } from "@/lib/memory/write/project-mining-enqueue"
import { preparePersonalHistory } from "@/lib/execution/personal-visibility"
import { startMemoryJobWorker, __resetMemoryDrainLock } from "@/lib/memory/lifecycle/job-worker"
import { claimNextMemoryJob, finishMemoryJob } from "@/lib/db/memory-governance"

// Pass-through: the real queue still runs; the spy only lets a test read the
// transcript the production deps built.
jest.mock("@/lib/memory/write/project-mining-enqueue", () => {
  const actual = jest.requireActual("@/lib/memory/write/project-mining-enqueue")
  return {
    ...actual,
    enqueueProjectMiningJobs: jest.fn((...args: unknown[]) =>
      actual.enqueueProjectMiningJobs(...args)
    ),
  }
})
jest.mock("@/lib/execution/personal-visibility", () => {
  const actual = jest.requireActual("@/lib/execution/personal-visibility")
  return {
    ...actual,
    preparePersonalHistory: jest.fn((...args: unknown[]) => actual.preparePersonalHistory(...args)),
  }
})

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

async function seedSession(id: string, projectId: string, createdAt: number) {
  await getDb().sessions.put({
    id,
    projectId,
    title: id,
    createdAt,
    updatedAt: createdAt,
  } as never)
}

async function seedMessage(id: string, sessionId: string, projectId: string, createdAt: number) {
  await getDb().messages.put({
    id,
    sessionId,
    projectId,
    role: "user",
    parts: [{ type: "text", text: "we standardised on pnpm workspaces" }],
    createdAt,
  } as never)
}

describe("the preconsent estimate", () => {
  it("counts the workspace's own sessions and messages", async () => {
    await seedSession("s1", "p1", 100)
    await seedSession("s2", "p1", 200)
    await seedSession("other", "p2", 300)
    await seedMessage("m1", "s1", "p1", 100)
    await seedMessage("m2", "s2", "p1", 200)
    await seedMessage("m3", "other", "p2", 300)
    const estimate = await estimateWorkspaceBackfill("p1")
    expect(estimate.sessions).toBe(2)
    expect(estimate.messages).toBe(2)
  })
})

describe("proposing", () => {
  it("creates one run in preconsent", async () => {
    await seedSession("s1", "p1", 100)
    const run = await proposeWorkspaceBackfill("p1")
    expect(run.status).toBe("preconsent")
  })

  it("hands back the run already in flight rather than starting a rival", async () => {
    // Two runs over one workspace would fight over the same cursor and mine
    // everything twice.
    await seedSession("s1", "p1", 100)
    const first = await proposeWorkspaceBackfill("p1")
    await confirmWorkspaceBackfill(first.id)
    const second = await proposeWorkspaceBackfill("p1")
    expect(second.id).toBe(first.id)
    expect(await listProjectMiningRuns("p1")).toHaveLength(1)
  })

  it("allows a fresh run once the previous one ended", async () => {
    await seedSession("s1", "p1", 100)
    const first = await proposeWorkspaceBackfill("p1")
    await cancelWorkspaceBackfill(first.id)
    const second = await proposeWorkspaceBackfill("p1")
    expect(second.id).not.toBe(first.id)
  })
})

describe("the background tick", () => {
  it("excludes marked source prose before a workspace backfill can enqueue a model job", async () => {
    await seedSession("s1", "p1", 100)
    await seedMessage("public", "s1", "p1", 100)
    await seedMessage("private", "s1", "p1", 101)
    await seedMessage("legacy", "s1", "p1", 102)
    await getDb().sessions.update("s1", {
      platformBinding: { platform: "lark", adapterId: "adapter", conversationKey: "conversation" },
    } as never)
    await getDb().messages.update("public", { metadata: { personalMarkVersion: 1 } })
    await getDb().messages.update("private", {
      parts: [{ type: "text", text: "private source prose" }],
      metadata: {
        personalMarks: [{ person: { kind: "local-person" }, source: "test", markedAt: 1 }],
      },
    } as never)
    const run = await proposeWorkspaceBackfill("p1")
    await confirmWorkspaceBackfill(run.id)
    jest.mocked(enqueueProjectMiningJobs).mockClear()
    await tickWorkspaceBackfill("p1")
    const [input] = jest.mocked(enqueueProjectMiningJobs).mock.calls[0]!
    expect(input.transcript.map((message) => message.id)).toEqual(["public"])
    expect(JSON.stringify(input)).not.toContain("private source prose")
  })

  it("will not move a run a person has not agreed to", async () => {
    await seedSession("s1", "p1", 100)
    const run = await proposeWorkspaceBackfill("p1")
    expect(await tickWorkspaceBackfill("p1")).toEqual({ kind: "idle" })
    expect((await getProjectMiningRun(run.id))?.status).toBe("preconsent")
  })

  it("walks the workspace newest first and moves the watermark", async () => {
    await seedSession("s1", "p1", 100)
    await seedSession("s2", "p1", 300)
    await seedMessage("m1", "s1", "p1", 100)
    await seedMessage("m2", "s2", "p1", 300)
    const run = await proposeWorkspaceBackfill("p1")
    await confirmWorkspaceBackfill(run.id)
    const outcome = await tickWorkspaceBackfill("p1")
    expect(outcome.kind).toBe("advanced")
    const after = await getProjectMiningRun(run.id)
    // The page is newest-first, so the watermark lands on the OLDEST row it saw.
    expect(after?.cursorSessionId).toBe("s1")
    expect(after?.sessionsScanned).toBe(2)
  })

  // A user turn that carried references persists the composer's context
  // envelope in its text. The miner must read what the user wrote, or it would
  // credit them with every snapshot they ever attached.
  it("hands the miner what the user typed, not the context envelope", async () => {
    await seedSession("s1", "p1", 100)
    const { text } = composeTurnText(
      "we standardised on pnpm workspaces",
      [{ kind: "references", text: "SNAPSHOT FROM ANOTHER CHAT" }],
      { nonce: "abcdef1234" }
    )
    await getDb().messages.put({
      id: "m1",
      sessionId: "s1",
      projectId: "p1",
      role: "user",
      parts: [
        { type: "text", text },
        { type: "image", alt: "I always use yarn" },
      ],
      createdAt: 100,
    } as never)
    const run = await proposeWorkspaceBackfill("p1")
    await confirmWorkspaceBackfill(run.id)
    jest.mocked(enqueueProjectMiningJobs).mockClear()
    await tickWorkspaceBackfill("p1")
    const [params] = jest.mocked(enqueueProjectMiningJobs).mock.calls[0]!
    expect(params.transcript.map((m) => m.text)).toEqual(["we standardised on pnpm workspaces"])
  })

  it("finishes when nothing older remains", async () => {
    await seedSession("s1", "p1", 100)
    await seedMessage("m1", "s1", "p1", 100)
    const run = await proposeWorkspaceBackfill("p1")
    await confirmWorkspaceBackfill(run.id)
    await tickWorkspaceBackfill("p1")
    expect(await tickWorkspaceBackfill("p1")).toEqual({ kind: "finished" })
    expect((await getProjectMiningRun(run.id))?.status).toBe("succeeded")
  })

  it("is a no-op for a workspace with no run", async () => {
    expect(await tickWorkspaceBackfill("p1")).toEqual({ kind: "idle" })
  })

  it("stops touching a workspace once its run is cancelled", async () => {
    await seedSession("s1", "p1", 100)
    await seedMessage("m1", "s1", "p1", 100)
    const run = await proposeWorkspaceBackfill("p1")
    await confirmWorkspaceBackfill(run.id)
    await cancelWorkspaceBackfill(run.id)
    expect(await tickWorkspaceBackfill("p1")).toEqual({ kind: "idle" })
  })
})

describe("cancelling", () => {
  it("withdraws the run's still-queued mining jobs by dedupe-key prefix", async () => {
    const db = getDb()
    await seedSession("s1", "p1", 100)
    const run = await proposeWorkspaceBackfill("p1")
    await db.memoryJobs.put({
      id: "j1",
      dedupeKey: `project-mining:${run.id}:s1:m1:m9:9`,
      kind: "project-mining",
      status: "queued",
      queuedAt: 1,
      retryCount: 0,
    } as never)
    // A live-mined window shares the kind but not the prefix, and must survive.
    await db.memoryJobs.put({
      id: "j2",
      dedupeKey: "project-mining:s1:m1:m9:9",
      kind: "project-mining",
      status: "queued",
      queuedAt: 1,
      retryCount: 0,
    } as never)
    const cancelled = await cancelWorkspaceBackfill(run.id)
    expect(cancelled).toBe(1)
    expect((await db.memoryJobs.get("j1"))?.status).toBe("cancelled")
    expect((await db.memoryJobs.get("j2"))?.status).toBe("queued")
  })

  it("fences an in-flight session scan so cancellation cannot leak late queued jobs (N14)", async () => {
    await seedSession("s1", "p1", 100)
    await getDb().messages.bulkPut([
      {
        id: "m1",
        sessionId: "s1",
        projectId: "p1",
        role: "user",
        createdAt: 100,
        parts: [{ type: "text", text: "why does pnpm build fail in packages/memory/src/index.ts" }],
      },
      {
        id: "m2",
        sessionId: "s1",
        projectId: "p1",
        role: "assistant",
        createdAt: 101,
        parts: [
          {
            type: "text",
            text: "it must be in SERVER_ONLY_PACKAGES, because the static export breaks otherwise",
          },
        ],
      },
    ] as never)
    const run = await proposeWorkspaceBackfill("p1")
    await confirmWorkspaceBackfill(run.id)

    const actualPrepare = jest.requireActual("@/lib/execution/personal-visibility")
      .preparePersonalHistory as typeof preparePersonalHistory
    let entered!: () => void
    let release!: () => void
    const paused = new Promise<void>((resolve) => {
      entered = resolve
    })
    jest.mocked(preparePersonalHistory).mockImplementationOnce(async (...args) => {
      entered()
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return actualPrepare(...args)
    })
    const ticking = tickWorkspaceBackfill("p1")
    await paused
    await cancelWorkspaceBackfill(run.id)
    release()
    await ticking

    expect((await getProjectMiningRun(run.id))?.status).toBe("cancelled")
    expect(await getDb().memoryJobs.count()).toBe(0)
  })
})

describe("prefix isolation, draining, and autonomous idle execution (N8, N15, N16)", () => {
  beforeEach(__resetMemoryDrainLock)

  it("isolates p1 from prefix-sharing p10 and preserves p1's own watermark cursor (N8)", async () => {
    await seedSession("s_p1_old", "p1", 100)
    await seedSession("s_p10_mid", "p10", 250)
    await seedSession("s_p1_new", "p1", 300)
    await seedSession("s_p0", "p0", 200)
    await seedMessage("m_p1_old", "s_p1_old", "p1", 100)
    await seedMessage("m_p10_mid", "s_p10_mid", "p10", 250)
    await seedMessage("m_p1_new", "s_p1_new", "p1", 300)

    const run = await proposeWorkspaceBackfill("p1")
    await confirmWorkspaceBackfill(run.id)
    jest.mocked(enqueueProjectMiningJobs).mockClear()

    const outcome = await tickWorkspaceBackfill("p1")
    expect(outcome).toMatchObject({ kind: "advanced", sessionsScanned: 2 })
    const queuedSessionIds = jest
      .mocked(enqueueProjectMiningJobs)
      .mock.calls.map(([arg]) => arg.sessionId)
    expect(queuedSessionIds).toEqual(["s_p1_new", "s_p1_old"])
    const after = await getProjectMiningRun(run.id)
    expect(after?.cursorSessionId).toBe("s_p1_old")
    expect(after?.cursorCreatedAt).toBe(100)
  })

  it("stays running while queued mining jobs drain and blocks duplicate proposals (N15)", async () => {
    await seedSession("s1", "p1", 100)
    await getDb().messages.bulkPut([
      {
        id: "m1",
        sessionId: "s1",
        projectId: "p1",
        role: "user",
        createdAt: 100,
        parts: [{ type: "text", text: "why does pnpm build fail in packages/memory/src/index.ts" }],
      },
      {
        id: "m2",
        sessionId: "s1",
        projectId: "p1",
        role: "assistant",
        createdAt: 101,
        parts: [
          {
            type: "text",
            text: "it must be in SERVER_ONLY_PACKAGES, because the static export breaks otherwise",
          },
        ],
      },
    ] as never)
    const run = await proposeWorkspaceBackfill("p1")
    await confirmWorkspaceBackfill(run.id)
    const first = await tickWorkspaceBackfill("p1")
    expect(first).toEqual({ kind: "advanced", sessionsScanned: 1, jobsEnqueued: 1 })

    const second = await tickWorkspaceBackfill("p1")
    expect(second).toEqual({ kind: "draining", pending: 1 })
    expect((await getProjectMiningRun(run.id))?.status).toBe("running")
    expect((await proposeWorkspaceBackfill("p1")).id).toBe(run.id)

    const [job] = await getDb().memoryJobs.toArray()
    await finishMemoryJob(job!.id, "succeeded", "claims_applied")

    const third = await tickWorkspaceBackfill("p1")
    expect(third).toEqual({ kind: "finished" })
    expect((await getProjectMiningRun(run.id))?.status).toBe("succeeded")
  })

  it("drives a confirmed backfill to completion on an idle worker without new chat turns (N16)", async () => {
    await getDb().settings.put({
      id: "app",
      memory: { enabled: true, learnFromChats: true, mineProjectContext: true },
    } as never)
    await seedSession("s1", "p1", 100)
    await getDb().messages.bulkPut([
      {
        id: "m1",
        sessionId: "s1",
        projectId: "p1",
        role: "user",
        createdAt: 100,
        parts: [{ type: "text", text: "why does pnpm build fail in packages/memory/src/index.ts" }],
      },
      {
        id: "m2",
        sessionId: "s1",
        projectId: "p1",
        role: "assistant",
        createdAt: 101,
        parts: [
          {
            type: "text",
            text: "it must be in SERVER_ONLY_PACKAGES, because the static export breaks otherwise",
          },
        ],
      },
    ] as never)

    const processedJobs: string[] = []
    const stop = startMemoryJobWorker({
      intervalMs: 60_000,
      repairNamespaces: false,
      driveBackfills: true,
      tickBackfills: tickActiveWorkspaceBackfills,
      deps: {
        claimNext: (worker) => claimNextMemoryJob(worker),
        finish: (id, outcome, worker, epoch) =>
          finishMemoryJob(id, outcome.status, outcome.resultCode, Date.now(), {
            workerId: worker,
            fencingEpoch: epoch,
          }),
        fail: async () => "failed",
        process: async (job) => {
          processedJobs.push(job.id)
          return { status: "succeeded", resultCode: "claims_applied" }
        },
      },
    })

    try {
      const run = await proposeWorkspaceBackfill("p1")
      await confirmWorkspaceBackfill(run.id)
      const deadline = Date.now() + 2_000
      while ((await getProjectMiningRun(run.id))?.status !== "succeeded" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 15))
      }
      expect(processedJobs).toHaveLength(1)
      expect((await getProjectMiningRun(run.id))?.status).toBe("succeeded")
    } finally {
      stop()
    }
  })
})
