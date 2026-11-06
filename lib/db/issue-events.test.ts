/**
 * @jest-environment jsdom
 */

import { onIssueEvent } from "@/lib/issues/event-bus"
import type { IssueEvent } from "@/types/issues"
import { createDbTestFixture } from "./test-fixture"
import { getDb } from "./schema"
import {
  __resetIssueEventClockForTesting,
  appendIssueEvent,
  deleteIssueEvents,
  deleteIssueEventsForIssues,
  listIssueComments,
  listIssueEvents,
} from "./issue-events"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
beforeEach(__resetIssueEventClockForTesting)
afterAll(dbFixture.dispose)

const HUMAN = { kind: "human" } as const

describe("appendIssueEvent", () => {
  it("derives `kind` from the payload so the index cannot disagree with it", async () => {
    const event = await appendIssueEvent({
      issueId: "i1",
      payload: { kind: "status_changed", from: "todo", to: "done", by: HUMAN },
    })
    expect(event.kind).toBe("status_changed")
    expect(event.payload.kind).toBe("status_changed")
  })

  it("stamps a unique id and a timestamp", async () => {
    const a = await appendIssueEvent({ issueId: "i1", payload: { kind: "created", by: HUMAN } })
    const b = await appendIssueEvent({ issueId: "i1", payload: { kind: "created", by: HUMAN } })
    expect(a.id).not.toBe(b.id)
    expect(a.ts).toBeGreaterThan(0)
  })

  it("honours an injected timestamp", async () => {
    const event = await appendIssueEvent({
      issueId: "i1",
      payload: { kind: "created", by: HUMAN },
      ts: 42,
    })
    expect(event.ts).toBe(42)
  })
})

/** Sequential appends, the way a multi-field edit writes them. */
async function appendIssueEvents(inputs: Parameters<typeof appendIssueEvent>[0][]) {
  const events: IssueEvent[] = []
  for (const input of inputs) events.push(await appendIssueEvent(input))
  return events
}

describe("appendIssueEvent timestamps", () => {
  it("assigns strictly increasing timestamps so one logical edit keeps a stable order", async () => {
    // Millisecond wall-clock resolution is not enough: equal `ts` values make
    // the [issueId+ts] index fall back to random-UUID primary-key order, which
    // shuffled the activity timeline.
    const events = await appendIssueEvents([
      { issueId: "i1", payload: { kind: "title_changed", from: "a", to: "b", by: HUMAN } },
      { issueId: "i1", payload: { kind: "description_changed", by: HUMAN } },
    ])
    expect(events[1].ts).toBeGreaterThan(events[0].ts)

    const listed = await listIssueEvents({ issueId: "i1" })
    expect(listed.map((e) => e.kind)).toEqual(["title_changed", "description_changed"])
  })
})

