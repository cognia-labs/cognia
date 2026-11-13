import "fake-indexeddb/auto"
import {
  withPluginCommandExecution,
  withPluginJobExecutionContext,
  restrictPluginCredentialContext,
  HOST_BACKGROUND,
  bindPluginCallbacks,
  bindPluginContextCallbacks,
} from "./invocation-identity"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import {
  LOCAL_PERSON_RUN,
  startToolExecutionRun,
  startJobExecutionRun,
} from "@/lib/execution/acting-authority"
import { enqueueIntegrationActionJob } from "@/lib/db/integrations"
import {
  pluginExecutionContext,
  withPluginExecutionContext,
  createPluginCredentialAccess,
  readPluginCredentialAccess,
} from "./invocation-identity"

it("retains a Host-bound run across awaits and refuses ambiguous concurrent invocations", async () => {
  expect(pluginExecutionContext("provider")).toBeUndefined()
  await withPluginExecutionContext("provider", { executionRunId: "attempt" }, async () => {
    await Promise.resolve()
    expect(pluginExecutionContext("provider")).toEqual({
      executionRunId: "attempt",
      sessionId: undefined,
    })
    const access = createPluginCredentialAccess("provider")
    expect(readPluginCredentialAccess(access)?.context?.executionRunId).toBe("attempt")
    await withPluginExecutionContext("provider", { executionRunId: "other" }, async () => {
      expect(pluginExecutionContext("provider")).toEqual({ executionRunId: "" })
    })
    expect(pluginExecutionContext("provider")?.executionRunId).toBe("attempt")
  })
  expect(pluginExecutionContext("provider")).toBeUndefined()
  expect(readPluginCredentialAccess({} as never)).toBeUndefined()
})

it("unknown Host invocations remain inside a run and clean up even on failure", async () => {
  await expect(
    withPluginExecutionContext("provider", {}, async () => {
      expect(pluginExecutionContext("provider")?.executionRunId).toBe("")
      throw new Error("failed")
    })
  ).rejects.toThrow("failed")
  expect(pluginExecutionContext("provider")).toBeUndefined()
})

it("can only narrow a pinned context, including an outside-run entry", () => {
  const original = { executionRunId: "original" }
  expect(restrictPluginCredentialContext(original, { executionRunId: "later" })).toEqual({
    executionRunId: "",
  })
  expect(restrictPluginCredentialContext(undefined, original)).toEqual({ executionRunId: "" })
  expect(restrictPluginCredentialContext(original, undefined)).toEqual(original)
  expect(restrictPluginCredentialContext(original, { ...original, externalEngine: true })).toEqual({
    ...original,
    externalEngine: true,
  })
})

it("classifies commands only from Host-held invocation state", async () => {
  await withPluginCommandExecution("command-owner", { executionRunId: "forged" }, async () => {
    expect(pluginExecutionContext("command-owner")).toEqual(HOST_BACKGROUND)
  })
  await withPluginExecutionContext(
    "command-owner",
    { executionRunId: "exact-attempt" },
    async () => {
      await withPluginCommandExecution("command-owner", undefined, async () => {
        await Promise.resolve()
        expect(pluginExecutionContext("command-owner")?.executionRunId).toBe("exact-attempt")
      })
    }
  )
})

it("keeps direct Host-local proof distinct from background and preserves sync callbacks", async () => {
  const callback = bindPluginCallbacks("p", () => pluginExecutionContext("p"))
  expect(callback()).toEqual(HOST_BACKGROUND)
  withPluginExecutionContext("p", { localAuthorization: LOCAL_PERSON_RUN }, () => {
    expect(callback()).toEqual({ localAuthorization: LOCAL_PERSON_RUN })
    withPluginExecutionContext("p", HOST_BACKGROUND, () => {
      expect(pluginExecutionContext("p")).toEqual(HOST_BACKGROUND)
    })
  })
  expect(pluginExecutionContext("p")).toBeUndefined()
})

