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
      expect(pluginExecutionContext("p")?.executionRunId).toBe("service")
      yield this.#value
    }
  }
  const factory = bindPluginCallbacks("p", () => new Adapter())
  let adapter!: Adapter
  let iterator!: AsyncGenerator<number>
  withPluginExecutionContext("p", { executionRunId: "service" }, () => {
    adapter = factory()
    iterator = adapter.stream()
  })
  expect(adapter.read()).toBe(7)
  const next = iterator.next()
  expect(pluginExecutionContext("p")?.executionRunId).toBe("service")
  release()
  await expect(next).resolves.toEqual({ value: 7, done: false })
  // The Host may await transport backpressure before asking for another chunk.
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(pluginExecutionContext("p")?.executionRunId).toBe("service")
  await iterator.return(undefined as never)
  expect(pluginExecutionContext("p")).toBeUndefined()
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