describe("publishing to the bus", () => {
  function collect() {
    const seen: IssueEvent[] = []
    const off = onIssueEvent((event) => seen.push(event))
    return { seen, off }
  }

  it("publishes a stand-alone append as soon as it is written", async () => {
    const { seen, off } = collect()
    const event = await appendIssueEvent({ issueId: "i1", payload: { kind: "created", by: HUMAN } })
    off()
    expect(seen.map((e) => e.id)).toEqual([event.id])
  })

  it("holds entries written inside a transaction until it commits, in order", async () => {
    const { seen, off } = collect()
    const db = getDb()
    let insideCount = -1
    await db.transaction("rw", db.issueEvents, async () => {
      await appendIssueEvent({ issueId: "i1", payload: { kind: "created", by: HUMAN } })
      await appendIssueEvents([
        { issueId: "i1", payload: { kind: "title_changed", from: "a", to: "b", by: HUMAN } },
        { issueId: "i1", payload: { kind: "description_changed", by: HUMAN } },
      ])
      insideCount = seen.length
    })
    off()
    expect(insideCount).toBe(0)
    expect(seen.map((e) => e.kind)).toEqual(["created", "title_changed", "description_changed"])
  })

  it("waits for the root transaction, not a nested one", async () => {
    const { seen, off } = collect()
    const db = getDb()
    let afterNested = -1
    await db.transaction("rw", db.issueEvents, db.issues, async () => {
      await db.transaction("rw", db.issueEvents, async () => {
        await appendIssueEvent({ issueId: "i1", payload: { kind: "created", by: HUMAN } })
      })
      afterNested = seen.length
    })
    off()
    expect(afterNested).toBe(0)
    expect(seen).toHaveLength(1)
  })

  it("never publishes entries from a transaction that aborts", async () => {
    const { seen, off } = collect()
    const db = getDb()
    await expect(
      db.transaction("rw", db.issueEvents, async () => {
        await appendIssueEvent({ issueId: "i1", payload: { kind: "created", by: HUMAN } })
        throw new Error("abort")
      })
    ).rejects.toThrow("abort")
    // Give a late `complete` every chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 20))
    off()
    expect(seen).toEqual([])
    expect(await listIssueEvents({ issueId: "i1" })).toEqual([])
  })

  it("lets a handler read other tables, because it runs outside the writer's zone", async () => {
    const db = getDb()
    const reads: Array<number | string> = []
    const off = onIssueEvent(() => {
      // `issueRuns` is not in the writer's scope: inside its zone this read
      // would fail as "not part of transaction".
      void db.issueRuns
        .count()
        .then((count) => reads.push(count))
        .catch((error: unknown) => reads.push(String(error)))
    })
    await db.transaction("rw", db.issueEvents, async () => {
      await appendIssueEvent({ issueId: "i1", payload: { kind: "created", by: HUMAN } })
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    off()
    expect(reads).toEqual([0])
  })
})

describe("listIssueEvents", () => {
  beforeEach(async () => {
    await appendIssueEvents([
      { issueId: "i1", payload: { kind: "created", by: HUMAN }, ts: 1 },
      {
        issueId: "i1",
        payload: { kind: "commented", commentId: "c1", body: "x", by: HUMAN },
        ts: 2,
      },
      { issueId: "i1", payload: { kind: "description_changed", by: HUMAN }, ts: 3 },
      { issueId: "i2", payload: { kind: "created", by: HUMAN }, ts: 1 },
    ])
  })

  it("returns one issue's trail oldest-first", async () => {
    expect((await listIssueEvents({ issueId: "i1" })).map((e) => e.ts)).toEqual([1, 2, 3])
  })

  it("reverses on request, for the newest-first detail panel", async () => {
    expect((await listIssueEvents({ issueId: "i1", descending: true })).map((e) => e.ts)).toEqual([
      3, 2, 1,
    ])
  })

  it("applies a limit after ordering", async () => {
    expect(
      (await listIssueEvents({ issueId: "i1", descending: true, limit: 2 })).map((e) => e.ts)
    ).toEqual([3, 2])
  })

  it("never leaks another issue's events", async () => {
    expect(await listIssueEvents({ issueId: "i2" })).toHaveLength(1)
    expect(await listIssueEvents({ issueId: "missing" })).toEqual([])
  })
})

describe("listIssueComments", () => {
  it("returns only comment entries, oldest first", async () => {
    await appendIssueEvents([
      { issueId: "i1", payload: { kind: "created", by: HUMAN }, ts: 1 },
      {
        issueId: "i1",
        payload: { kind: "commented", commentId: "c1", body: "one", by: HUMAN },
        ts: 2,
      },
      {
        issueId: "i1",
        payload: { kind: "commented", commentId: "c2", body: "two", by: HUMAN },
        ts: 3,
      },
    ])
    const comments = await listIssueComments("i1")
    expect(comments.map((c) => (c.payload as { body: string }).body)).toEqual(["one", "two"])
  })

  it("is empty when the issue has only activity", async () => {
    await appendIssueEvent({ issueId: "i1", payload: { kind: "created", by: HUMAN } })
    expect(await listIssueComments("i1")).toEqual([])
  })
})

describe("cascade deletion", () => {
  beforeEach(async () => {
    await appendIssueEvents([
      { issueId: "i1", payload: { kind: "created", by: HUMAN } },
      { issueId: "i2", payload: { kind: "created", by: HUMAN } },
      { issueId: "i3", payload: { kind: "created", by: HUMAN } },
    ])
  })

  it("deletes one issue's trail and leaves the rest", async () => {
    await deleteIssueEvents("i1")
    expect(await listIssueEvents({ issueId: "i1" })).toEqual([])
    expect(await listIssueEvents({ issueId: "i2" })).toHaveLength(1)
  })

  it("deletes several issues' trails at once", async () => {
    await deleteIssueEventsForIssues(["i1", "i2"])
    expect(await listIssueEvents({ issueId: "i1" })).toEqual([])
    expect(await listIssueEvents({ issueId: "i2" })).toEqual([])
    expect(await listIssueEvents({ issueId: "i3" })).toHaveLength(1)
  })

  it("is a no-op for an empty id list", async () => {
    await deleteIssueEventsForIssues([])
    expect(await listIssueEvents({ issueId: "i1" })).toHaveLength(1)
  })
})
