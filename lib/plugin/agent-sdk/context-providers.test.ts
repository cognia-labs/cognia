import { resolveContextContributions, readSharedMemory, queryTwinMemory } from "./context-providers"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  LOCAL_PERSON_RUN,
  startToolExecutionRun,
  recordAbsorbedRequester,
} from "@/lib/execution/acting-authority"
import {
  registerContextProvider,
  __resetContextProvidersForTesting,
} from "@/lib/plugin/registries/context-provider-registry"

const getStateMock = jest.fn()
const selectMock = jest.fn()

jest.mock("@/stores/squads/agent-team-store/store", () => ({
  __esModule: true,
  useAgentTeamStore: { getState: () => getStateMock() },
}))
jest.mock("@/stores/squads/agent-team-store/selectors", () => ({
  __esModule: true,
  OPERATOR_READER_ID: "operator",
  selectSharedMemoryEntriesForReader: (teamId: string, readerId: string) => (state: unknown) =>
    selectMock(teamId, readerId, state),
}))

const getCharacterMock = jest.fn()
const tryBuildTwinDepsMock = jest.fn()
const applyTwinContextMock = jest.fn()
jest.mock("@/lib/db/characters", () => ({
  ...jest.requireActual("@/lib/db/characters"),
  __esModule: true,
  getCharacter: (id: string) => getCharacterMock(id),
}))
jest.mock("@/lib/twin/runtime/build-deps", () => ({
  __esModule: true,
  tryBuildTwinDeps: () => tryBuildTwinDepsMock(),
}))
jest.mock("@/lib/twin/runtime/apply-twin-context", () => ({
  __esModule: true,
  applyTwinContext: (input: unknown) => applyTwinContextMock(input),
}))

const fixture = createDbTestFixture({ seeded: false })
beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  jest.clearAllMocks()
  __resetContextProvidersForTesting()
})
afterAll(fixture.dispose)
const localHost = async () => ({
  executionRunId: (await startToolExecutionRun(undefined, { localAuthorization: LOCAL_PERSON_RUN }))
    .id,
})

describe("resolveContextContributions", () => {
  it("feeds a plugin's run only its own providers", async () => {
    registerContextProvider("mine", { id: "mine", provide: () => "mine" }, { pluginId: "p" })
    registerContextProvider("theirs", { id: "theirs", provide: () => "secret" }, { pluginId: "q" })
    expect(await resolveContextContributions({ prompt: "hi" }, "p")).toBe("mine")
    expect(await resolveContextContributions({ prompt: "hi" }, undefined)).toBe("")
  })

  it("returns empty string with no providers", async () => {
    expect(await resolveContextContributions({ prompt: "hi" }, "p")).toBe("")
  })

  it("joins non-empty provider outputs", async () => {
    registerContextProvider("a", { id: "a", provide: () => "alpha" }, { pluginId: "p" })
    registerContextProvider("b", { id: "b", provide: () => "  " }, { pluginId: "p" })
    registerContextProvider("c", { id: "c", provide: async () => "gamma" }, { pluginId: "p" })
    expect(await resolveContextContributions({ prompt: "hi" }, "p")).toBe("alpha\n\ngamma")
  })

  it("skips a throwing provider", async () => {
    registerContextProvider("ok", { id: "ok", provide: () => "kept" }, { pluginId: "p" })
    registerContextProvider(
      "bad",
      {
        id: "bad",
        provide: () => {
          throw new Error("boom")
        },
      },
      { pluginId: "p" }
    )
    expect(await resolveContextContributions({ prompt: "hi" }, "p")).toBe("kept")
  })

  it("preserves registration order even when providers resolve out of order", async () => {
    // Provider "a" resolves only after "c" has already settled — output must
    // still be ordered by registration, not by resolution order.
    let resolveA: ((v: string) => void) | undefined
    const aPromise = new Promise<string>((r) => {
      resolveA = r
    })
    registerContextProvider("a", { id: "a", provide: () => aPromise }, { pluginId: "p" })
    registerContextProvider("c", { id: "c", provide: async () => "gamma" }, { pluginId: "p" })
    const resultPromise = resolveContextContributions({ prompt: "hi" }, "p")
    resolveA!("alpha")
    expect(await resultPromise).toBe("alpha\n\ngamma")
  })

  it("runs providers concurrently rather than serially", async () => {
    // A serial loop would never see two providers active at once (max 1);
    // Promise.all kicks both off before either yields (max 2).
    let active = 0
    let maxActive = 0
    const make = (id: string) => async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await Promise.resolve()
      active--
      return id
    }
    registerContextProvider("p1", { id: "p1", provide: make("p1") }, { pluginId: "p" })
    registerContextProvider("p2", { id: "p2", provide: make("p2") }, { pluginId: "p" })
    expect(await resolveContextContributions({ prompt: "hi" }, "p")).toBe("p1\n\np2")
    expect(maxActive).toBeGreaterThan(1)
  })

  it("isolates a rejecting and a synchronously-throwing provider under parallelism", async () => {
    registerContextProvider("good1", { id: "good1", provide: () => "one" }, { pluginId: "p" })
    registerContextProvider("asyncBad", {
      id: "asyncBad",
      provide: async () => {
        throw new Error("async boom")
      },
    })
    registerContextProvider("syncBad", {
      id: "syncBad",
      provide: () => {
        throw new Error("sync boom")
      },
    })
    registerContextProvider("good2", { id: "good2", provide: async () => "two" }, { pluginId: "p" })
    expect(await resolveContextContributions({ prompt: "hi" }, "p")).toBe("one\n\ntwo")
  })
})

