import {
  acquireSessionTurnLease,
  beginSessionStop,
  sessionStopFenced,
  sessionStopPending,
  withSessionTurnLock,
} from "./session-turn-lock"
let mockDatabase = { name: "turn-lock-test" }
jest.mock("@/lib/db/schema", () => ({ getDb: () => mockDatabase }))

it("refuses a desktop lease during a headless turn and queues the next full turn", async () => {
  const first = await acquireSessionTurnLease("session")
  expect(await acquireSessionTurnLease("session", true)).toBeNull()
  let started = false
  const next = withSessionTurnLock("session", async () => {
    started = true
  })
  await Promise.resolve()
  expect(started).toBe(false)
  first!()
  await next
  expect(started).toBe(true)
  const last = await acquireSessionTurnLease("session", true)
  expect(last).toEqual(expect.any(Function))
  last!()
})

it("releases full-turn admission on failure without poisoning other sessions", async () => {
  await expect(
    withSessionTurnLock("failed", async () => {
      throw new Error("failed")
    })
  ).rejects.toThrow("failed")
  const release = await acquireSessionTurnLease("failed", true)
  expect(release).not.toBeNull()
  const other = await acquireSessionTurnLease("other", true)
  expect(other).not.toBeNull()
  release!()
  other!()
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

it("fences every producer while a stop is pending, even when the lock was free", async () => {
  const release = beginSessionStop("stopped")
  expect(sessionStopPending("stopped")).toBe(true)
  expect(await acquireSessionTurnLease("stopped", true)).toBeNull()
  let started = false
  const queued = withSessionTurnLock("stopped", async () => {
    started = true
  })
  await settle()
  expect(started).toBe(false)
  release()
  release()
  await queued
  expect(started).toBe(true)
  expect(sessionStopPending("stopped")).toBe(false)
})

it("keeps a queued turn behind a stop that began while another turn held the lock", async () => {
  const running = await acquireSessionTurnLease("busy-stop")
  const release = beginSessionStop("busy-stop")
  let started = false
  const queued = withSessionTurnLock("busy-stop", async () => {
    started = true
  })
  await running!()
  await settle()
  expect(started).toBe(false)
  release()
  await queued
  expect(started).toBe(true)
})

it("holds the fence until every overlapping stop has settled", async () => {
  const first = beginSessionStop("overlap")
  const second = beginSessionStop("overlap")
  first()
  expect(sessionStopPending("overlap")).toBe(true)
  expect(await acquireSessionTurnLease("overlap", true)).toBeNull()
  second()
  expect(sessionStopPending("overlap")).toBe(false)
  const lease = await acquireSessionTurnLease("overlap", true)
  expect(lease).not.toBeNull()
  await lease!()
})

it("fences admission for a stop held by another window through the shared stop lock", async () => {
  let releaseForeign!: () => void
  const foreign = navigator.locks.request(
    "cognia:agent-turn:turn-lock-test:session:foreign:stop",
    { mode: "shared" },
    () =>
      new Promise<void>((resolve) => {
        releaseForeign = resolve
      })
  )
  await settle()
  expect(await acquireSessionTurnLease("foreign", true)).toBeNull()
  let started = false
  const queued = withSessionTurnLock("foreign", async () => {
    started = true
  })
  await settle()
  expect(started).toBe(false)
  releaseForeign()
  await foreign
  await queued
  expect(started).toBe(true)
})

const foreignStop = (sessionId: string) => {
  let release!: () => void
  const held = navigator.locks.request(
    `cognia:agent-turn:turn-lock-test:session:${sessionId}:stop`,
    { mode: "shared" },
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  return async () => {
    await settle()
    release()
    await held
  }
}

it("keeps a queued turn behind a second stop requested while it waited at the barrier", async () => {
  const first = foreignStop("cross-overlap")
  await settle()
  expect(await sessionStopFenced("cross-overlap")).toBe(true)
  let started = false
  const queued = withSessionTurnLock("cross-overlap", async () => {
    started = true
  })
  await settle()
  // Requested after the queued turn's exclusive barrier.
  const second = foreignStop("cross-overlap")
  await settle()
  await first()
  await settle()
  expect(started).toBe(false)
  await second()
  await queued
  expect(started).toBe(true)
  expect(await sessionStopFenced("cross-overlap")).toBe(false)
})

it("refuses a queued turn whose database changed while it waited for a stop", async () => {
  const release = beginSessionStop("switched")
  const queued = withSessionTurnLock("switched", async () => "ran")
  await settle()
  const original = mockDatabase
  mockDatabase = { name: "turn-lock-test" }
  try {
    release()
    await expect(queued).rejects.toThrow("Session turn database changed while waiting")
  } finally {
    mockDatabase = original
  }
  const lease = await acquireSessionTurnLease("switched", true)
  expect(lease).not.toBeNull()
  await lease!()
})

it("refuses the lease when a stop begins while the stop barrier is being granted", async () => {
  const request = navigator.locks.request.bind(navigator.locks) as (...args: unknown[]) => unknown
  let release: (() => void) | undefined
  const spy = jest.spyOn(navigator.locks, "request").mockImplementation(((...args: unknown[]) => {
    const [name, options] = args as [string, LockOptions]
    if (!release && name.endsWith(":stop") && options.mode === "exclusive")
      release = beginSessionStop("late-stop")
    return request(...args)
  }) as typeof navigator.locks.request)
  try {
    expect(await acquireSessionTurnLease("late-stop", true)).toBeNull()
    expect(release).toEqual(expect.any(Function))
  } finally {
    spy.mockRestore()
    release?.()
  }
  await settle()
  const lease = await acquireSessionTurnLease("late-stop", true)
  expect(lease).not.toBeNull()
  await lease!()
})

it("fences the next admission for a foreign stop that queued while a lease held the barrier", async () => {
  const lease = await acquireSessionTurnLease("queued-stop", true)
  expect(lease).not.toBeNull()
  // Requested during the turn: it waits behind the lease's exclusive barrier.
  const foreign = foreignStop("queued-stop")
  await settle()
  await lease!()
  await settle()
  expect(await acquireSessionTurnLease("queued-stop", true)).toBeNull()
  let started = false
  const queued = withSessionTurnLock("queued-stop", async () => {
    started = true
  })
  await settle()
  expect(started).toBe(false)
  await foreign()
  await queued
  expect(started).toBe(true)
})

it("holds the stop barrier exclusively for the lease's whole lifetime", async () => {
  const lease = await acquireSessionTurnLease("barrier-held", true)
  const probe = () =>
    navigator.locks.request(
      "cognia:agent-turn:turn-lock-test:session:barrier-held:stop",
      { mode: "shared", ifAvailable: true },
      async (lock) => lock !== null
    )
  // A Stop from any window can only queue behind the running turn.
  expect(await probe()).toBe(false)
  await lease!()
  await settle()
  expect(await probe()).toBe(true)
})
