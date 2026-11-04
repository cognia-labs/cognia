/** @jest-environment node */
jest.mock("@/cli/src/runtime/external/host-branch", () => ({
  installCliExternalAgentHost: jest.fn(() => jest.fn()),
  selectCliAgentWorkspace: jest.fn(),
}))
jest.mock("@/cli/src/runtime/external/sandbox-launcher", () => ({
  findSandboxLauncher: jest.fn(() => "/bin/launcher"),
}))
jest.mock("@/lib/ai/agent/external/config/presets", () => ({
  createAgentFromPreset: jest.fn((presetId: string, overrides: object) => ({
    presetId,
    ...overrides,
  })),
}))
jest.mock("@/cli/src/runtime/external/version-probe", () => ({
  probeRuntimeVersion: jest.fn(async () => ({ output: "fake 1.2.3\n", detail: null })),
}))
jest.mock("@/lib/ai/agent/external/config/install-catalog", () => ({
  findRuntimeById: jest.fn(
    (id: string) =>
      ({
        fake: {
          runtimeId: "fake",
          protocol: "acp",
          presetIds: ["fake-preset"],
          systemCommand: "fake",
        },
        rpc: { runtimeId: "rpc", protocol: "pi-rpc", presetIds: ["pi-rpc"], systemCommand: "pi" },
      })[id]
  ),
}))
jest.mock("@/lib/ai/agent/external/integrations/acp", () => ({
  createAcpClientAdapter: jest.fn(),
}))

import { probeRuntimeVersion } from "@/cli/src/runtime/external/version-probe"
import { createAcpClientAdapter } from "@/lib/ai/agent/external/integrations/acp"
import {
  isolatedHomeEnv,
  runAgentSmoke,
  RuntimeNotInstalled,
  waitUntilUnlisted,
  type VendorSmoke,
} from "./generic"

const probeMock = probeRuntimeVersion as jest.Mock
const createAdapterMock = createAcpClientAdapter as jest.Mock

interface FakeBehaviour {
  session?: "created" | "refused" | "broken"
  listsNewSessions?: boolean
  capabilities?: Record<string, unknown>
  agentName?: string
}

function fakeAdapter(behaviour: FakeBehaviour = {}) {
  const sessions = new Set<string>()
  const adapter = {
    configs: [] as Array<{ process: { env: Record<string, string> } }>,
    connect: jest.fn(async (config: { process: { env: Record<string, string> } }) => {
      adapter.configs.push(config)
    }),
    disconnect: jest.fn(async () => undefined),
    getAcpInitializationMetadata: jest.fn(() => ({
      protocolVersion: 1,
      agentInfo: { name: behaviour.agentName ?? "fake-agent", version: "1.2.3" },
      agentCapabilities: behaviour.capabilities ?? {},
    })),
    getAuthMethods: jest.fn(() => [{ id: "login" }]),
    createSession: jest.fn(async () => {
      if (behaviour.session === "refused") throw new Error("Authentication required")
      if (behaviour.session === "broken") throw new Error("-32603: Internal error")
      if (behaviour.listsNewSessions !== false) sessions.add("s1")
      return { id: "s1" }
    }),
    listSessions: jest.fn(async () => [...sessions].map((sessionId) => ({ sessionId }))),
    loadSession: jest.fn(async () => undefined),
    deleteSession: jest.fn(async (id: string) => {
      sessions.delete(id)
    }),
    prompt: jest.fn(async function* (_id: string, message: { content: Array<{ text: string }> }) {
      sessions.add("s1")
      const marker = message.content[0].text.split("exactly: ")[1]
      yield { type: "message_delta", delta: { type: "text", text: marker } }
      yield { type: "done", stopReason: "end_turn" }
    }),
    respondToPermission: jest.fn(),
    respondToElicitation: jest.fn(),
  }
  createAdapterMock.mockReturnValue(adapter)
  return adapter
}

const defaults = { live: false, keep: false }

