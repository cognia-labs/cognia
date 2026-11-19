import { OpenCodeV2Catalog } from "./v2-catalog"

function fixture() {
  let deliver!: (event: unknown) => void
  let release!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const client = {
    model: {
      list: jest.fn(async () => {
        await barrier
        return { data: [] }
      }),
    },
    integration: {
      list: jest.fn(async () => ({ location: { directory: "/repo" }, data: [{ id: "base" }] })),
    },
    agent: {
      list: jest.fn(async () => ({ location: { directory: "/repo" }, data: [{ id: "build" }] })),
    },
    event: {
      subscribe: jest.fn(({ signal }: { signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          yield { type: "server.connected" }
          while (!signal.aborted) {
            const event = await new Promise<unknown>((resolve) => {
              deliver = resolve
              signal.addEventListener("abort", () => resolve(undefined), { once: true })
            })
            if (event instanceof Error) throw event
            if (event) yield event
          }
        },
      })),
    },
  }
  const catalog = new OpenCodeV2Catalog(client as never, "/repo")
  const flush = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve()
  }
  return {
    client,
    catalog,
    release,
    flush,
    emit: async (event: unknown) => {
      deliver(event)
      await flush()
    },
  }
}

it("publishes partial entries before activation, then rereads before ready", async () => {
  const { catalog, client, release, flush } = fixture()
  const loading = catalog.refresh()
  expect(catalog.getSnapshot().states.agents).toBe("loading")
  await flush()
  expect(catalog.getSnapshot().agents).toEqual([{ id: "build" }])
  expect(catalog.getSnapshot().states.agents).toBe("partial")
  client.agent.list.mockResolvedValue({
    location: { directory: "/repo" },
    data: [{ id: "plugin" }],
  })
  release()
  await loading
  await flush()
  expect(catalog.getSnapshot().agents).toEqual([{ id: "plugin" }])
  expect(catalog.getSnapshot().states.agents).toBe("ready")
  catalog.dispose()
})

it("refreshes late capabilities and credentials only for its location", async () => {
  const { catalog, client, release, flush, emit } = fixture()
  release()
  await catalog.refresh()
  await flush()
  const count = client.integration.list.mock.calls.length
  await emit({ type: "integration.updated", location: { directory: "/other" }, data: {} })
  expect(client.integration.list).toHaveBeenCalledTimes(count)
  client.integration.list.mockResolvedValue({
    location: { directory: "/repo" },
    data: [{ id: "late" }],
  })
  await emit({
    type: "credential.updated",
    data: { integrationID: "late", credentialID: "account" },
  })
  expect(catalog.getSnapshot().integrations).toEqual([{ id: "late" }])
  client.agent.list.mockResolvedValue({ location: { directory: "/repo" }, data: [] })
  await emit({ type: "agent.updated", location: { directory: "/repo" }, data: {} })
  expect(catalog.getSnapshot().agents).toEqual([])
  catalog.dispose()
})

it("does not hide prior data or claim readiness after failures and stops on disposal", async () => {
  const { catalog, client, flush, release, emit } = fixture()
  void catalog.refresh()
  await flush()
  client.agent.list.mockRejectedValueOnce(new Error("offline"))
  await emit({ type: "agent.updated", location: { directory: "/repo" }, data: {} })
  expect(catalog.getSnapshot().agents).toEqual([{ id: "build" }])
  expect(catalog.getSnapshot().states.agents).toBe("error")
  const snapshot = catalog.getSnapshot()
  catalog.dispose()
  release()
  await flush()
  expect(catalog.getSnapshot()).toBe(snapshot)
})

it("does not lose updates received during a list request", async () => {
  const { catalog, client, release, flush, emit } = fixture()
  release()
  await catalog.refresh()
  await flush()
  let finish!: (value: { location: { directory: string }; data: { id: string }[] }) => void
  client.agent.list.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  await emit({ type: "agent.updated", location: { directory: "/repo" }, data: {} })
  client.agent.list.mockResolvedValue({ location: { directory: "/repo" }, data: [{ id: "new" }] })
  await emit({ type: "agent.updated", location: { directory: "/repo" }, data: {} })
  finish({ location: { directory: "/repo" }, data: [{ id: "stale" }] })
  await flush()
  expect(catalog.getSnapshot().agents).toEqual([{ id: "new" }])
  catalog.dispose()
})

it("does not let an old activation barrier complete a reconnected catalog", async () => {
  const { catalog, client, release, flush, emit } = fixture()
  const old = catalog.refresh()
  await flush()
  await emit(new Error("connection lost"))
  expect(catalog.getSnapshot().states.agents).toBe("error")
  let releaseNew!: () => void
  client.model.list.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      releaseNew = resolve
    })
    return { data: [] }
  })
  const next = catalog.refresh()
  await flush()
  expect(catalog.getSnapshot().states.agents).toBe("partial")
  release()
  await old
  await flush()
  expect(catalog.getSnapshot().states.agents).toBe("partial")
  releaseNew()
  await next
  expect(catalog.getSnapshot().states.agents).toBe("ready")
  catalog.dispose()
})
