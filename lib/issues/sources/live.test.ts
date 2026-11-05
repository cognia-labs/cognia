/**
 * @jest-environment jsdom
 */

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { createIssue, listIssues } from "@/lib/db/issues"
import { createIssueProject } from "@/lib/db/issue-projects"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { observeIssueList, type IssueListTrigger } from "./live"
import { toUnifiedIssue } from "./local-source"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const HUMAN = { kind: "human" } as const

let issueProjectId: string

beforeEach(async () => {
  issueProjectId = (await createIssueProject({ projectId: "w1", name: "Mercury", key: "MERC" })).id
})

function collector() {
  const batches: string[][] = []
  const errors: unknown[] = []
  return {
    batches,
    errors,
    observer: {
      next: (items: UnifiedIssueItem[]) => batches.push(items.map((item) => item.title)),
      error: (error: unknown) => errors.push(error),
    },
  }
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
}

const readLocal = async () => (await listIssues({ projectId: "w1" })).map(toUnifiedIssue)

describe("observeIssueList", () => {
  it("delivers the rows, then again after a write to a table the read touched", async () => {
    const seen = collector()
    const stop = observeIssueList(readLocal, seen.observer)
    await settle()
    expect(seen.batches).toEqual([[]])

    await createIssue({ projectId: "w1", issueProjectId, title: "First", createdBy: HUMAN })
    await settle()
    expect(seen.batches.at(-1)).toEqual(["First"])
    stop()
  })

  it("does not re-read for a write to a table the read never touched", async () => {
    const reads = jest.fn(readLocal)
    const stop = observeIssueList(reads, collector().observer)
    await settle()
    const before = reads.mock.calls.length
    await getDb().labels.put({
      id: "l1",
      kind: "issue",
      name: "bug",
      color: "#f00",
      createdAt: 1,
      updatedAt: 1,
    } as never)
    await settle()
    expect(reads.mock.calls.length).toBe(before)
    stop()
  })

  it("restarts the read once for a burst of trigger calls", async () => {
    let notify: () => void = () => {}
    const trigger: IssueListTrigger = (fire) => {
      notify = fire
      return () => {
        notify = () => {}
      }
    }
    let memory = ["a"]
    const reads = jest.fn(async (): Promise<UnifiedIssueItem[]> =>
      memory.map((title) => ({ title }) as unknown as UnifiedIssueItem)
    )
    const seen = collector()
    const stop = observeIssueList(reads, seen.observer, [trigger])
    await settle()
    const before = reads.mock.calls.length

    memory = ["a", "b"]
    notify()
    notify()
    notify()
    await settle()
    expect(reads.mock.calls.length).toBe(before + 1)
    expect(seen.batches.at(-1)).toEqual(["a", "b"])
    stop()
  })

  it("reports a failed read, and a trigger recovers it", async () => {
    let notify: () => void = () => {}
    const trigger: IssueListTrigger = (fire) => {
      notify = fire
      return () => {}
    }
    let fail = true
    const seen = collector()
    const stop = observeIssueList(
      async () => {
        if (fail) throw new Error("store not ready")
        return [{ title: "ok" } as unknown as UnifiedIssueItem]
      },
      seen.observer,
      [trigger]
    )
    await settle()
    expect(seen.errors).toHaveLength(1)

    fail = false
    notify()
    await settle()
    expect(seen.batches).toEqual([["ok"]])
    stop()
  })

  it("delivers nothing after it is stopped, and stops its triggers", async () => {
    const stopTrigger = jest.fn()
    const seen = collector()
    const stop = observeIssueList(readLocal, seen.observer, [() => stopTrigger])
    stop()
    stop()
    await createIssue({ projectId: "w1", issueProjectId, title: "Late", createdBy: HUMAN })
    await settle()
    expect(seen.batches).toEqual([])
    expect(stopTrigger).toHaveBeenCalledTimes(1)
  })
})
