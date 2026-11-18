import {
  __resetPluginDataSnapshotSpaceRequestsForTests,
  requestPluginDataSnapshotSpaceDecision,
  resolvePluginDataSnapshotSpaceRequest,
  subscribePluginDataSnapshotSpaceRequests,
  type PluginDataSnapshotSpaceState,
} from "./snapshot-space-requests"

const ask = (pluginId: string) =>
  requestPluginDataSnapshotSpaceDecision({
    pluginId,
    fromVersion: 1,
    toVersion: 2,
    requiredBytes: 2048,
    availableBytes: 10,
  })

describe("plugin data snapshot space requests", () => {
  let states: PluginDataSnapshotSpaceState[]
  let stop: () => void
  beforeEach(() => {
    states = []
    stop = subscribePluginDataSnapshotSpaceRequests((state) => states.push(state))
  })
  afterEach(() => {
    stop()
    __resetPluginDataSnapshotSpaceRequestsForTests()
    delete (globalThis as Record<string, unknown>).__COGNIA_HEADLESS__
  })

  it("asks one question at a time and settles each with its own answer", async () => {
    const first = ask("a")
    const second = ask("b")
    const current = states.at(-1)!
    expect(current.current?.pluginId).toBe("a")
    expect(current.queue.map((request) => request.pluginId)).toEqual(["b"])

    resolvePluginDataSnapshotSpaceRequest(current.current!.id, "continue-without-snapshot")
    await expect(first).resolves.toBe("continue-without-snapshot")
    const next = states.at(-1)!
    expect(next.current?.pluginId).toBe("b")
    expect(next.queue).toEqual([])

    resolvePluginDataSnapshotSpaceRequest(next.current!.id, "cancel")
    await expect(second).resolves.toBe("cancel")
    expect(states.at(-1)).toEqual({ current: null, queue: [] })
  })

  it("answers a queued question without disturbing the one on screen", async () => {
    void ask("a")
    const queued = ask("b")
    const { queue } = states.at(-1)!
    resolvePluginDataSnapshotSpaceRequest(queue[0]!.id, "cancel")
    await expect(queued).resolves.toBe("cancel")
    expect(states.at(-1)?.current?.pluginId).toBe("a")
    expect(states.at(-1)?.queue).toEqual([])
  })

  it("migrates without a snapshot on a Host with nobody to ask", async () => {
    ;(globalThis as Record<string, unknown>).__COGNIA_HEADLESS__ = true
    await expect(ask("a")).resolves.toBe("continue-without-snapshot")
    expect(states.at(-1)?.current).toBeNull()
  })

  it("hands a late subscriber the question already waiting", () => {
    void ask("a")
    const late: PluginDataSnapshotSpaceState[] = []
    const unsubscribe = subscribePluginDataSnapshotSpaceRequests((state) => late.push(state))
    expect(late[0]?.current?.pluginId).toBe("a")
    unsubscribe()
  })
})