it("fences contributed methods, returned class instances and async iterators through settlement", async () => {
  const fixture = createDbTestFixture({ seeded: false })
  await fixture.initialize()
  const run = await startToolExecutionRun("factory-service")
  try {
    let release!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    class Adapter {
      #value = 7
      read() {
        return this.#value
      }
      async *stream() {
        await waiting
        expect(pluginExecutionContext("p")?.executionRunId).toBe(run.id)
        yield this.#value
      }
    }
    const factory = bindPluginCallbacks("p", () => new Adapter())
    let adapter!: Adapter
    let iterator!: AsyncGenerator<number>
    withPluginExecutionContext("p", { executionRunId: run.id }, () => {
      adapter = factory()
      iterator = adapter.stream()
    })
    expect(adapter.read()).toBe(7)
    const next = iterator.next()
    expect(pluginExecutionContext("p")?.executionRunId).toBe(run.id)
    release()
    await expect(next).resolves.toEqual({ value: 7, done: false })
    // The Host may await transport backpressure before asking for another chunk.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(pluginExecutionContext("p")?.executionRunId).toBe(run.id)
    await iterator.return(undefined as never)
    expect(pluginExecutionContext("p")).toBeUndefined()
  } finally {
    await fixture.dispose()
  }
})

it("wraps callback arguments at the published context, preserves off identity and cloneable data", async () => {
  let handler!: () => Promise<void>
  const host = {
    register: jest.fn((input: { handler: () => Promise<void>; data: object }) => {
      handler = input.handler
      expect(structuredClone(input.data)).toEqual({ label: "safe" })
    }),
    off: jest.fn((_callback: unknown) => {}),
  }
  const ctx = bindPluginContextCallbacks("p", host)
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const callback = async () => {
    await waiting
    expect(pluginExecutionContext("p")).toEqual(HOST_BACKGROUND)
  }
  ctx.register({ handler: callback, data: { label: "safe" } })
  const pending = handler()
  expect(pluginExecutionContext("p")).toEqual(HOST_BACKGROUND)
  ctx.off(callback)
  expect(host.off).toHaveBeenCalledWith(handler)
  release()
  await pending
  expect(pluginExecutionContext("p")).toBeUndefined()
})

it("does not lend an awaiting local invocation to an unrelated registered background callback", async () => {
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const pending = withPluginExecutionContext(
    "p",
    { localAuthorization: LOCAL_PERSON_RUN },
    () => waiting
  )
  const callback = bindPluginCallbacks("p", () => pluginExecutionContext("p"))
  expect(callback()).toEqual(HOST_BACKGROUND)
  await withPluginCommandExecution("p", undefined, async () => {
    expect(pluginExecutionContext("p")).toEqual(HOST_BACKGROUND)
  })
  release()
  await pending
})

it("fences constructors and callbacks registered on asynchronous Host handles", async () => {
  class Client {
    #value = "safe"
    constructor() {
      expect(pluginExecutionContext("p")).toEqual(HOST_BACKGROUND)
    }
    read() {
      expect(pluginExecutionContext("p")).toEqual(HOST_BACKGROUND)
      return this.#value
    }
  }
  const library = bindPluginCallbacks("p", { Client })
  expect(new library.Client().read()).toBe("safe")
  let listener!: () => unknown
  const api = bindPluginContextCallbacks("p", {
    create: async () => ({
      onMessage(fn: () => unknown) {
        listener = fn
      },
    }),
  })
  const handle = await api.create()
  handle.onMessage(() => pluginExecutionContext("p"))
  expect(listener()).toEqual(HOST_BACKGROUND)
  expect(pluginExecutionContext("p")).toBeUndefined()
})

it("preserves constructors exported through asynchronous context handles", async () => {
  class Counter {
    #value = 1
    read() {
      return this.#value
    }
  }
  const api = bindPluginContextCallbacks("p", {
    importModule: async () => bindPluginCallbacks("provider", { Counter }),
  })
  const exports = await api.importModule()
  expect(new exports.Counter().read()).toBe(1)
  expect(pluginExecutionContext("provider")).toBeUndefined()
})

