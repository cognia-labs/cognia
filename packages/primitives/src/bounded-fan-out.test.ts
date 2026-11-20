import { boundedFanOut } from "./bounded-fan-out"
import { TimeoutError } from "./with-timeout"

/** A task the test settles by hand, recording the signal it was given. */
function gate() {
  let resolve!: (value: string) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<string>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("boundedFanOut", () => {
  it("keeps every outcome in item order", async () => {
    const outcomes = await boundedFanOut(
      [30, 10, 20],
      (ms) => new Promise<number>((resolve) => setTimeout(() => resolve(ms), ms)),
      { concurrency: 3 }
    )
    expect(outcomes).toEqual([
      { status: "fulfilled", value: 30 },
      { status: "fulfilled", value: 10 },
      { status: "fulfilled", value: 20 },
    ])
  })

  it("aborts a task at its deadline and holds its slot until it stops", async () => {
    let active = 0
    let peak = 0
    const outcomes = await boundedFanOut(
      [0, 1],
      (index, _i, signal) =>
        new Promise<number>((resolve, reject) => {
          active += 1
          peak = Math.max(peak, active)
          const finish = () => {
            active -= 1
            if (signal.aborted) reject(signal.reason)
            else resolve(index)
          }
          if (index === 0) signal.addEventListener("abort", () => setTimeout(finish, 15))
          else setTimeout(finish, 1)
        }),
      { concurrency: 1, timeoutMs: 10, timeoutLabel: "sample" }
    )
    expect(peak).toBe(1)
    expect(outcomes[0]).toMatchObject({ status: "rejected", timedOut: true, stopped: true })
    expect((outcomes[0] as { error: unknown }).error).toBeInstanceOf(TimeoutError)
    expect(outcomes[1]).toEqual({ status: "fulfilled", value: 1 })
  })

  it("gives the slot back after the grace and records an unconfirmed stop", async () => {
    const stuck = gate()
    let secondStartedWhileStuck = false
    let stuckSettled = false
    void stuck.promise.finally(() => {
      stuckSettled = true
    })
    try {
      const outcomes = await boundedFanOut(
        [0, 1],
        async (index) => {
          if (index === 0) return stuck.promise
          secondStartedWhileStuck = !stuckSettled
          return "second"
        },
        { concurrency: 1, timeoutMs: 5, stopGraceMs: 10 }
      )
      expect(outcomes[0]).toMatchObject({ status: "rejected", timedOut: true, stopped: false })
      expect(outcomes[1]).toEqual({ status: "fulfilled", value: "second" })
      expect(secondStartedWhileStuck).toBe(true)
    } finally {
      stuck.resolve("late")
    }
  })

  it("reports a task that answers after its deadline as failed", async () => {
    const outcomes = await boundedFanOut(
      ["slow"],
      (_item, _i, signal) =>
        new Promise<string>((resolve) =>
          signal.addEventListener("abort", () => resolve("answer after the deadline"))
        ),
      { concurrency: 1, timeoutMs: 5 }
    )
    expect(outcomes[0]).toMatchObject({ status: "rejected", timedOut: true, stopped: true })
  })

  it("stops running tasks and never starts waiting ones when the caller aborts", async () => {
    const controller = new AbortController()
    const started: number[] = []
    const outcomes = await boundedFanOut(
      [0, 1, 2],
      (index, _i, signal) =>
        new Promise<number>((resolve, reject) => {
          started.push(index)
          if (index === 0) controller.abort(new Error("stop the run"))
          if (signal.aborted) reject(signal.reason)
          else signal.addEventListener("abort", () => reject(signal.reason))
          void resolve
        }),
      { concurrency: 1, signal: controller.signal }
    )
    expect(started).toEqual([0])
    expect(outcomes[0]).toMatchObject({ status: "rejected", timedOut: false, stopped: true })
    expect(outcomes.slice(1)).toEqual([{ status: "skipped" }, { status: "skipped" }])
  })

  it("passes a rejection through as a stopped failure", async () => {
    const failure = new Error("provider 500")
    const outcomes = await boundedFanOut([0], async () => Promise.reject(failure), {
      concurrency: 2,
    })
    expect(outcomes).toEqual([
      { status: "rejected", error: failure, timedOut: false, stopped: true },
    ])
  })
})
