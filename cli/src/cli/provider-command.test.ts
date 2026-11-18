/**
 * @jest-environment node
 */
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"
import type { ProviderOperationProfile } from "@cognia/provider-types"

import type { ProviderLimits } from "@/types/subscription"

import type { CommandOutcome, HostTransport } from "../api/transport"
import type { ResolvedConfig } from "../config/schema"
import type { HostResolution, ResolvedHost } from "../host/resolve"
import type { CliProviderExecutor } from "../provider/local"
import { parseArgv } from "./args"
import { PROVIDER_HELP, providerCommand } from "./provider-command"

const CONFIG: ResolvedConfig = {
  provider: "openai",
  permissionMode: "default",
  builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
  providers: { openai: { apiKey: "sk" }, deepseek: { apiKey: "d" } },
  cwd: "/w",
}

const NOW = Date.parse("2026-09-02T12:00:00Z")

function sink() {
  const stdout: string[] = []
  const stderr: string[] = []
  const records: unknown[] = []
  return {
    out: {
      write: (t: string) => stdout.push(t),
      error: (t: string) => stderr.push(t),
      json: (v: unknown) => records.push(v),
    },
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
    records,
  }
}

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

const executor: CliProviderExecutor = {
  execute: jest.fn(async (operationId, providerId) => {
    switch (operationId) {
      case "capabilities.read":
        return {
          ok: true as const,
          operationId,
          providerId,
          support: "derived" as const,
          output: PROFILE,
        }
      case "models.list":
        return {
          ok: true as const,
          operationId,
          providerId,
          support: "native" as const,
          output: {
            models: [{ id: "gpt-4o", name: "GPT-4o", contextLength: 128_000 }],
            source: "catalog-static",
            freshness: "static",
            fetchedAt: NOW,
          },
        }
      case "health.probe":
        return {
          ok: true as const,
          operationId,
          providerId,
          support: "native" as const,
          output: {
            reachable: true,
            authenticated: true,
            capabilityVerified: true,
            durationMs: 42,
            httpStatus: 200,
          },
        }
      case "usage.local.read":
        return {
          ok: true as const,
          operationId,
          providerId,
          support: "derived" as const,
          output: { rows: [] },
        }
      default:
        throw new Error(`unexpected ${operationId}`)
    }
  }) as CliProviderExecutor["execute"],
}

const NO_HOST: HostResolution = {
  skipped: [
    { leg: "saved host", reason: "no active host is configured" },
    { leg: "environment", reason: "neither COGNIA_ENDPOINT nor COGNIA_SERVER_URL is set" },
  ],
}

const HOME_HOST: ResolvedHost = {
  name: "home",
  kind: { value: "device", source: "user-file" },
  endpoint: { value: "https://10.0.0.2:27890", source: "user-file" },
}
const HOST_SELECTED: HostResolution = { host: HOME_HOST, skipped: [] }
const HOST_LABEL = 'Host "home" (https://10.0.0.2:27890)'

function hostTransport(
  wire: "http" | "internal",
  answer: (name: string, args: Record<string, unknown>) => CommandOutcome
): HostTransport & { close: jest.Mock; names: string[] } {
  const names: string[] = []
  return {
    wire,
    label: `Cognia Host (${wire})`,
    names,
    close: jest.fn(),
    execute: jest.fn(async (name: string, args: Record<string, unknown> = {}) => {
      names.push(name)
      return answer(name, args)
    }),
    request: jest.fn(async () => ({ ok: false as const, cause: "failed" as const, message: "no" })),
  }
}