describe("runAgentSmoke", () => {
  it("rejects unknown, non-ACP and missing runtimes before starting anything", async () => {
    await expect(runAgentSmoke("nope", defaults, undefined)).rejects.toThrow(/Unknown runtime/)
    await expect(runAgentSmoke("rpc", defaults, undefined)).rejects.toThrow(/speaks pi-rpc/)
    probeMock.mockResolvedValueOnce({ output: null, detail: "fake not found" })
    await expect(runAgentSmoke("fake", defaults, undefined)).rejects.toBeInstanceOf(
      RuntimeNotInstalled
    )
  })

  it("accepts a refusal without credentials, isolates HOME and reconnects", async () => {
    const adapter = fakeAdapter({ session: "refused" })
    const vendor: VendorSmoke = {
      runtimeId: "fake",
      agentName: "fake-agent",
      isolatedEnv: () => ({ FAKE_STATE: "x" }),
      run: async (_context, lane) => ({ vendorSawSession: lane.sessionId ?? null }),
    }
    const report = await runAgentSmoke("fake", defaults, vendor)
    expect(report).toMatchObject({
      ok: true,
      runtimeId: "fake",
      presetId: "fake-preset",
      version: "fake 1.2.3",
      session: "authentication-required",
      reconnect: true,
      vendorSawSession: null,
      modelTurn: expect.stringContaining("--live"),
    })
    expect(report.reconnectLoad).toBeUndefined()
    const env = adapter.configs[0].process.env
    expect(env.FAKE_STATE).toBe("x")
    expect(env.HOME).toMatch(/cognia-smoke-fake-.*\/home$/)
    expect(adapter.connect).toHaveBeenCalledTimes(2)
  })

  it("fails on any other session error, and on a refusal in the live lane", async () => {
    fakeAdapter({ session: "broken" })
    await expect(runAgentSmoke("fake", defaults, undefined)).rejects.toThrow(/Internal error/)
    fakeAdapter({ session: "refused" })
    await expect(runAgentSmoke("fake", { live: true, keep: false }, undefined)).rejects.toThrow(
      /Authentication required/
    )
  })

  it("rejects the wrong ACP implementation", async () => {
    fakeAdapter({ agentName: "someone-else" })
    await expect(
      runAgentSmoke("fake", defaults, { runtimeId: "fake", agentName: "fake-agent" })
    ).rejects.toThrow(/Unexpected ACP implementation/)
  })

  it("lists, loads and deletes a persisted session", async () => {
    const adapter = fakeAdapter({
      capabilities: { loadSession: true, sessionCapabilities: { list: {}, delete: {} } },
    })
    const report = await runAgentSmoke("fake", defaults, { runtimeId: "fake", isolateHome: false })
    expect(report).toMatchObject({
      session: "created",
      list: true,
      reconnectLoad: true,
      delete: true,
    })
    expect(adapter.configs[0].process.env.HOME).toBeUndefined()
    expect(adapter.deleteSession).toHaveBeenCalledWith("s1")
  })

  it("leaves an unpersisted session alone outside the live lane", async () => {
    const adapter = fakeAdapter({
      listsNewSessions: false,
      capabilities: { loadSession: true, sessionCapabilities: { list: {}, delete: {} } },
    })
    const report = await runAgentSmoke("fake", defaults, undefined)
    expect(report.list).toBe("not listed before its first turn")
    expect(report.reconnectLoad).toBeUndefined()
    expect(adapter.loadSession).not.toHaveBeenCalled()
  })

  it("runs a marker turn in the live lane and then requires the listing", async () => {
    const prepared: string[] = []
    const adapter = fakeAdapter({
      listsNewSessions: false,
      capabilities: { sessionCapabilities: { list: {}, delete: {} } },
    })
    const report = await runAgentSmoke(
      "fake",
      { live: true, keep: false },
      {
        runtimeId: "fake",
        liveEnv: () => ({ REAL: "1" }),
        prepareSession: async (_adapter, id) => void prepared.push(id),
      }
    )
    expect(prepared).toEqual(["s1"])
    expect(report).toMatchObject({ live: true, list: true, delete: true })
    expect((report.markerTurn as { stopReason: string }).stopReason).toBe("end_turn")
    expect(report.modelTurn).toBeUndefined()
    expect(adapter.configs[0].process.env).toEqual({ REAL: "1" })
  })
})

describe("helpers", () => {
  it("puts HOME and every XDG root inside scratch", () => {
    expect(isolatedHomeEnv("/s")).toEqual({
      HOME: "/s/home",
      XDG_CONFIG_HOME: "/s/home/.config",
      XDG_DATA_HOME: "/s/home/.local/share",
      XDG_STATE_HOME: "/s/home/.local/state",
      XDG_CACHE_HOME: "/s/home/.cache",
    })
  })

  it("polls until a deleted session disappears, or gives up", async () => {
    let calls = 0
    await expect(waitUntilUnlisted(async () => ++calls < 3, 1_000, 1)).resolves.toBe(true)
    expect(calls).toBe(3)
    await expect(waitUntilUnlisted(async () => true, 5, 1)).resolves.toBe(false)
  })
})