it("fences methods on function-valued providers, including frozen callback properties", async () => {
  const provider = Object.assign(() => {}, { complete: async () => pluginExecutionContext("p") })
  Object.freeze(provider)
  const wrapped = bindPluginCallbacks("p", provider)
  await expect(wrapped.complete()).resolves.toEqual(HOST_BACKGROUND)
  expect(Object.keys(wrapped)).toContain("complete")
})

describe("Host integration job delegation", () => {
  const dbFixture = createDbTestFixture()
  beforeAll(dbFixture.initialize)
  beforeEach(dbFixture.restore)
  afterAll(dbFixture.dispose)

  async function parent(id: string) {
    return startToolExecutionRun(undefined, { runId: id, localAuthorization: LOCAL_PERSON_RUN })
  }
  async function job(parentId: string) {
    const queued = await enqueueIntegrationActionJob({
      pluginId: "delegation",
      integrationId: "items",
      accountId: "account",
      actionId: "list",
      input: {},
      risk: "read",
      status: "running",
      attempts: 1,
      maxAttempts: 1,
      source: "chat",
    })
    await startJobExecutionRun(`integration:${queued.id}`, { executionRunId: parentId })
    return queued
  }

  it("selects the verified child and preserves its chain through duplicate tool wrappers", async () => {
    const root = await parent("delegation-parent")
    const child = await job(root.id)
    const childContext = { executionRunId: `execution:job:integration:${child.id}` }
    await withPluginExecutionContext("delegation", { executionRunId: root.id }, async () => {
      await withPluginJobExecutionContext("delegation", child.id, async () => {
        expect(pluginExecutionContext("delegation")?.executionRunId).toBe(
          childContext.executionRunId
        )
        await withPluginExecutionContext("delegation", childContext, async () => {
          expect(pluginExecutionContext("delegation")?.executionRunId).toBe(
            childContext.executionRunId
          )
        })
        const unrelated = await parent("unrelated-local-person")
        await withPluginExecutionContext(
          "delegation",
          { executionRunId: unrelated.id },
          async () => {
            expect(pluginExecutionContext("delegation")).toEqual({ executionRunId: "" })
          }
        )
      })
      expect(pluginExecutionContext("delegation")?.executionRunId).toBe(root.id)
    })
    expect(pluginExecutionContext("delegation")).toBeUndefined()
  })

  it.each(["different-parent", "different-root", "different-owner"])(
    "refuses an unverified %s delegation",
    async (mismatch) => {
      const root = await parent("delegation-parent")
      const other = await parent("other-parent")
      const child = await job(mismatch === "different-parent" ? other.id : root.id)
      if (mismatch === "different-root")
        await getDb().executionRuns.update(`execution:job:integration:${child.id}`, {
          "actingIdentity.rootRunId": other.id,
        })
      if (mismatch === "different-owner")
        await getDb().integrationActionJobs.update(child.id, { pluginId: "other-plugin" })
      await withPluginExecutionContext("delegation", { executionRunId: root.id }, async () => {
        await withPluginJobExecutionContext("delegation", child.id, async () => {
          expect(pluginExecutionContext("delegation")).toEqual({ executionRunId: "" })
        })
      })
    }
  )

  it("refuses sibling jobs even when their exact identity root is the same", async () => {
    const root = await parent("sibling-parent")
    const first = await job(root.id)
    const sibling = await job(root.id)
    await withPluginExecutionContext("delegation", { executionRunId: root.id }, () =>
      withPluginJobExecutionContext("delegation", first.id, () =>
        withPluginJobExecutionContext("delegation", sibling.id, async () => {
          expect(pluginExecutionContext("delegation")).toEqual({ executionRunId: "" })
        })
      )
    )
  })
})

it("H3: Host context copies retain the unique admitting operation", async () => {
  const { forkPersonalOperation, isPersonalAdmissionOperation } =
    await import("@/lib/execution/personal-operation")
  const root = forkPersonalOperation({ executionRunId: "lineage" })
  const child = forkPersonalOperation(root)
  await withPluginExecutionContext("operation-copy", root, async () => {
    await withPluginExecutionContext("operation-copy", child, async () => {
      await Promise.resolve()
      const current = pluginExecutionContext("operation-copy")!
      expect(isPersonalAdmissionOperation(child, current)).toBe(true)
      expect(isPersonalAdmissionOperation(forkPersonalOperation(root), current)).toBe(false)
    })
  })
})

