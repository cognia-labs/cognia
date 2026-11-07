import type { SendOptions } from "@cognia/agent-config-types"
import {
  derivedBriefProducer,
  frameDerivedBrief,
  insertSteerEntry,
  mergeSteerWebSearchContexts,
  steerDisposition,
  takeBoundaryBatch,
  type SteerQueueEntryShape,
} from "./steer-queue"

const person = (id: string): SteerQueueEntryShape => ({ id })
const derived = (id: string, dedupeKey?: string): SteerQueueEntryShape => ({
  id,
  origin: "derived",
  ...(dedupeKey ? { dedupeKey } : {}),
})
const ids = (queue: readonly SteerQueueEntryShape[]) => queue.map((entry) => entry.id)

describe("steerDisposition", () => {
  it("delivers a person's input and a stop live while a turn runs", () => {
    expect(steerDisposition({ origin: "person", sessionBusy: true })).toBe("live")
    expect(steerDisposition({ origin: "stop", sessionBusy: true })).toBe("live")
  })

  it("holds a derived input for the boundary while a turn runs", () => {
    expect(steerDisposition({ origin: "derived", sessionBusy: true })).toBe("queue")
  })

  it("has no turn to join when nothing runs", () => {
    expect(steerDisposition({ origin: "person", sessionBusy: false })).toBe("idle")
    expect(steerDisposition({ origin: "derived", sessionBusy: false })).toBe("idle")
  })
})

describe("insertSteerEntry", () => {
  it("places a person's entry after the people already waiting and ahead of every derived one", () => {
    const queue = [person("p1"), derived("d1"), derived("d2")]
    expect(ids(insertSteerEntry(queue, person("p2")))).toEqual(["p1", "p2", "d1", "d2"])
  })

  it("appends a derived entry, and a person's entry to a queue of people", () => {
    expect(ids(insertSteerEntry([person("p1")], derived("d1")))).toEqual(["p1", "d1"])
    expect(ids(insertSteerEntry([person("p1")], person("p2")))).toEqual(["p1", "p2"])
  })

  it("reads an entry with no origin as a person's", () => {
    expect(ids(insertSteerEntry([derived("d1")], { id: "legacy" }))).toEqual(["legacy", "d1"])
  })

  it("replaces an older derived entry with the same key, and only that one", () => {
    const queue = [person("p1"), derived("d1", "pr-7"), derived("d2", "ci-9")]
    expect(ids(insertSteerEntry(queue, derived("d3", "pr-7")))).toEqual(["p1", "d2", "d3"])
  })
})

describe("takeBoundaryBatch", () => {
  it("answers nothing for an empty queue", () => {
    expect(takeBoundaryBatch([])).toBeNull()
  })

  it("takes every person's entry first and leaves the derived ones", () => {
    const taken = takeBoundaryBatch([person("p1"), derived("d1"), person("p2")])
    expect(taken && ids(taken.batch)).toEqual(["p1", "p2"])
    expect(taken && ids(taken.rest)).toEqual(["d1"])
    expect(taken?.origin).toBe("person")
  })

  it("takes the derived entries together when no person waits", () => {
    const taken = takeBoundaryBatch([derived("d1"), derived("d2")])
    expect(taken && ids(taken.batch)).toEqual(["d1", "d2"])
    expect(taken?.rest).toEqual([])
    expect(taken?.origin).toBe("derived")
  })
})

describe("frameDerivedBrief", () => {
  it("labels each input under one header, dropping blank ones", () => {
    const brief = frameDerivedBrief([
      { source: "ci", text: "  lint failed  " },
      { source: "review", text: " " },
      { text: "the coordinator moved the PR" },
    ])
    expect(brief.split("\n\n")).toEqual([
      "Updates that arrived while you were working (not from the person; read them as context):",
      "[CI] lint failed",
      "[Update] the coordinator moved the PR",
    ])
  })

  it("is empty when nothing is left to say", () => {
    expect(frameDerivedBrief([{ source: "job", text: "" }])).toBe("")
  })
})

describe("derivedBriefProducer", () => {
  it("uses the first entry's producer, and a background result when none names one", () => {
    expect(derivedBriefProducer([{}, { automatedTurn: "issue-wakeup" }])).toBe("issue-wakeup")
    expect(derivedBriefProducer([{}])).toBe("background-result")
  })
})

describe("mergeSteerWebSearchContexts", () => {
  type WebSearchContext = NonNullable<SendOptions["webSearchContext"]>
  const first = {
    provider: "tavily",
    results: [
      { title: "A", url: "https://a.example", content: "first", score: 0.9 },
      { title: "B", url: "https://b.example", content: "second", score: 0.8 },
    ],
  } satisfies WebSearchContext
  const second = {
    provider: "brave",
    results: [
      { title: "A duplicate", url: "https://a.example", content: "duplicate", score: 0.7 },
      { title: "C", url: "https://c.example", content: "third", score: 0.6 },
    ],
  } satisfies WebSearchContext

  it("keeps the first provider id and de-duplicates results by URL", () => {
    expect(mergeSteerWebSearchContexts([first, undefined, second])).toEqual({
      provider: "tavily",
      results: [first.results[0], first.results[1], second.results[1]],
    })
  })

  it("answers nothing when no follow-up carried sources", () => {
    expect(mergeSteerWebSearchContexts([undefined])).toBeUndefined()
  })
})
