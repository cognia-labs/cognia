/**
 * @jest-environment node
 */
import type { ProviderOperationProfile } from "@cognia/provider-types"

import type { ProviderLimits } from "@/types/subscription"

import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../../config/schema"
import type { CommandOutcome, HostTransport } from "../../api/transport"
import type { CliProviderExecutor } from "../../provider/local"
import type { ProviderTarget } from "../../provider/target"
import type { TuiAction } from "../state/types"
import { runProvider, type ProviderControllerDeps } from "./provider-controller"
import { runLimits } from "./limits-controller"

const NOW = 1_700_000_000_000

const PROFILE: ProviderOperationProfile = {
  providerId: "openai",
  computedAt: NOW,
  cells: [
    { operationId: "models.list", support: "native", availability: "ready" },
    {
      operationId: "batches.create",
      support: "unsupported",
      availability: "unavailable",
      reason: "no batch API",
    },
  ],
}

function fakeExecutor(overrides: Partial<Record<string, unknown>> = {}): CliProviderExecutor {
  return {
    execute: jest.fn(async (operationId, providerId) => {
      if (operationId in overrides) return overrides[operationId]
      switch (operationId) {
        case "models.list":
          return {
            ok: true,
            operationId,
            providerId,
            support: "native",
            output: {
              models: [{ id: "gpt-4o" }, { id: "o3-mini" }],
              source: "remote-discovered",
              freshness: "fresh",
              fetchedAt: NOW,
            },
          }
        case "capabilities.read":
          return { ok: true, operationId, providerId, support: "derived", output: PROFILE }
        case "health.probe":
          return {
            ok: true,
            operationId,
            providerId,
            support: "native",
            output: {
              reachable: true,
              authenticated: true,
              capabilityVerified: true,
              durationMs: 9,
            },
          }
        case "usage.local.read":
          return { ok: true, operationId, providerId, support: "derived", output: { rows: [] } }
        default:
          throw new Error(`unexpected ${operationId}`)
      }
    }) as CliProviderExecutor["execute"],
  }
}

const emptyFs = {
  exists: () => false,
  isDirectory: () => false,
  readFile: () => null,
  writeFileAtomic: () => undefined,
  appendFile: () => undefined,
  mkdirp: () => undefined,
  readdir: () => [],
  removeFile: () => undefined,
  removeDir: () => undefined,
  writeFileExclusive: () => true,
  mtimeMs: () => null,
}

