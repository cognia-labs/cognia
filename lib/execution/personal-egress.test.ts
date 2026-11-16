/** @jest-environment jsdom */
jest.mock("@/lib/db/schema", () => {
  const actual = jest.requireActual<typeof import("@/lib/db/schema")>("@/lib/db/schema")
  return { ...actual, getDb: jest.fn(actual.getDb) }
})
jest.mock("./personal-sink", () => {
  const actual = jest.requireActual<typeof import("./personal-sink")>("./personal-sink")
  return { ...actual, readRunPersonalTaint: jest.fn(actual.readRunPersonalTaint) }
})
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { LOCAL_PERSON_RUN, startToolExecutionRun } from "./acting-authority"
import { addPersonalMarksToRun } from "./personal-marks"
import {
  assertPersonalEgress,
  bindPersonalEgressSession,
  trackPersonalEgressProcess,
} from "./personal-egress"
import { personalEgressToolDenied } from "@cognia/plugin-contract/types/execution/personal-egress"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)
const mark = { person: { kind: "local-person" as const }, source: "test", markedAt: 1 }

it("checks live taint per call and keeps search available", async () => {
  const run = await startToolExecutionRun("egress", { localAuthorization: LOCAL_PERSON_RUN })
  const context = { executionRunId: run.id }
  await expect(assertPersonalEgress(context)).resolves.toBeUndefined()
  await addPersonalMarksToRun(context, [mark])
  await expect(assertPersonalEgress(context)).rejects.toMatchObject({
    code: "personal-egress-denied",
  })
  await expect(assertPersonalEgress({ executionRunId: "missing" })).rejects.toThrow()
  for (const name of ["Bash", "WebFetch", "mcp__third__read", "start_process"])
    expect(personalEgressToolDenied(name, true)).toBe(true)
  expect(
    personalEgressToolDenied("WebSearch", true, [], {
      kind: "native",
      registeredTools: ["WebSearch"],
    })
  ).toBe(false)
  expect(personalEgressToolDenied("Bash", false)).toBe(false)
})

it("waits for every affected session's fence before releasing marked output", async () => {
  const root = await startToolExecutionRun("egress-root", { localAuthorization: LOCAL_PERSON_RUN })
  const child = await startToolExecutionRun("egress-child", { parentRunId: root.id })
  let acknowledge!: () => void
  const ack = new Promise<void>((resolve) => {
    acknowledge = resolve
  })
  const entered = jest.fn(() => ack)
  const release = bindPersonalEgressSession({ executionRunId: child.id }, entered)
  let returned = false
  const pending = addPersonalMarksToRun({ executionRunId: root.id }, [mark]).then(() => {
    returned = true
  })
  try {
    while (!entered.mock.calls.length) await new Promise((resolve) => setTimeout(resolve, 0))
    expect(returned).toBe(false)
    expect((await getDb().executionRuns.get(root.id))?.personalMarks).toEqual([mark])
    acknowledge()
    await pending
    expect(returned).toBe(true)
  } finally {
    acknowledge()
    release()
  }
})