function connecting(transport: HostTransport) {
  return jest.fn(async () => ({ ok: true as const, transport }))
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

function run(argv: string[], extra: Parameters<typeof providerCommand>[1] = {}) {
  const s = sink()
  const code = providerCommand(parseArgv(argv), {
    out: s.out,
    loadConfig: () => CONFIG,
    resolveHost: () => NO_HOST,
    home: "/home/u/.cognia",
    cwd: "/w",
    connect: jest.fn(async () => {
      throw new Error("no Host should be contacted")
    }),
    createExecutor: () => executor,
    now: () => NOW,
    env: { COGNIA_HOME: "/home/u/.cognia" },
    ensureDb: async () => undefined,
    fsx: emptyFs,
    ...extra,
  })
  return { ...s, code }
}

describe("providerCommand", () => {
  beforeEach(() => jest.clearAllMocks())

  it("prints help on --help and usage on a missing or unknown verb", async () => {
    const help = run(["provider", "--help"])
    expect(await help.code).toBe(0)
    expect(help.stdout()).toBe(PROVIDER_HELP)

    const missing = run(["provider"])
    expect(await missing.code).toBe(2)
    expect(missing.stderr()).toContain("provider capabilities")

    const unknown = run(["provider", "frobnicate"])
    expect(await unknown.code).toBe(2)
    expect(unknown.stderr()).toMatch(/Unknown provider verb: "frobnicate"/)
  })

  it("refuses billed reads here without --live and a probe without --yes, before any Host", async () => {
    const connect = jest.fn()
    for (const verb of ["balance", "limits", "probe"]) {
      const r = run(["provider", verb], { connect })
      expect(await r.code).toBe(2)
      expect(r.stderr()).toMatch(/--live/)
    }
    const probe = run(["provider", "probe", "--live"], { connect })
    expect(await probe.code).toBe(2)
    expect(probe.stderr()).toMatch(/--yes/)
    // A probe spends on the Host too, so it is gated there as well.
    const hostProbe = run(["provider", "probe", "--live"], {
      connect,
      resolveHost: () => HOST_SELECTED,
    })
    expect(await hostProbe.code).toBe(2)
    expect(connect).not.toHaveBeenCalled()
  })

  it("rejects --local with a Host, and a named Host that does not exist", async () => {
    const both = run(["provider", "models", "--local", "--host", "home"])
    expect(await both.code).toBe(2)
    expect(both.stderr()).toMatch(/--local answers from this machine/)

    const missing = run(["provider", "balance"], {
      resolveHost: () => ({
        skipped: [{ leg: "named host", reason: 'no host named "work" (known: home)' }],
      }),
    })
    expect(await missing.code).toBe(2)
    expect(missing.stderr()).toContain('no host named "work" (known: home)')
  })

  it("rejects an unknown --operation or --provider", async () => {
    const operation = run(["provider", "capabilities", "--operation", "nope.nothing"])
    expect(await operation.code).toBe(2)
    expect(operation.stderr()).toMatch(/Unknown operation "nope.nothing"/)

    const provider = run(["provider", "capabilities", "--provider", "ghost"])
    expect(await provider.code).toBe(2)
    expect(provider.stderr()).toMatch(/not configured/)
  })

  it("reports a config error as exit 2", async () => {
    const r = run(["provider", "models"], {
      loadConfig: () => {
        throw new Error("config.json is not valid JSON")
      },
    })
    expect(await r.code).toBe(2)
    expect(r.stderr()).toMatch(/Config error: config.json/)
  })

  it("capabilities: lists every cell per provider, answered by this machine", async () => {
    const r = run(["provider", "capabilities"])
    expect(await r.code).toBe(0)
    const text = r.stdout()
    expect(text).toContain("Answered by: this machine (its own configuration and credentials)")
    expect(text).not.toContain("Note:")
    expect(text).toMatch(/Contract v1: 50 operations/)
    expect(text).toContain("\nopenai\n")
    expect(text).toContain("\ndeepseek\n")
    expect(text).toContain("batches.create           unsupported unavailable  no batch API")
  })

  it("capabilities --json --operation: one record, filtered cells", async () => {
    const r = run([
      "provider",
      "capabilities",
      "--json",
      "--provider",
      "openai",
      "--operation",
      "models.list",
    ])
    expect(await r.code).toBe(0)
    expect(r.stdout()).toBe("")
    expect(r.records).toHaveLength(1)
    const record = r.records[0] as {
      verb: string
      operationFilter: string
      providers: Array<{ providerId: string; profile: ProviderOperationProfile }>
    }
    expect(record.verb).toBe("capabilities")
    expect(record.operationFilter).toBe("models.list")
    expect(record.providers.map((p) => p.providerId)).toEqual(["openai"])
    expect(record.providers[0]!.profile.cells.map((c) => c.operationId)).toEqual(["models.list"])
  })

  it("models: forwards --refresh and prints the inventory line", async () => {
    const r = run(["provider", "models", "--refresh"])
    expect(await r.code).toBe(0)
    expect(executor.execute).toHaveBeenCalledWith("models.list", "openai", { refresh: true }, {})
    expect(r.stdout()).toContain(
      "openai: 1 models (catalog-static, static, fetched 2026-09-02T12:00:00.000Z)"
    )
    expect(r.stdout()).toContain("  gpt-4o  GPT-4o  128k ctx")
  })

  it("balance/limits --live: run the shared enumerator once and print meters", async () => {
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
            remaining: 3,
            total: 10,
            currency: "USD",
            status: "ok",
          },
          { id: "session", kind: "window", usedPct: 10, status: "ok" },
        ],
      },
    ]
    const loadLimits = jest.fn(async () => snapshots)
    const balance = run(["provider", "balance", "--live"], { loadLimits })
    expect(await balance.code).toBe(0)
    expect(loadLimits).toHaveBeenCalledWith(CONFIG, NOW)
    expect(balance.stdout()).toContain("credit             3 USD of 10 USD remaining  [ok]")
    expect(balance.stdout()).not.toContain("session")

    const limits = run(["provider", "limits", "--live", "--json"], { loadLimits })
    expect(await limits.code).toBe(0)
    expect(
      (limits.records[0] as { snapshots: ProviderLimits[] }).snapshots[0]!.meters.map((m) => m.id)
    ).toEqual(["session"])
  })

  it("balance: exit 1 when a snapshot carries an error", async () => {
    const loadLimits = async (): Promise<ProviderLimits[]> => [
      { provider: "openai", accountId: "openai", fetchedAt: NOW, meters: [], error: "HTTP 401" },
    ]
    const r = run(["provider", "balance", "--live"], { loadLimits })
    expect(await r.code).toBe(1)
    expect(r.stdout()).toContain("error: HTTP 401")
  })

  it("usage: reads the ledger over the given window and says how rows were attributed", async () => {
    const r = run(["provider", "usage", "--days", "3"])
    expect(await r.code).toBe(0)
    expect(executor.execute).toHaveBeenCalledWith("usage.local.read", "openai", {
      from: NOW - 3 * 86_400_000,
      to: NOW,
      providerId: "openai",
    })
    expect(r.stdout()).toContain("Usage 2026-08-30 to 2026-09-02")
    expect(r.stdout()).toContain("Recorded ledger (exact attribution)")
    expect(r.stdout()).toContain("CLI sessions (0 in window, 0 without usage)")
  })

  it("usage: rejects a non-positive --days", async () => {
    const r = run(["provider", "usage", "--days", "0"])
    expect(await r.code).toBe(2)
    expect(r.stderr()).toMatch(/--days must be a positive number/)
  })

  it.each(["capabilities", "models", "usage"])(
    "%s: answers from this machine while a Host is selected, and says why",
    async (verb) => {
      const connect = jest.fn()
      const r = run(["provider", verb], { connect, resolveHost: () => HOST_SELECTED })
      expect(await r.code).toBe(0)
      expect(r.stdout()).toContain("Answered by: this machine")
      expect(r.stdout()).toMatch(
        new RegExp(
          `Note: ${HOST_LABEL.replace(/[()]/g, "\\$&")} is selected, but .+, so this machine answered`
        )
      )
      expect(connect).not.toHaveBeenCalled()
    }
  )

  it("limits: answers here while a Host is selected, because a Host keeps no window meters", async () => {
    const loadLimits = jest.fn(async (): Promise<ProviderLimits[]> => [])
    const r = run(["provider", "limits", "--live"], {
      loadLimits,
      resolveHost: () => HOST_SELECTED,
    })
    expect(await r.code).toBe(0)
    expect(loadLimits).toHaveBeenCalled()
    expect(r.stdout()).toContain("a Host keeps no usage-window meters")
  })

  it("models --json names this machine as the answer and the Host that was selected", async () => {
    const r = run(["provider", "models", "--json"], { resolveHost: () => HOST_SELECTED })
    expect(await r.code).toBe(0)
    expect(r.records[0]).toMatchObject({
      answeredBy: { plane: "local" },
      selectedHost: HOST_LABEL,
    })
  })

  it("balance on a Host: reads what it last measured, with no --live, and closes the transport", async () => {
    const transport = hostTransport("http", () => ({
      ok: true,
      result: {
        capturedAt: NOW,
        jobs: [],
        balanceSnapshots: [
          {
            providerId: "deepseek",
            sourceId: "deepseek:official",
            amounts: [{ unit: "CNY", remaining: 42 }],
            fetchedAt: NOW - 60_000,
            staleAt: NOW + 60_000,
          },
        ],
        balanceSources: [
          { id: "deepseek:official", providerId: "deepseek", label: "Official", primary: true },
        ],
      },
    }))
    const connect = connecting(transport)
    const loadLimits = jest.fn()
    const r = run(["provider", "balance", "--provider", "deepseek"], {
      connect,
      loadLimits,
      resolveHost: () => HOST_SELECTED,
    })
    expect(await r.code).toBe(0)
    expect(connect).toHaveBeenCalledWith(HOME_HOST, {})
    expect(transport.execute).toHaveBeenCalledWith(
      "provider_diagnostics_status",
      { providerId: "deepseek" },
      expect.anything()
    )
    expect(loadLimits).not.toHaveBeenCalled()
    const text = r.stdout()
    expect(text).toContain(`Answered by: ${HOST_LABEL}`)
    expect(text).toContain("deepseek · Official (primary)")
    expect(text).toContain(`measured by the Host ${new Date(NOW - 60_000).toISOString()}`)
    expect(text).toContain("Official           42 CNY remaining  [ok]")
    expect(transport.close).toHaveBeenCalled()
  })

  it("balance on a Host: says when the Host has measured nothing, and --local reads here", async () => {
    const transport = hostTransport("http", () => ({
      ok: true,
      result: { capturedAt: NOW, jobs: [], balanceSnapshots: [], balanceSources: [] },
    }))
    const r = run(["provider", "balance"], {
      connect: connecting(transport),
      resolveHost: () => HOST_SELECTED,
    })
    expect(await r.code).toBe(0)
    expect(r.stdout()).toContain("The Host has measured no balance yet.")

    const loadLimits = jest.fn(async (): Promise<ProviderLimits[]> => [])
    const local = run(["provider", "balance", "--local", "--live"], {
      loadLimits,
      resolveHost: () => HOST_SELECTED,
    })
    expect(await local.code).toBe(0)
    expect(loadLimits).toHaveBeenCalled()
    expect(local.stdout()).toContain("Answered by: this machine")
  })

  it("balance on a Host: a refusal is the Host's, exit 1, not answered here instead", async () => {
    const transport = hostTransport("http", () => ({
      ok: false,
      cause: "failed",
      status: 500,
      message: "paired device is not permitted to run provider diagnostics",
    }))
    const loadLimits = jest.fn()
    const r = run(["provider", "balance"], {
      connect: connecting(transport),
      loadLimits,
      resolveHost: () => HOST_SELECTED,
    })
    expect(await r.code).toBe(1)
    expect(r.stderr()).toContain("not permitted to run provider diagnostics")
    expect(r.stderr()).toContain("Fix: on the Host, allow remote control for this paired device")
    expect(loadLimits).not.toHaveBeenCalled()
    expect(transport.close).toHaveBeenCalled()
  })

  it("balance on a Host: a connect failure is reported, exit 1", async () => {
    const r = run(["provider", "balance"], {
      connect: jest.fn(async () => ({
        ok: false as const,
        failure: {
          error: "host home is a device host with no device identity",
          cause: "auth" as const,
        },
      })),
      resolveHost: () => HOST_SELECTED,
    })
    expect(await r.code).toBe(1)
    expect(r.stderr()).toContain("no device identity")
  })

  it("probe on a headless Host: its gateway answers, narrowed to --provider", async () => {
    const transport = hostTransport("internal", () => ({
      ok: true,
      result: [
        { providerId: "groq", modelId: "llama", ok: true, latencyMs: 5 },
        { providerId: "openai", modelId: "llama", ok: true, latencyMs: 9 },
      ],
    }))
    const r = run(
      ["provider", "probe", "--live", "--yes", "--provider", "groq", "--model", "llama"],
      { connect: connecting(transport), resolveHost: () => HOST_SELECTED }
    )
    expect(await r.code).toBe(0)
    expect(transport.execute).toHaveBeenCalledWith(
      "gateway_probe_upstream",
      { model: "llama" },
      expect.anything()
    )
    expect(r.stdout()).toContain(`Answered by: ${HOST_LABEL}`)
    expect(r.stdout()).toContain("groq")
    expect(r.stdout()).not.toMatch(/ok\s+openai/)
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it("probe on a paired Host: needs an approval lease, exit 2, nothing sent", async () => {
    const transport = hostTransport("http", () => ({ ok: true, result: {} }))
    const r = run(["provider", "probe", "--live", "--yes", "--provider", "openai"], {
      connect: connecting(transport),
      resolveHost: () => HOST_SELECTED,
    })
    expect(await r.code).toBe(2)
    expect(r.stderr()).toContain("host_admin_lease_issue")
    expect(r.stderr()).toContain("--host home")
    expect(transport.names).toEqual([])
  })

  it("probe on a paired Host: runs one diagnostics job and prints its sample", async () => {
    const transport = hostTransport("http", (name) => {
      if (name === "provider_diagnostics_start")
        return { ok: true, result: { accepted: true, jobId: "job-7" } }
      if (name === "provider_diagnostics_status")
        return { ok: true, result: { jobs: [{ id: "job-7", status: "completed" }] } }
      return {
        ok: true,
        result: {
          samples: [
            {
              jobId: "job-7",
              providerId: "openai",
              status: "completed",
              probe: {
                reachable: true,
                authenticated: true,
                capabilityVerified: true,
                durationMs: 33,
                httpStatus: 200,
              },
            },
          ],
        },
      }
    })
    const r = run(
      ["provider", "probe", "--live", "--yes", "--provider", "openai", "--admin-lease", "lease-9"],
      { connect: connecting(transport), resolveHost: () => HOST_SELECTED, sleep: async () => {} }
    )
    expect(await r.code).toBe(0)
    expect(transport.names).toEqual([
      "provider_diagnostics_start",
      "provider_diagnostics_status",
      "provider_diagnostics_history",
    ])
    expect(r.stdout()).toContain("Diagnostics job job-7 for openai: completed")
    expect(r.stdout()).toContain("ok   openai           33ms auth HTTP 200")
  })

  it("probe: refuses a provider this machine lacks when this machine answers", async () => {
    const r = run(["provider", "probe", "--live", "--yes", "--provider", "groq"])
    expect(await r.code).toBe(2)
    expect(r.stderr()).toContain(
      'Provider "groq" is not configured on this machine, which answered the probe'
    )
    expect(executor.execute).not.toHaveBeenCalledWith("health.probe", "groq", {}, {})
  })

  it("probe --live --yes: probes locally when no Host is selected", async () => {
    const r = run(["provider", "probe", "--live", "--yes", "--provider", "openai"])
    expect(await r.code).toBe(0)
    expect(executor.execute).toHaveBeenCalledWith("health.probe", "openai", {}, {})
    expect(r.stdout()).toContain("ok   openai           42ms auth HTTP 200")
  })

  it("probe --json: exit 1 when a provider is unreachable", async () => {
    const failing: CliProviderExecutor = {
      execute: jest.fn(async (operationId, providerId) => ({
        ok: true as const,
        operationId,
        providerId,
        support: "native" as const,
        output: { reachable: false, capabilityVerified: false, durationMs: 1 },
      })) as CliProviderExecutor["execute"],
    }
    const r = run(["provider", "probe", "--live", "--yes", "--json"], {
      createExecutor: () => failing,
    })
    expect(await r.code).toBe(1)
    expect((r.records[0] as { via: string }).via).toBe("local")
  })
})