function deps(
  action: string,
  over: Partial<ProviderControllerDeps> = {}
): ProviderControllerDeps & { actions: TuiAction[] } {
  const actions: TuiAction[] = []
  const config: ResolvedConfig = {
    ...DEFAULT_RESOLVED_CONFIG,
    provider: "openai",
    cwd: "/work",
    providers: { openai: { apiKey: "sk", model: "gpt-4o" }, deepseek: { apiKey: "d" } },
  }
  return {
    dispatch: (a) => actions.push(a),
    config,
    home: "/home/u/.cognia",
    action,
    now: () => NOW,
    createExecutor: () => fakeExecutor(),
    selectTarget: () => ({ ok: true, target: { kind: "local", why: "nothing-selected" } }),
    ensureDb: async () => undefined,
    readLocalUsage: async () => [],
    fsx: emptyFs,
    modelOptions: () => ["gpt-4o"],
    actions,
    ...over,
  }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

function opened(actions: TuiAction[], kind: string) {
  return actions.filter(
    (a): a is Extract<TuiAction, { type: "OVERLAY_OPEN" }> =>
      a.type === "OVERLAY_OPEN" && a.overlay.kind === kind
  )
}

function notices(actions: TuiAction[]): string[] {
  return actions
    .filter((a): a is Extract<TuiAction, { type: "NOTICE" }> => a.type === "NOTICE")
    .map((a) => a.message)
}

const HOST_TARGET: Extract<ProviderTarget, { kind: "host" }> = {
  kind: "host",
  host: {
    name: "home",
    kind: { value: "device", source: "user-file" },
    endpoint: { value: "https://10.0.0.2:27890", source: "user-file" },
  },
  label: 'Host "home" (https://10.0.0.2:27890)',
}

function hostSelected(
  wire: "http" | "internal",
  answer: (name: string) => CommandOutcome
): Partial<ProviderControllerDeps> & { transport: HostTransport & { close: jest.Mock } } {
  const transport = {
    wire,
    label: `Cognia Host (${wire})`,
    close: jest.fn(),
    execute: jest.fn(async (name: string) => answer(name)),
    request: jest.fn(async () => ({ ok: false as const, cause: "failed" as const, message: "no" })),
  }
  return {
    transport,
    selectTarget: () => ({ ok: true, target: HOST_TARGET }),
    connect: jest.fn(async () => ({ ok: true as const, transport })),
  }
}

describe("runProvider on a selected Host", () => {
  it("balance: loads what the Host last measured into the panel and says who answered", async () => {
    const host = hostSelected("http", () => ({
      ok: true,
      result: {
        capturedAt: NOW,
        jobs: [],
        balanceSnapshots: [
          {
            providerId: "deepseek",
            sourceId: "deepseek:official",
            amounts: [{ unit: "CNY", remaining: 42 }],
            fetchedAt: NOW - 1000,
            staleAt: NOW + 1000,
          },
        ],
        balanceSources: [],
      },
    }))
    const loadLimits = jest.fn()
    const d = deps("balance", { ...host, loadLimits })
    await runProvider(d)
    await flush()
    await flush()
    expect(loadLimits).not.toHaveBeenCalled()
    const loaded = d.actions.find(
      (a): a is Extract<TuiAction, { type: "LIMITS_LOADED" }> => a.type === "LIMITS_LOADED"
    )
    expect(loaded?.snapshots).toEqual([
      expect.objectContaining({
        provider: "deepseek",
        meters: [expect.objectContaining({ remaining: 42, currency: "CNY" })],
      }),
    ])
    expect(notices(d.actions).at(-1)).toMatch(/^Answered by: Host "home"/)
    expect(host.transport.close).toHaveBeenCalled()
  })

  it("balance: a Host that cannot be reached lands as an error snapshot naming it", async () => {
    const d = deps("balance", {
      selectTarget: () => ({ ok: true, target: HOST_TARGET }),
      connect: jest.fn(async () => ({
        ok: false as const,
        failure: { error: "host home has no tenant id", cause: "auth" as const },
      })),
    })
    await runProvider(d)
    await flush()
    await flush()
    const loaded = d.actions.find(
      (a): a is Extract<TuiAction, { type: "LIMITS_LOADED" }> => a.type === "LIMITS_LOADED"
    )
    expect(loaded?.snapshots[0]).toMatchObject({
      accountLabel: HOST_TARGET.label,
      error: expect.stringContaining("host home has no tenant id"),
    })
  })

  it("probe: a headless Host probes the model through its gateway", async () => {
    const host = hostSelected("internal", () => ({
      ok: true,
      result: [{ providerId: "groq", modelId: "llama", ok: true, latencyMs: 5 }],
    }))
    const d = deps("probe", { ...host, arg: "llama" })
    await runProvider(d)
    const doc = opened(d.actions, "document")[0]!.overlay as { body: string }
    expect(doc.body).toContain(`Answered by: ${HOST_TARGET.label}`)
    expect(doc.body).toContain("| ok | groq | `llama` | 5ms |")
    expect(host.transport.close).toHaveBeenCalled()
  })

  it("probe: a paired Host needs the CLI's lease, so the panel says how instead of probing here", async () => {
    const host = hostSelected("http", () => ({ ok: true, result: {} }))
    const createExecutor = jest.fn(() => fakeExecutor())
    const d = deps("probe", { ...host, createExecutor })
    await runProvider(d)
    expect(notices(d.actions).at(-1)).toMatch(/runs a probe as a diagnostics job for one provider/)
    expect(host.transport.execute).not.toHaveBeenCalled()
    expect(opened(d.actions, "document")).toEqual([])
  })

  it("capabilities: answers here and notes the selected Host", async () => {
    const d = deps("capabilities", { selectTarget: () => ({ ok: true, target: HOST_TARGET }) })
    await runProvider(d)
    const doc = opened(d.actions, "document")[0]!.overlay as { body: string }
    expect(doc.body).toContain("Answered by: this machine")
    expect(doc.body).toContain(`Note: ${HOST_TARGET.label} is selected`)
  })

  it("a selection that names a missing Host is reported, and nothing runs", async () => {
    const createExecutor = jest.fn(() => fakeExecutor())
    const d = deps("usage", {
      createExecutor,
      selectTarget: () => ({
        ok: false,
        failure: { error: 'no host named "work"', cause: "invalid-request" },
      }),
    })
    await runProvider(d)
    expect(notices(d.actions).at(-1)).toContain('Error: no host named "work"')
    expect(opened(d.actions, "document")).toEqual([])
  })
})

describe("runProvider", () => {
  it("rejects an unknown verb with the list of verbs", async () => {
    const d = deps("frobnicate")
    await runProvider(d)
    expect(notices(d.actions)[0]).toMatch(/Unknown \/provider verb "frobnicate".*models, balance/)
  })

  it("models: seeds the real switcher from the catalog, then refreshes it with the inventory", async () => {
    const d = deps("models")
    await runProvider(d)
    expect(opened(d.actions, "model")[0]!.overlay).toEqual({
      kind: "model",
      options: ["gpt-4o"],
      index: 0,
      query: "",
    })
    await flush()
    expect(d.actions.at(-1)).toEqual({
      type: "OVERLAY_REFRESH_MODEL_OPTIONS",
      options: ["gpt-4o", "o3-mini"],
    })
  })

  it("models: a provider that refuses the listing says so instead of refreshing", async () => {
    const d = deps("models", {
      createExecutor: () =>
        fakeExecutor({
          "models.list": {
            ok: false,
            operationId: "models.list",
            availability: "needs-auth",
            failure: { code: "authentication", retryable: false, message: "no key" },
          },
        }),
    })
    await runProvider(d)
    await flush()
    expect(d.actions.some((a) => a.type === "OVERLAY_REFRESH_MODEL_OPTIONS")).toBe(false)
    expect(notices(d.actions)).toContain("openai: needs-auth: no key")
  })

  it("balance: uses the active Codex account without probing the saved built-in provider", async () => {
    const loadCodexLimits = jest.fn(async () => [
      { provider: "codex", accountId: "codex", fetchedAt: NOW, meters: [] },
    ])
    const loadLimits = jest.fn(async () => [])
    const createExecutor = jest.fn()
    const d = deps("balance", {
      config: {
        ...DEFAULT_RESOLVED_CONFIG,
        provider: "deepseek",
        agentBackend: "codex",
        cwd: "/work",
      },
      presetId: "codex-app-server",
      backendAgentId: "live-agent",
      loadCodexLimits,
      loadLimits,
      createExecutor,
    })
    await runProvider(d)
    expect(opened(d.actions, "limits")[0]!.overlay).toMatchObject({ activeProvider: "codex" })
    expect(loadCodexLimits).toHaveBeenCalledWith("live-agent", NOW, d.config.locale)
    expect(loadLimits).not.toHaveBeenCalled()
    expect(createExecutor).not.toHaveBeenCalled()
  })

  it("allocates distinct panel requests across /limits and /balance", async () => {
    const d = deps("balance", { loadLimits: async () => [] })
    runLimits({ config: d.config, dispatch: d.dispatch, loadLimits: async () => [] })
    await runProvider(d)
    const panels = opened(d.actions, "limits").map(({ overlay }) => overlay)
    expect(panels).toHaveLength(2)
    expect(panels[0].kind === "limits" && panels[0].requestId).not.toBe(
      panels[1].kind === "limits" && panels[1].requestId
    )
  })

  it("balance: opens the limits panel loading, then loads only balance meters", async () => {
    const snapshots: ProviderLimits[] = [
      {
        provider: "deepseek",
        accountId: "deepseek",
        fetchedAt: NOW,
        meters: [
          {
            id: "credit",
            kind: "balance",
            usedPct: null,
            remaining: 8.5,
            currency: "USD",
            status: "ok",
          },
          { id: "session", kind: "window", usedPct: 10, status: "ok" },
        ],
      },
    ]
    const loadLimits = jest.fn(async () => snapshots)
    const d = deps("balance", { loadLimits, usageHistory: [1000] })
    await runProvider(d)
    const panel = opened(d.actions, "limits")[0]!.overlay
    expect(panel).toMatchObject({
      kind: "limits",
      snapshots: [],
      loading: true,
      now: NOW,
      activeProvider: "openai",
    })
    const requestId = (panel as { requestId: number }).requestId
    await flush()
    const loaded = d.actions.find(
      (a): a is Extract<TuiAction, { type: "LIMITS_LOADED" }> => a.type === "LIMITS_LOADED"
    )!
    expect(loaded.requestId).toBe(requestId)
    expect(loaded.snapshots[0]!.meters.map((m) => m.id)).toEqual(["credit"])
    expect(notices(d.actions)).toContain("deepseek: Credit balance $8.50 left")
  })

  it("balance: a thrown enumerator lands as an error snapshot, never a stuck spinner", async () => {
    const d = deps("balance", {
      loadLimits: async () => {
        throw new Error("network down")
      },
    })
    await runProvider(d)
    await flush()
    const loaded = d.actions.find(
      (a): a is Extract<TuiAction, { type: "LIMITS_LOADED" }> => a.type === "LIMITS_LOADED"
    )!
    expect(loaded.snapshots[0]).toMatchObject({ provider: "openai", error: "network down" })
  })

  it("usage: renders the usage document for the whole config or one provider", async () => {
    const d = deps("usage")
    await runProvider(d)
    const doc = opened(d.actions, "document")[0]!.overlay as { title: string; body: string }
    expect(doc.title).toBe("Provider usage")
    expect(doc.body).toContain("# Provider usage")
    expect(doc.body).toContain("Recorded ledger (exact attribution)")

    const scoped = deps("usage", { arg: "deepseek" })
    await runProvider(scoped)
    expect((opened(scoped.actions, "document")[0]!.overlay as { title: string }).title).toBe(
      "Usage · deepseek"
    )
  })

  it("refuses a provider id that is not configured", async () => {
    const d = deps("capabilities", { arg: "ghost" })
    await runProvider(d)
    expect(opened(d.actions, "document")).toHaveLength(0)
    expect(notices(d.actions)[0]).toMatch(/Provider "ghost" is not configured/)
  })

  it("capabilities: renders the profile table, answered by this machine", async () => {
    const d = deps("capabilities")
    await runProvider(d)
    const doc = opened(d.actions, "document")[0]!.overlay as { body: string }
    expect(doc.body).toContain("Answered by: this machine (its own configuration and credentials)")
    expect(doc.body).toContain("## openai")
    expect(doc.body).toContain("## deepseek")
    expect(doc.body).toContain("| `batches.create` | unsupported | unavailable | no batch API |")
  })

  it("inspect: defaults to the active provider and combines models with operations", async () => {
    const d = deps("inspect")
    await runProvider(d)
    const doc = opened(d.actions, "document")[0]!.overlay as { title: string; body: string }
    expect(doc.title).toBe("Provider · openai")
    expect(doc.body).toContain("2 models (remote-discovered, fresh")
    expect(doc.body).toContain("- `gpt-4o`")
    expect(doc.body).toContain("1 served · 1 unsupported · 0 unknown")
  })

  it("probe: probes every provider locally and renders the rows", async () => {
    const d = deps("probe")
    await runProvider(d)
    expect(notices(d.actions)[0]).toMatch(/one real request each/)
    const doc = opened(d.actions, "document")[0]!.overlay as { body: string }
    expect(doc.body).toContain("| ok | openai | 9ms | yes |")
    expect(doc.body).toContain("| ok | deepseek | 9ms | yes |")
  })

  it("reports a thrown verb as an error notice", async () => {
    const d = deps("inspect", {
      createExecutor: () => ({
        execute: async () => {
          throw new Error("executor exploded")
        },
      }),
    })
    await runProvider(d)
    expect(notices(d.actions).at(-1)).toBe("Inspecting openai failed: executor exploded")
  })
})

it.each(["claude-code", "builtin"])(
  "balance uses pushed native quotas for %s without creating a provider executor",
  async (backend) => {
    const createExecutor = jest.fn()
    const d = deps("balance", {
      config: {
        ...DEFAULT_RESOLVED_CONFIG,
        cwd: "/work",
        provider: "anthropic",
        agentBackend: backend,
      },
      agentRateLimits: { five_hour: { kind: "rate-limit", status: "allowed", utilization: 0.32 } },
      createExecutor,
    })
    await runProvider(d)
    await flush()
    expect(createExecutor).not.toHaveBeenCalled()
    expect(d.actions.find((action) => action.type === "LIMITS_LOADED")).toMatchObject({
      snapshots: [expect.objectContaining({ meters: [expect.objectContaining({ usedPct: 32 })] })],
    })
  }
)