it("withholds marking output on fence failure and on unfenceable engines", async () => {
  const run = await startToolExecutionRun("egress-failure", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const context = { executionRunId: run.id }
  const release = bindPersonalEgressSession(context, async () => {
    throw new Error("fence unavailable")
  })
  try {
    await expect(addPersonalMarksToRun(context, [mark])).rejects.toThrow("fence unavailable")
  } finally {
    release()
  }
  const external = bindPersonalEgressSession(context)
  try {
    await expect(addPersonalMarksToRun(context, [mark])).rejects.toMatchObject({
      code: "personal-egress-denied",
    })
  } finally {
    external()
  }
})

it("G2: no run id is background-compatible, while an identified unreadable run fails closed", async () => {
  await expect(assertPersonalEgress({})).resolves.toBeUndefined()
  await expect(
    assertPersonalEgress({ unverifiedReason: "legacy external call" })
  ).resolves.toBeUndefined()
  await expect(assertPersonalEgress({ executionRunId: "missing-id" })).rejects.toMatchObject({
    code: "personal-egress-denied",
  })
})

it("G3: mark release waits for an already running Host egress operation", async () => {
  const { runPersonalEgressOperation } = await import("./personal-egress")
  const run = await startToolExecutionRun("in-flight", { localAuthorization: LOCAL_PERSON_RUN })
  let finish: (() => void) | undefined
  const active = runPersonalEgressOperation(
    { executionRunId: run.id },
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  while (!finish) await new Promise((resolve) => setTimeout(resolve, 0))
  let admitted = false
  const marking = addPersonalMarksToRun({ executionRunId: run.id }, [mark]).then(() => {
    admitted = true
  })
  while (!(await getDb().executionRuns.get(run.id))?.personalMarks?.length)
    await new Promise((resolve) => setTimeout(resolve, 0))
  expect(admitted).toBe(false)
  finish?.()
  await active
  await marking
  expect(admitted).toBe(true)
})

it("G3: timeout withholds admission and unrelated clean work remains allowed", async () => {
  const { runPersonalEgressOperation } = await import("./personal-egress")
  const run = await startToolExecutionRun("stalled", { localAuthorization: LOCAL_PERSON_RUN })
  const unrelated = await startToolExecutionRun("unrelated", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  let finish: (() => void) | undefined
  const active = runPersonalEgressOperation(
    { executionRunId: run.id },
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  while (!finish) await new Promise((resolve) => setTimeout(resolve, 0))
  try {
    await expect(addPersonalMarksToRun({ executionRunId: run.id }, [mark])).rejects.toMatchObject({
      code: "personal-egress-denied",
    })
    await expect(assertPersonalEgress({ executionRunId: unrelated.id })).resolves.toBeUndefined()
  } finally {
    finish?.()
    await active
  }
})

it("H3: a marking operation does not wait on itself but waits for a sibling", async () => {
  const { runPersonalEgressOperation } = await import("./personal-egress")
  const run = await startToolExecutionRun("self-mark", { localAuthorization: LOCAL_PERSON_RUN })
  let release!: () => void
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const sibling = runPersonalEgressOperation({ executionRunId: run.id }, async () => {
    started()
    await new Promise<void>((resolve) => {
      release = resolve
    })
  })
  await ready
  let returned = false
  const self = runPersonalEgressOperation({ executionRunId: run.id }, async (own) => {
    await addPersonalMarksToRun(own, [mark])
    returned = true
  })
  while (!(await getDb().executionRuns.get(run.id))?.personalMarks?.length)
    await new Promise((resolve) => setTimeout(resolve, 0))
  expect(returned).toBe(false)
  release()
  await sibling
  await self
  expect(returned).toBe(true)
})

it("H3: its own child stream can commit marks without waiting on itself", async () => {
  const { runPersonalEgressOperation } = await import("./personal-egress")
  const run = await startToolExecutionRun("self-stream", { localAuthorization: LOCAL_PERSON_RUN })
  const stream = await runPersonalEgressOperation({ executionRunId: run.id }, async (own) =>
    (async function* () {
      await addPersonalMarksToRun(own, [mark])
      yield "private result"
    })()
  )
  expect(await stream.next()).toEqual({ done: false, value: "private result" })
  await stream.return(undefined)
})

it("H3: committed run deletion removes unproven process state", async () => {
  const { runPersonalEgressOperation } = await import("./personal-egress")
  const old = await startToolExecutionRun("deleted-process", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  await runPersonalEgressOperation({ executionRunId: old.id }, async () => undefined, true)
  const releaseProcess = trackPersonalEgressProcess(
    { executionRunId: old.id },
    "background-old",
    () => true
  )
  await expect(addPersonalMarksToRun({ executionRunId: old.id }, [mark])).rejects.toMatchObject({
    code: "personal-egress-denied",
  })
  releaseProcess()
  await getDb().executionRuns.delete(old.id)
  const next = await startToolExecutionRun("after-delete", { localAuthorization: LOCAL_PERSON_RUN })
  await expect(addPersonalMarksToRun({ executionRunId: next.id }, [mark])).resolves.toBeUndefined()
})

it("H3: an account switch clears the previous account's unproven process state", async () => {
  const { runPersonalEgressOperation, personalEgressCachedFenced } =
    await import("./personal-egress")
  const schema = await import("@/lib/db/schema")
  const old = await startToolExecutionRun("old-account-process", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  await runPersonalEgressOperation({ executionRunId: old.id }, async () => undefined, true)
  const releaseProcess = trackPersonalEgressProcess(
    { executionRunId: old.id },
    "background-old",
    () => true
  )
  try {
    schema.activateAccountDatabase("h3-other-account")
    expect(personalEgressCachedFenced({ executionRunId: "absent" })).toBe(true)
  } finally {
    releaseProcess()
    schema.clearAccountDatabaseSelection()
  }
  const next = await startToolExecutionRun("after-account-switch", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  await expect(addPersonalMarksToRun({ executionRunId: next.id }, [mark])).resolves.toBeUndefined()
})

it("H4: a mark invalidates the synchronous descendant cache", async () => {
  const { personalEgressCachedFenced } = await import("./personal-egress")
  const root = await startToolExecutionRun("cache-root", { localAuthorization: LOCAL_PERSON_RUN })
  const child = await startToolExecutionRun("cache-child", { parentRunId: root.id })
  expect(personalEgressCachedFenced({ executionRunId: child.id })).toBe(false)
  await addPersonalMarksToRun({ executionRunId: root.id }, [mark])
  expect(personalEgressCachedFenced({ executionRunId: child.id })).toBe(true)
})

it("H3: own child streams are excluded, and a throwing iterator releases its lifetime", async () => {
  const { runPersonalEgressOperation } = await import("./personal-egress")
  const run = await startToolExecutionRun("own-child-stream", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  await runPersonalEgressOperation({ executionRunId: run.id }, async (own) => {
    const child = await runPersonalEgressOperation(own, async (streamContext) =>
      (async function* () {
        await addPersonalMarksToRun(streamContext, [mark])
        yield "own stream"
      })()
    )
    expect(await child.next()).toEqual({ done: false, value: "own stream" })
    await child.return(undefined)
  })
  const other = await startToolExecutionRun("throwing-stream", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const iterator = await runPersonalEgressOperation({ executionRunId: other.id }, async () => ({
    [Symbol.iterator]() {
      return this
    },
    next(): IteratorResult<never> {
      throw new Error("iterator failed")
    },
  }))
  expect(() => iterator.next()).toThrow("iterator failed")
  await expect(addPersonalMarksToRun({ executionRunId: other.id }, [mark])).resolves.toBeUndefined()
})

it("H4: unrelated run creation, marking and deletion preserve a clear boundary snapshot", async () => {
  const { personalEgressCachedFenced } = await import("./personal-egress")
  const clear = await startToolExecutionRun("cache-clear", { localAuthorization: LOCAL_PERSON_RUN })
  const unrelated = await startToolExecutionRun("cache-unrelated", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  expect(personalEgressCachedFenced({ executionRunId: clear.id })).toBe(false)
  await addPersonalMarksToRun({ executionRunId: unrelated.id }, [mark])
  expect(personalEgressCachedFenced({ executionRunId: clear.id })).toBe(false)
  await getDb().executionRuns.delete(unrelated.id)
  expect(personalEgressCachedFenced({ executionRunId: clear.id })).toBe(false)
})

it("H3: an independent descendant stream still blocks a marking operation", async () => {
  const { runPersonalEgressOperation } = await import("./personal-egress")
  const run = await startToolExecutionRun("sibling-stream", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  await runPersonalEgressOperation({ executionRunId: run.id }, async (own) => {
    const sibling = await runPersonalEgressOperation(own, async () =>
      (async function* () {
        yield "still live"
      })()
    )
    let released = false
    const admission = addPersonalMarksToRun(own, [mark]).then(() => {
      released = true
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(released).toBe(false)
    await sibling.return(undefined)
    await admission
    expect(released).toBe(true)
  })
})

it("H4: unrelated writes during the canonical read do not fence a clear run", async () => {
  const sink = await import("./personal-sink")
  const { personalEgressFenced } = await import("./personal-egress")
  const clear = await startToolExecutionRun("read-race-clear", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const original =
    jest.requireActual<typeof import("./personal-sink")>("./personal-sink").readRunPersonalTaint
  const spy = jest.mocked(sink.readRunPersonalTaint).mockImplementationOnce(async (context) => {
    const taint = await original(context)
    await startToolExecutionRun("read-race-unrelated", { localAuthorization: LOCAL_PERSON_RUN })
    return taint
  })
  try {
    expect(await personalEgressFenced({ executionRunId: clear.id })).toBe(false)
  } finally {
    spy.mockImplementation(original)
  }
})

it("R3: unrelated fenced external bindings and live operations never block admission", async () => {
  const { runPersonalEgressOperation } = await import("./personal-egress")
  const old = await startToolExecutionRun("unrelated-private", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  await addPersonalMarksToRun({ executionRunId: old.id }, [mark])
  const unbind = bindPersonalEgressSession({ executionRunId: old.id })
  let finish!: () => void
  const pending = runPersonalEgressOperation(
    { executionRunId: old.id },
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
    false,
    true
  )
  const next = await startToolExecutionRun("unrelated-next", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  try {
    await expect(
      addPersonalMarksToRun({ executionRunId: next.id }, [mark])
    ).resolves.toBeUndefined()
  } finally {
    finish()
    await pending
    unbind()
  }
})
it("R3: finished runs clear their unproven process entries after commit", async () => {
  const { runPersonalEgressOperation } = await import("./personal-egress")
  const { finishToolExecutionRun } = await import("./acting-authority")
  const root = await startToolExecutionRun("finished-process", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const child = await startToolExecutionRun("unfinished-child", { parentRunId: root.id })
  await runPersonalEgressOperation({ executionRunId: root.id }, async () => undefined, true)
  await finishToolExecutionRun(root.id)
  await expect(addPersonalMarksToRun({ executionRunId: child.id }, [mark])).resolves.toBeUndefined()
})

it("S1: explicitly marked completion content without a run denies network", async () => {
  const { withPluginExecutionContext, pluginExecutionContext } =
    await import("@/lib/plugin/core/invocation-identity")
  await withPluginExecutionContext(
    "marked-completion",
    { personalEgressBlocked: true },
    async () => {
      await expect(
        assertPersonalEgress(pluginExecutionContext("marked-completion")!)
      ).rejects.toMatchObject({ code: "personal-egress-denied" })
    }
  )
  await expect(assertPersonalEgress({})).resolves.toBeUndefined()
})

it("retains live canonical taint through nested opaque producer unions", async () => {
  const { bindPersonalOperationSources, forkPersonalOperation } =
    await import("./personal-operation")
  const run = await startToolExecutionRun("nested-producer", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const inner = bindPersonalOperationSources({ executionRunId: "" }, [{ executionRunId: run.id }])
  const outer = forkPersonalOperation(bindPersonalOperationSources({ executionRunId: "" }, [inner]))
  await expect(assertPersonalEgress(outer)).resolves.toBeUndefined()
  await addPersonalMarksToRun({ executionRunId: run.id }, [mark])
  await expect(assertPersonalEgress(outer)).rejects.toMatchObject({
    code: "personal-egress-denied",
  })
})

it("S2 opaque producer dependencies retain unproven process fences and deletion cleanup", async () => {
  const { bindPersonalOperationSources } = await import("./personal-operation")
  const { runPersonalEgressOperation } = await import("./personal-egress")
  const run = await startToolExecutionRun("s2-opaque-process", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const context = { executionRunId: run.id }
  const source = bindPersonalOperationSources({}, [context])
  await runPersonalEgressOperation(source, async () => undefined, true)
  const releaseProcess = trackPersonalEgressProcess(source, "opaque-background", () => true)
  await expect(addPersonalMarksToRun(context, [mark])).rejects.toMatchObject({
    code: "personal-egress-denied",
  })
  releaseProcess()
  await getDb().executionRuns.delete(run.id)
  await getDb().executionRuns.put(run)
  await expect(addPersonalMarksToRun(context, [mark])).resolves.toBeUndefined()
})

it("rechecks serialized log producer references after marks, preserving unrelated Host logs", async () => {
  const { personalLogEgressSource, installPersonalLogEgressPolicy } =
    await import("./personal-egress")
  const { runLogEgress } = await import("@cognia/logging/context")
  const { bindPersonalOperationSources } = await import("./personal-operation")
  const run = await startToolExecutionRun("log-producer", { localAuthorization: LOCAL_PERSON_RUN })
  const source = bindPersonalOperationSources({}, [{ executionRunId: run.id }])
  const replay = JSON.parse(
    JSON.stringify([
      { id: "producer", hostEgressSource: personalLogEgressSource(source) },
      { id: "host" },
    ])
  )
  installPersonalLogEgressPolicy()
  const send = jest.fn(async () => "sent")
  await expect(runLogEgress(replay, send)).resolves.toBe("sent")
  await addPersonalMarksToRun({ executionRunId: run.id }, [mark])
  send.mockClear()
  await expect(runLogEgress(replay, send)).resolves.toBe("sent")
  expect(send).toHaveBeenCalledWith([{ id: "host" }])
  send.mockClear()
  await expect(
    runLogEgress(
      [{ id: "blocked", hostEgressSource: { version: 1, runIds: [], blocked: true } }] as never,
      send
    )
  ).resolves.toBeUndefined()
  expect(send).not.toHaveBeenCalled()
})

it.each([false, true])(
  "S2 rejected callback logs retain their producer after release (async=%s)",
  async (asyncFailure) => {
    const { withPluginExecutionContext } = await import("@/lib/plugin/core/invocation-identity")
    const { captureLogFailureSource, runLogEgress } = await import("@cognia/logging/context")
    const { installPersonalLogEgressPolicy } = await import("./personal-egress")
    installPersonalLogEgressPolicy()
    let failure: unknown
    try {
      await withPluginExecutionContext("s2-rejected", { personalEgressBlocked: true }, () => {
        if (asyncFailure) return Promise.reject("private callback error")
        throw new Error("private callback error")
      })
    } catch (error) {
      failure = error
    }
    const source = captureLogFailureSource(failure)
    expect(source).toMatchObject({ version: 1, blocked: true })
    const send = jest.fn(async () => undefined)
    await runLogEgress([{ hostEgressSource: source } as never], send)
    expect(send).not.toHaveBeenCalled()
  }
)

it("F5: a completed finite clone releases its sibling's later personal admission", async () => {
  const { runPersonalEgressOperation } = await import("./personal-egress")
  const parent = await startToolExecutionRun("f5-parent", { localAuthorization: LOCAL_PERSON_RUN })
  const a = await startToolExecutionRun("f5-clone", { parentRunId: parent.id })
  const b = await startToolExecutionRun("f5-recall", { parentRunId: parent.id })
  await runPersonalEgressOperation({ executionRunId: a.id }, async () => "clone finished", true)
  await expect(addPersonalMarksToRun({ executionRunId: b.id }, [mark])).resolves.toBeUndefined()
})

it("F6: an unverified bound session is fenced before admission", async () => {
  const run = await startToolExecutionRun("f6-admission", { localAuthorization: LOCAL_PERSON_RUN })
  const fence = jest.fn(async () => undefined)
  const unbind = bindPersonalEgressSession({ executionRunId: "f6-missing-session-run" }, fence)
  try {
    await addPersonalMarksToRun({ executionRunId: run.id }, [mark])
    expect(fence).toHaveBeenCalledTimes(1)
  } finally {
    unbind()
  }
})

it("F6: an unverified unfenceable session withholds admission", async () => {
  const run = await startToolExecutionRun("f6-unfenceable", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const unbind = bindPersonalEgressSession({ executionRunId: "f6-unreadable" })
  try {
    await expect(addPersonalMarksToRun({ executionRunId: run.id }, [mark])).rejects.toMatchObject({
      code: "personal-egress-denied",
    })
  } finally {
    unbind()
  }
})

it("F5: an actual background process blocks until its liveness ends", async () => {
  const parent = await startToolExecutionRun("f5-background", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const child = await startToolExecutionRun("f5-background-child", { parentRunId: parent.id })
  let alive = true
  const release = trackPersonalEgressProcess(
    { executionRunId: parent.id },
    "host-process-42",
    () => alive
  )
  try {
    await expect(addPersonalMarksToRun({ executionRunId: child.id }, [mark])).rejects.toMatchObject(
      { code: "personal-egress-denied" }
    )
    const { finishToolExecutionRun } = await import("./acting-authority")
    await finishToolExecutionRun(parent.id)
    await expect(addPersonalMarksToRun({ executionRunId: child.id }, [mark])).rejects.toMatchObject(
      { code: "personal-egress-denied" }
    )
    alive = false
    await expect(
      addPersonalMarksToRun({ executionRunId: child.id }, [mark])
    ).resolves.toBeUndefined()
  } finally {
    release()
  }
})

it("F6 unknown ancestry stays affected even if a later read could be clean", async () => {
  const sink = await import("./personal-sink")
  const actual =
    jest.requireActual<typeof import("./personal-sink")>("./personal-sink").readRunPersonalTaint
  const run = await startToolExecutionRun("f6-sticky-admission", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const other = await startToolExecutionRun("f6-sticky-other", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  let first = true
  jest.mocked(sink.readRunPersonalTaint).mockImplementation(async (context) => {
    if (context.executionRunId === other.id && first) {
      first = false
      return { verified: false, marks: [], reason: "temporarily unreadable" }
    }
    return actual(context)
  })
  const fence = jest.fn(async () => undefined)
  const unbind = bindPersonalEgressSession({ executionRunId: other.id }, fence)
  try {
    await addPersonalMarksToRun({ executionRunId: run.id }, [mark])
    expect(fence).toHaveBeenCalledTimes(1)
  } finally {
    unbind()
    jest.mocked(sink.readRunPersonalTaint).mockImplementation(actual)
  }
})

it("F3 real child recall fences its parent while delegation waits", async () => {
  const parent = await startToolExecutionRun("f3-real-parent", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const child = await startToolExecutionRun("f3-real-child", { parentRunId: parent.id })
  let resume!: () => void
  const delegation = new Promise<void>((resolve) => {
    resume = resolve
  })
  let waiting = true
  void delegation.then(() => {
    waiting = false
  })
  const fence = jest.fn(async () => undefined)
  const unbind = bindPersonalEgressSession({ executionRunId: parent.id }, fence)
  try {
    await expect(
      addPersonalMarksToRun({ executionRunId: child.id }, [mark])
    ).resolves.toBeUndefined()
    expect(fence).toHaveBeenCalledTimes(1)
    expect(waiting).toBe(true)
  } finally {
    resume()
    await delegation
    unbind()
  }
})

it("P2 run-less operations and sessions never block an unrelated personal read", async () => {
  const { runPersonalEgressOperation } = await import("./personal-egress")
  const run = await startToolExecutionRun("p2-unrelated", { localAuthorization: LOCAL_PERSON_RUN })
  let finish!: () => void
  const active = runPersonalEgressOperation(
    {},
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  while (!finish) await new Promise((resolve) => setTimeout(resolve, 0))
  const unbind = bindPersonalEgressSession({})
  try {
    await expect(addPersonalMarksToRun({ executionRunId: run.id }, [mark])).resolves.toBeUndefined()
  } finally {
    finish()
    await active
    unbind()
  }
})

it("P8b transient database lookup failure retains Host process leases", async () => {
  const run = await startToolExecutionRun("p8-transient", { localAuthorization: LOCAL_PERSON_RUN })
  const release = trackPersonalEgressProcess({ executionRunId: run.id }, "p8-child", () => true)
  const actual = jest.requireActual<typeof import("@/lib/db/schema")>("@/lib/db/schema").getDb
  try {
    jest.mocked(getDb).mockImplementation(() => {
      throw new Error("temporary database failure")
    })
    await expect(assertPersonalEgress({ executionRunId: run.id })).rejects.toThrow()
    jest.mocked(getDb).mockImplementation(actual)
    await expect(addPersonalMarksToRun({ executionRunId: run.id }, [mark])).rejects.toMatchObject({
      code: "personal-egress-denied",
    })
  } finally {
    jest.mocked(getDb).mockImplementation(actual)
    release()
  }
})

it("R10 dispatch snapshots distinguish unknown refusal from explicit exposure", async () => {
  const { personalEgressFenced, invalidatePersonalEgressCache } = await import("./personal-egress")
  const { cachedPersonalDispatchFence, bindPersonalOperationSources } =
    await import("./personal-operation")
  const missing = { executionRunId: "r10-missing-run" }
  await expect(personalEgressFenced(missing)).resolves.toBe(true)
  expect(cachedPersonalDispatchFence(missing)).toBeUndefined()
  const run = await startToolExecutionRun("r10-cold-producer", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  invalidatePersonalEgressCache(run.id)
  const composite = bindPersonalOperationSources({}, [missing, { executionRunId: run.id }])
  expect(cachedPersonalDispatchFence(composite)).toBeUndefined()
  await addPersonalMarksToRun({ executionRunId: run.id }, [mark])
  await personalEgressFenced({ executionRunId: run.id })
  expect(cachedPersonalDispatchFence(composite)).toBe(true)
})

it("R10 composite exposure rereads a producer marked while another canonical read is pending", async () => {
  const { personalContentExposed } = await import("./personal-egress")
  const { bindPersonalOperationSources } = await import("./personal-operation")
  const sink = await import("./personal-sink")
  const actual =
    jest.requireActual<typeof import("./personal-sink")>("./personal-sink").readRunPersonalTaint
  const a = await startToolExecutionRun("r10-race-a", { localAuthorization: LOCAL_PERSON_RUN })
  const b = await startToolExecutionRun("r10-race-b", { localAuthorization: LOCAL_PERSON_RUN })
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    entered = resolve
  })
  let paused = false
  const reads: string[] = []
  jest.mocked(sink.readRunPersonalTaint).mockImplementation(async (context) => {
    reads.push(context.executionRunId ?? "")
    const result = await actual(context)
    if (context.executionRunId === b.id && !paused) {
      paused = true
      entered()
      await gate
    }
    return result
  })
  try {
    const proof = personalContentExposed(
      bindPersonalOperationSources({}, [{ executionRunId: b.id }, { executionRunId: a.id }])
    )
    await waiting
    await addPersonalMarksToRun({ executionRunId: a.id }, [mark])
    const readsBeforeRelease = reads.filter((id) => id === a.id).length
    release()
    await expect(proof).resolves.toBe(true)
    expect(reads.filter((id) => id === a.id).length).toBeGreaterThan(readsBeforeRelease)
  } finally {
    release()
    jest.mocked(sink.readRunPersonalTaint).mockImplementation(actual)
  }
})

it("R11 deleted branch parents refuse derived history without caching the refusal", async () => {
  const { personalEgressFenced, hasPersonalEgressSnapshot } = await import("./personal-egress")
  await getDb().sessions.put({
    id: "r11-branch",
    branchSeed: { version: 1 },
    parentSessionId: "r11-parent",
  } as never)
  const context = { sessionId: "r11-branch", sessionDerived: true as const }
  await expect(personalEgressFenced(context)).resolves.toBe(true)
  expect(hasPersonalEgressSnapshot(context)).toBe(false)
  await getDb().sessions.put({ id: "r11-parent" } as never)
  await expect(personalEgressFenced(context)).resolves.toBe(false)
  expect(hasPersonalEgressSnapshot(context)).toBe(false)
  const composite = { personalSources: [context] }
  await getDb().sessions.delete("r11-parent")
  await expect(personalEgressFenced(composite)).resolves.toBe(true)
  expect(hasPersonalEgressSnapshot(composite)).toBe(false)
})

it("names the people every producer's marks carry, and nobody when one cannot be verified", async () => {
  const { personalEgressMarkedPeople } = await import("./personal-egress")
  const { bindPersonalOperationSources } = await import("./personal-operation")
  const member = {
    kind: "platform" as const,
    platform: "lark" as const,
    adapterId: "a1",
    remoteUserId: "ou_m",
  }
  const a = await startToolExecutionRun("people-a", { localAuthorization: LOCAL_PERSON_RUN })
  const b = await startToolExecutionRun("people-b", { localAuthorization: LOCAL_PERSON_RUN })
  await addPersonalMarksToRun({ executionRunId: a.id }, [
    { person: member, source: "lark-user", markedAt: 1 },
  ])
  const composite = bindPersonalOperationSources({}, [
    { executionRunId: a.id },
    { executionRunId: b.id },
  ])
  await expect(personalEgressMarkedPeople(composite)).resolves.toEqual([member])
  await expect(personalEgressMarkedPeople({ executionRunId: b.id })).resolves.toEqual([])
  await expect(
    personalEgressMarkedPeople({ executionRunId: "missing-run" })
  ).resolves.toBeUndefined()
  await expect(
    personalEgressMarkedPeople({ executionRunId: a.id, personalEgressBlocked: true } as never)
  ).resolves.toBeUndefined()
})