describe("readSharedMemory", () => {
  it("withholds migrated ACL-readable entries after filtering by tag", async () => {
    getStateMock.mockReturnValue({ sharedMemory: {} })
    selectMock.mockReturnValue([
      { key: "k1", value: 1, writtenBy: "tm", version: 2, tags: ["a"] },
      { key: "k2", value: 2, writtenBy: "tm", version: 1, tags: ["b"] },
    ])
    const host = await localHost()
    const all = await readSharedMemory("team-1", {}, host)
    expect(selectMock).toHaveBeenCalledWith("team-1", "operator", { sharedMemory: {} })
    expect(all).toHaveLength(2)
    const filtered = await readSharedMemory("team-1", { tags: ["a"] }, host)
    expect(filtered).toEqual([
      {
        key: expect.stringMatching(/^withheld:/),
        value: "[Withheld: personal content of unverified person]",
        writtenBy: "withheld",
        version: 0,
      },
    ])
    expect(JSON.stringify(filtered)).not.toMatch(/"k1"|"tags"|"tm"/)
  })

  it("maps proven live publications with their fields and filters by tag", async () => {
    const { autoPublishTaskResult } = await import("@/lib/squads/memory/shared-memory-orchestrator")
    const memory: Record<string, import("@/types/agent/agent-team").SharedMemoryEntry> = {}
    getStateMock.mockReturnValue({
      sharedMemory: { "team-1": memory },
      teams: {},
      writeSharedMemory: (_teamId: string, key: string, entry: (typeof memory)[string]) => {
        memory[key] = entry
      },
    })
    const host = await localHost()
    const first = autoPublishTaskResult(
      { id: "team-1" },
      { id: "a", title: "First" },
      "first result",
      { id: "tm", name: "Writer" },
      host.executionRunId
    )!
    const second = autoPublishTaskResult(
      { id: "team-1" },
      { id: "b", title: "Second" },
      "second result",
      { id: "tm", name: "Writer" },
      host.executionRunId
    )!
    selectMock.mockReturnValue([first, second])
    expect(await readSharedMemory("team-1", {}, host)).toHaveLength(2)
    expect(await readSharedMemory("team-1", { tags: ["task:a"] }, host)).toEqual([
      {
        key: "task:a",
        value: "first result",
        writtenBy: "tm",
        writerName: "Writer",
        version: 1,
        tags: ["task:a", "taskTitle:First"],
      },
    ])
  })
})

describe("queryTwinMemory", () => {
  it("returns [] for a blank query", async () => {
    expect(await queryTwinMemory("c1", "  ")).toEqual([])
  })

  it("returns [] when the character has no twin", async () => {
    getCharacterMock.mockResolvedValue({ id: "c1" })
    expect(await queryTwinMemory("c1", "q")).toEqual([])
  })

  it("returns [] when twin deps are unavailable", async () => {
    getCharacterMock.mockResolvedValue({ id: "c1", twinId: "t1" })
    tryBuildTwinDepsMock.mockResolvedValue(null)
    expect(await queryTwinMemory("c1", "q")).toEqual([])
  })

  it("maps retrieved chunks and honors topK override", async () => {
    getCharacterMock.mockResolvedValue({ id: "c1", twinId: "t1", twinSettings: { ragTopK: 6 } })
    tryBuildTwinDepsMock.mockResolvedValue({ store: {}, embedding: {} })
    applyTwinContextMock.mockResolvedValue({
      retrievedChunks: [
        {
          chunk: { contentRedacted: "fact", vectorDocId: "v", sourceId: "s" },
          score: 0.9,
          sourceTitle: "Doc",
        },
      ],
    })
    const out = await queryTwinMemory("c1", "q", { topK: 3 }, await localHost())
    expect(applyTwinContextMock.mock.calls[0][0].character.twinSettings.ragTopK).toBe(3)
    expect(out).toEqual([{ content: "fact", score: 0.9, sourceTitle: "Doc" }])
  })

  it("never retrieves private twin history for an unverified reader or a root joined by another person", async () => {
    expect(await queryTwinMemory("c1", "q")).toEqual([])
    expect(applyTwinContextMock).not.toHaveBeenCalled()
    const host = await localHost()
    await recordAbsorbedRequester(host.executionRunId, {
      kind: "platform",
      platform: "slack",
      adapterId: "a",
      remoteUserId: "other",
    })
    expect(await queryTwinMemory("c1", "q", {}, host)).toEqual([])
    expect(applyTwinContextMock).not.toHaveBeenCalled()
  })

  it("degrades to [] when retrieval throws", async () => {
    getCharacterMock.mockResolvedValue({ id: "c1", twinId: "t1" })
    tryBuildTwinDepsMock.mockResolvedValue({ store: {}, embedding: {} })
    applyTwinContextMock.mockRejectedValue(new Error("vector store down"))
    expect(await queryTwinMemory("c1", "q")).toEqual([])
  })
})