it("retains all producer dependencies when concurrent sibling operations deny credential authority", async () => {
  const { forkPersonalOperation, personalOperationSources } =
    await import("@/lib/execution/personal-operation")
  const parent = forkPersonalOperation({
    executionRunId: "same-run",
    personalEgressBlocked: true as const,
  })
  const left = forkPersonalOperation(parent),
    right = forkPersonalOperation(parent)
  await withPluginExecutionContext("sibling-marked", left, async () => {
    await withPluginExecutionContext("sibling-marked", right, async () => {
      const context = pluginExecutionContext("sibling-marked")!
      expect(context).toMatchObject({ executionRunId: "", personalEgressBlocked: true })
      expect(personalOperationSources(context)).toHaveLength(2)
    })
  })
})

describe("F2 instance exposure lifetime", () => {
  const fixture = createDbTestFixture({ seeded: false })
  beforeAll(fixture.initialize)
  beforeEach(fixture.restore)
  afterAll(fixture.dispose)
  it("Q4 cold clean dispatch never records exposure and cold marked dispatch awaits proof", async () => {
    const { beginPluginEgressInstance, pluginEgressContextResolver } =
      await import("./invocation-identity")
    const { assertPersonalEgress, invalidatePersonalEgressCache } =
      await import("@/lib/execution/personal-egress")
    for (const marked of [false, true]) {
      const run = await startToolExecutionRun(`q4-${marked}`, {
        localAuthorization: LOCAL_PERSON_RUN,
      })
      if (marked)
        await getDb().executionRuns.update(run.id, {
          personalMarks: [{ person: { kind: "local-person" }, source: "Q4", markedAt: 1 }],
        })
      invalidatePersonalEgressCache(run.id)
      const id = `q4-${marked}`
      beginPluginEgressInstance(id)
      const callback = bindPluginCallbacks(
        id,
        () => "delivered",
        () => ({ executionRunId: run.id })
      )
      expect(callback()).toBe("delivered")
      await new Promise((resolve) => setTimeout(resolve, 20))
      const check = assertPersonalEgress(pluginEgressContextResolver(id)())
      if (marked) await expect(check).rejects.toMatchObject({ code: "personal-egress-denied" })
      else await expect(check).resolves.toBeUndefined()
    }
  })
  it("R10 cold composites read every producer before delivery and retain only explicit exposure", async () => {
    const { beginPluginEgressInstance, pluginEgressContextResolver } =
      await import("./invocation-identity")
    const { bindPersonalOperationSources } = await import("@/lib/execution/personal-operation")
    const { assertPersonalEgress, invalidatePersonalEgressCache } =
      await import("@/lib/execution/personal-egress")
    for (const marked of [false, true]) {
      const a = await startToolExecutionRun(`r10-a-${marked}`, {
        localAuthorization: LOCAL_PERSON_RUN,
      })
      const b = await startToolExecutionRun(`r10-b-${marked}`, {
        localAuthorization: LOCAL_PERSON_RUN,
      })
      if (marked)
        await getDb().executionRuns.update(b.id, {
          personalMarks: [{ person: { kind: "local-person" }, source: "R10", markedAt: 1 }],
        })
      invalidatePersonalEgressCache(a.id)
      invalidatePersonalEgressCache(b.id)
      const source = bindPersonalOperationSources({}, [
        { executionRunId: a.id },
        bindPersonalOperationSources({}, [
          { personalSources: [{ executionRunId: b.id }, { executionRunId: "missing-r10" }] },
        ]),
      ])
      const id = `r10-composite-${marked}`
      beginPluginEgressInstance(id)
      const delivered = jest.fn(() => "delivered")
      const callback = bindPluginCallbacks(id, delivered, () => source)
      const delivery = callback()
      expect(delivered).not.toHaveBeenCalled()
      await expect(Promise.resolve(delivery)).resolves.toBe("delivered")
      expect(delivered).toHaveBeenCalledTimes(1)
      const check = assertPersonalEgress(pluginEgressContextResolver(id)())
      if (marked) await expect(check).rejects.toMatchObject({ code: "personal-egress-denied" })
      else await expect(check).resolves.toBeUndefined()
    }
  })
  it.each([false, true])(
    "R11 sync cold composite guard warms without delivering marked=%s",
    async (marked) => {
      const {
        markPluginSynchronousCallback,
        beginPluginEgressInstance,
        pluginEgressContextResolver,
      } = await import("./invocation-identity")
      const { bindPersonalOperationSources, cachedPersonalDispatchFence } =
        await import("@/lib/execution/personal-operation")
      const { invalidatePersonalEgressCache, assertPersonalEgress } =
        await import("@/lib/execution/personal-egress")
      const a = await startToolExecutionRun(`r11-sync-a-${marked}`, {
        localAuthorization: LOCAL_PERSON_RUN,
      })
      const b = await startToolExecutionRun(`r11-sync-b-${marked}`, {
        localAuthorization: LOCAL_PERSON_RUN,
      })
      if (marked)
        await getDb().executionRuns.update(b.id, {
          personalMarks: [{ person: { kind: "local-person" }, source: "R11", markedAt: 1 }],
        })
      invalidatePersonalEgressCache(a.id)
      invalidatePersonalEgressCache(b.id)
      const source = bindPersonalOperationSources({}, [
        { executionRunId: a.id },
        { executionRunId: b.id },
      ])
      const id = `r11-sync-${marked}`
      beginPluginEgressInstance(id)
      const guest = jest.fn(() => true)
      const callback = bindPluginCallbacks(id, guest, () => source)
      markPluginSynchronousCallback(callback, false)
      expect(callback()).toBe(false)
      expect(guest).not.toHaveBeenCalled()
      await expect(assertPersonalEgress(pluginEgressContextResolver(id)())).resolves.toBeUndefined()
      for (let n = 0; cachedPersonalDispatchFence(source) === undefined && n < 100; n++)
        await new Promise((resolve) => setTimeout(resolve, 1))
      expect(cachedPersonalDispatchFence(source)).toBe(marked)
      expect(callback()).toBe(true)
      expect(guest).toHaveBeenCalledTimes(1)
      const check = assertPersonalEgress(pluginEgressContextResolver(id)())
      if (marked) await expect(check).rejects.toMatchObject({ code: "personal-egress-denied" })
      else await expect(check).resolves.toBeUndefined()
    }
  )
  it("R11 IPC synchronous filter rejects cold composite before guest delivery", async () => {
    const { PluginIPC } = await import("@/lib/plugin/messaging/ipc")
    const { bindPersonalOperationSources, cachedPersonalDispatchFence } =
      await import("@/lib/execution/personal-operation")
    const { invalidatePersonalEgressCache } = await import("@/lib/execution/personal-egress")
    const a = await startToolExecutionRun("r11-ipc-a", { localAuthorization: LOCAL_PERSON_RUN })
    const b = await startToolExecutionRun("r11-ipc-b", { localAuthorization: LOCAL_PERSON_RUN })
    invalidatePersonalEgressCache(a.id)
    invalidatePersonalEgressCache(b.id)
    const source = bindPersonalOperationSources({}, [
      { executionRunId: a.id },
      { executionRunId: b.id },
    ])
    const ipc = new PluginIPC()
    const guard = jest.fn(() => true),
      received = jest.fn()
    const bound = bindPluginCallbacks("r11-receiver", guard, () => source)
    ipc.subscribe("r11-receiver", "r11-channel", received, bound)
    await withPluginExecutionContext("r11-sender", source, () =>
      ipc.send("r11-sender", "r11-receiver", "r11-channel", "content")
    )
    expect(guard).not.toHaveBeenCalled()
    expect(received).not.toHaveBeenCalled()
    for (let n = 0; cachedPersonalDispatchFence(source) === undefined && n < 100; n++)
      await new Promise((resolve) => setTimeout(resolve, 1))
    await withPluginExecutionContext("r11-sender", source, () =>
      ipc.send("r11-sender", "r11-receiver", "r11-channel", "content")
    )
    expect(guard).toHaveBeenCalledTimes(1)
    expect(received).toHaveBeenCalledWith("content", "r11-sender")
    ipc.clear()
  })
  it("P3 copied composite delivery preserves a verified clean snapshot", async () => {
    const { beginPluginEgressInstance, pluginEgressContextResolver, withPluginContentDispatch } =
      await import("./invocation-identity")
    const { bindPersonalOperationSources } = await import("@/lib/execution/personal-operation")
    const { assertPersonalEgress } = await import("@/lib/execution/personal-egress")
    const a = await startToolExecutionRun("p3-composite-a")
    const b = await startToolExecutionRun("p3-composite-b")
    const source = bindPersonalOperationSources({}, [
      { executionRunId: a.id },
      { executionRunId: b.id },
    ])
    beginPluginEgressInstance("p3-composite")
    const callback = bindPluginCallbacks("p3-composite", () => undefined)
    await withPluginContentDispatch("p3-composite", source, callback)
    await expect(
      assertPersonalEgress(pluginEgressContextResolver("p3-composite")())
    ).resolves.toBeUndefined()
  })
  it("P3 a clean delivery is not retroactively exposed when its run later taints", async () => {
    const { beginPluginEgressInstance, pluginEgressContextResolver, withPluginContentDispatch } =
      await import("./invocation-identity")
    const { assertPersonalEgress } = await import("@/lib/execution/personal-egress")
    const a = await startToolExecutionRun("p3-a", { localAuthorization: LOCAL_PERSON_RUN })
    const b = await startToolExecutionRun("p3-b", { localAuthorization: LOCAL_PERSON_RUN })
    beginPluginEgressInstance("p3")
    const source = pluginEgressContextResolver("p3")
    await withPluginContentDispatch("p3", { executionRunId: a.id }, () => undefined)
    await getDb().executionRuns.update(a.id, {
      personalMarks: [{ person: { kind: "local-person" }, source: "P3", markedAt: 1 }],
    })
    await withPluginContentDispatch("p3", { executionRunId: b.id }, () => undefined)
    await expect(assertPersonalEgress(source())).resolves.toBeUndefined()
    await withPluginContentDispatch("p3", { executionRunId: a.id }, () => undefined)
    await expect(assertPersonalEgress(source())).rejects.toMatchObject({
      code: "personal-egress-denied",
    })
  })

  it("F2 opaque exposure unions survive release and a later clean source; reload isolates old APIs", async () => {
    const { beginPluginEgressInstance, pluginEgressContextResolver } =
      await import("./invocation-identity")
    const { bindPersonalOperationSources } = await import("@/lib/execution/personal-operation")
    const { assertPersonalEgress } = await import("@/lib/execution/personal-egress")
    const marked = await startToolExecutionRun("f2-opaque-marked", {
      localAuthorization: LOCAL_PERSON_RUN,
    })
    const clean = await startToolExecutionRun("f2-opaque-clean", {
      localAuthorization: LOCAL_PERSON_RUN,
    })
    await getDb().executionRuns.update(marked.id, {
      personalMarks: [{ person: { kind: "local-person" }, source: "F2", markedAt: 1 }],
    })
    beginPluginEgressInstance("f2-instance")
    const oldSource = pluginEgressContextResolver("f2-instance")
    const { withPluginContentDispatch } = await import("./invocation-identity")
    await withPluginContentDispatch(
      "f2-instance",
      bindPersonalOperationSources({}, [{ executionRunId: marked.id }]),
      async () => undefined
    )
    await withPluginExecutionContext(
      "f2-instance",
      bindPersonalOperationSources({}, [{ executionRunId: clean.id }]),
      async () => undefined
    )
    await expect(assertPersonalEgress(oldSource())).rejects.toMatchObject({
      code: "personal-egress-denied",
    })
    beginPluginEgressInstance("f2-instance")
    await expect(
      assertPersonalEgress(pluginEgressContextResolver("f2-instance")())
    ).resolves.toBeUndefined()
    await expect(assertPersonalEgress(oldSource())).rejects.toMatchObject({
      code: "personal-egress-denied",
    })
  })
})
