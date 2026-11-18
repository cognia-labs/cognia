/**
 * @jest-environment node
 */
import type { CommandOutcome, HostTransport, RequestOptions } from "../api/transport"
import type { ResolvedHost } from "../host/resolve"
import {
  GATEWAY_PROBE_COMMAND,
  HOST_HISTORY_COMMAND,
  HOST_START_COMMAND,
  HOST_STATUS_COMMAND,
  callHost,
  hostBalanceLimits,
  probeOnHost,
  readHostBalance,
} from "./host"
import type { ProviderTarget } from "./target"

const HOST: ResolvedHost = {
  name: "home",
  kind: { value: "device", source: "user-file" },
  endpoint: { value: "https://10.0.0.2:27890", source: "user-file" },
}
const TARGET: Extract<ProviderTarget, { kind: "host" }> = {
  kind: "host",
  host: HOST,
  label: 'Host "home" (https://10.0.0.2:27890)',
}
const NOW = Date.parse("2026-11-18T12:00:00Z")

type Call = { name: string; args: Record<string, unknown>; options?: RequestOptions }

function fakeTransport(
  wire: "http" | "internal",
  answer: (call: Call) => CommandOutcome
): HostTransport & { calls: Call[] } {
  const calls: Call[] = []
  return {
    wire,
    label: `fake ${wire} Host`,
    calls,
    execute: jest.fn(async (name: string, args: Record<string, unknown> = {}, options?) => {
      const call = { name, args, ...(options ? { options } : {}) }
      calls.push(call)
      return answer(call)
    }),
    request: jest.fn(async () => ({ ok: false as const, cause: "failed" as const, message: "no" })),
  }
}

const STATUS = {
  capturedAt: NOW - 1000,
  desktopRevision: 3,
  stale: false,
  jobs: [],
  balanceSnapshots: [
    {
      id: "b1",
      providerId: "openai",
      sourceId: "openai:official",
      credentialFingerprint: "fp",
      amounts: [{ unit: "USD", remaining: 8, total: 10 }],
      fetchedAt: NOW - 60_000,
      staleAt: NOW - 1,
    },
    {
      id: "b2",
      providerId: "deepseek",
      sourceId: "deepseek:script",
      accountId: "work",
      credentialFingerprint: "fp2",
      amounts: [
        { unit: "CNY", remaining: 0 },
        { unit: "tokens", remaining: 5000 },
      ],
      fetchedAt: NOW - 5000,
      staleAt: NOW + 60_000,
    },
    {
      id: "b3",
      providerId: "deepseek",
      sourceId: "deepseek:official",
      credentialFingerprint: "fp3",
      amounts: [],
      fetchedAt: NOW - 5000,
      staleAt: NOW + 60_000,
      failure: { code: "authentication", retryable: false, message: "key revoked" },
    },
    {
      id: "b4",
      providerId: "groq",
      sourceId: "groq:unsupported",
      credentialFingerprint: "fp4",
      amounts: [],
      fetchedAt: NOW - 5000,
      staleAt: NOW + 60_000,
    },
  ],
  balanceSources: [
    { id: "openai:official", providerId: "openai", label: "Official", primary: true },
    {
      id: "deepseek:script",
      providerId: "deepseek",
      accountId: "work",
      label: "Balance script",
      primary: false,
    },
    { id: "deepseek:official", providerId: "deepseek", label: "Official", primary: true },
  ],
}

describe("hostBalanceLimits", () => {
  it("projects the Host's snapshots onto balance meters, primary source first", () => {
    const { snapshots, silent } = hostBalanceLimits(STATUS, NOW)
    expect(snapshots.map((s) => s.accountLabel)).toEqual([
      "deepseek · Official (primary)",
      "deepseek · Balance script · account work",
      "openai · Official (primary)",
    ])
    expect(silent).toEqual(["groq"])

    const [failed, script, openai] = snapshots
    expect(failed!.error).toBe("authentication: key revoked")
    expect(failed!.meters).toEqual([])

    expect(script!.meters.map((m) => [m.label, m.status, m.currency])).toEqual([
      ["Balance script (CNY)", "exceeded", "CNY"],
      ["Balance script (tokens)", "ok", undefined],
    ])
    expect(script!.notice).toBe(`measured by the Host ${new Date(NOW - 5000).toISOString()}`)

    expect(openai!.meters).toEqual([
      expect.objectContaining({
        id: "openai:official:USD",
        label: "Official",
        kind: "balance",
        remaining: 8,
        total: 10,
        currency: "USD",
        usedPct: 20,
        status: "ok",
      }),
    ])
    expect(openai!.meters[0]).not.toHaveProperty("labelKey")
    expect(openai!.notice).toBe(
      `measured by the Host ${new Date(NOW - 60_000).toISOString()}, stale since ${new Date(NOW - 1).toISOString()}`
    )
  })

  it("ignores malformed rows instead of inventing meters", () => {
    expect(
      hostBalanceLimits(
        { balanceSnapshots: [{ providerId: "x" }, "junk", { sourceId: "s", fetchedAt: 1 }] },
        NOW
      )
    ).toEqual({ snapshots: [], silent: [] })
    expect(hostBalanceLimits(null, NOW)).toEqual({ snapshots: [], silent: [] })
  })
})

describe("readHostBalance", () => {
  it("reads provider_diagnostics_status, narrowed to --provider", async () => {
    const transport = fakeTransport("http", () => ({ ok: true, result: STATUS }))
    const result = await readHostBalance({
      transport,
      target: TARGET,
      providerId: "openai",
      now: () => NOW,
    })
    expect(transport.calls.map((c) => [c.name, c.args])).toEqual([
      [HOST_STATUS_COMMAND, { providerId: "openai" }],
    ])
    if (!result.ok) throw new Error(result.failure.error)
    expect(result.report).toMatchObject({
      verb: "balance",
      answeredBy: { plane: "host", label: TARGET.label },
      fetchedAt: NOW - 1000,
    })
  })

  it("reports the Host's refusal of a device it does not let control it", async () => {
    const transport = fakeTransport("http", () => ({
      ok: false,
      cause: "failed",
      status: 500,
      message: "paired device is not permitted to run provider diagnostics",
    }))
    const result = await readHostBalance({ transport, target: TARGET, now: () => NOW })
    expect(result).toMatchObject({
      ok: false,
      failure: {
        error: `${HOST_STATUS_COMMAND} on fake http Host: paired device is not permitted to run provider diagnostics`,
        fix: [
          "on the Host, allow remote control for this paired device",
          "or pass --local to answer from this machine",
        ],
      },
    })
  })
})

describe("callHost", () => {
  it("names an older Host that lacks the command", async () => {
    const transport = fakeTransport("internal", () => ({
      ok: false,
      cause: "unknown-command",
      code: "unknown_command",
      status: 404,
      message: "no such command",
    }))
    const result = await callHost(HOST_STATUS_COMMAND, {}, { transport })
    expect(result).toMatchObject({
      ok: false,
      failure: {
        fix: [`this Host predates ${HOST_STATUS_COMMAND}; update the Host`, "or pass --local"],
      },
    })
  })

  it("refuses a command the wire does not carry before sending it", async () => {
    const transport = fakeTransport("http", () => ({ ok: true, result: [] }))
    const result = await callHost(GATEWAY_PROBE_COMMAND, { model: "m" }, { transport })
    expect(result).toMatchObject({ ok: false, failure: { cause: "unknown-command" } })
    expect(transport.calls).toEqual([])
  })
})

describe("probeOnHost through the gateway (service token)", () => {
  it("needs a model, because the gateway routes by model", async () => {
    const transport = fakeTransport("internal", () => ({ ok: true, result: [] }))
    const result = await probeOnHost({ transport, target: TARGET })
    expect(result).toMatchObject({ ok: false, usage: true, failure: { cause: "invalid-request" } })
    expect(transport.calls).toEqual([])
  })

  it("probes the model's candidates with a minted idempotency key, narrowed to --provider", async () => {
    const transport = fakeTransport("internal", () => ({
      ok: true,
      result: [
        { providerId: "groq", modelId: "llama", ok: true, status: 200, latencyMs: 4 },
        { providerId: "openai", modelId: "llama", ok: false, latencyMs: 8, error: "401" },
        "junk",
      ],
    }))
    const result = await probeOnHost({
      transport,
      target: TARGET,
      model: "llama",
      providerId: "groq",
      newId: () => "00000000-0000-4000-8000-000000000001",
    })
    expect(transport.calls).toEqual([
      expect.objectContaining({
        name: GATEWAY_PROBE_COMMAND,
        args: { model: "llama" },
        options: expect.objectContaining({
          idempotencyKey: "00000000-0000-4000-8000-000000000001",
        }),
      }),
    ])
    if (!result.ok) throw new Error(result.failure.error)
    expect(result.report).toEqual({
      via: "gateway",
      answeredBy: { plane: "host", label: TARGET.label },
      model: "llama",
      providerFilter: "groq",
      rows: [{ providerId: "groq", modelId: "llama", ok: true, status: 200, latencyMs: 4 }],
    })
  })
})

describe("probeOnHost through a diagnostics job (paired device)", () => {
  const PROBE = {
    reachable: true,
    authenticated: true,
    capabilityVerified: true,
    durationMs: 42,
    httpStatus: 200,
  }

  function clock() {
    let now = NOW
    return {
      now: () => now,
      sleep: jest.fn(async (ms: number) => {
        now += ms
      }),
    }
  }

  it("needs --provider and an approval lease before it sends anything", async () => {
    const transport = fakeTransport("http", () => ({ ok: true, result: {} }))
    const noProvider = await probeOnHost({ transport, target: TARGET, adminLease: "l" })
    expect(noProvider).toMatchObject({ ok: false, usage: true })
    const noLease = await probeOnHost({ transport, target: TARGET, providerId: "openai" })
    expect(noLease).toMatchObject({
      ok: false,
      usage: true,
      failure: {
        fix: [
          `cognia-agent api call host_admin_lease_issue --operations '["${HOST_START_COMMAND}"]' --host home`,
          "then pass --admin-lease <lease>",
        ],
      },
    })
    expect(transport.calls).toEqual([])
  })

  it("starts one one-request job, waits for it, and reads its samples", async () => {
    const { now, sleep } = clock()
    let polls = 0
    const transport = fakeTransport("http", ({ name }) => {
      if (name === HOST_START_COMMAND)
        return { ok: true, result: { accepted: true, jobId: "job-1" } }
      if (name === HOST_STATUS_COMMAND) {
        polls += 1
        return {
          ok: true,
          result: {
            jobs: [
              { id: "job-1", providerId: "openai", status: polls < 2 ? "running" : "completed" },
            ],
          },
        }
      }
      return {
        ok: true,
        result: {
          samples: [
            { jobId: "job-0", providerId: "openai", status: "failed" },
            {
              jobId: "job-1",
              providerId: "openai",
              modelId: "gpt-4o",
              status: "completed",
              probe: PROBE,
            },
          ],
        },
      }
    })
    const result = await probeOnHost({
      transport,
      target: TARGET,
      providerId: "openai",
      model: "gpt-4o",
      adminLease: "lease-1",
      now,
      sleep,
    })
    expect(transport.calls.map((c) => c.name)).toEqual([
      HOST_START_COMMAND,
      HOST_STATUS_COMMAND,
      HOST_STATUS_COMMAND,
      HOST_HISTORY_COMMAND,
    ])
    expect(transport.calls[0]!.args).toEqual({
      targets: [{ providerId: "openai", modelId: "gpt-4o", capability: "probe" }],
      mode: "quick",
      confirmedRequestLimit: 1,
      confirmedMaxEstimatedCostUsd: 0,
      adminLease: "lease-1",
    })
    expect(transport.calls[3]!.args).toEqual({ providerId: "openai", limit: 50 })
    expect(sleep).toHaveBeenCalledTimes(1)
    if (!result.ok) throw new Error(result.failure.error)
    expect(result.report).toEqual({
      via: "host-job",
      answeredBy: { plane: "host", label: TARGET.label },
      providerId: "openai",
      model: "gpt-4o",
      jobId: "job-1",
      status: "completed",
      settled: true,
      rows: [{ providerId: "openai", modelId: "gpt-4o", status: "completed", probe: PROBE }],
    })
  })

  it("settles from the samples when a newer job hides this one from the status", async () => {
    const transport = fakeTransport("http", ({ name }) => {
      if (name === HOST_START_COMMAND)
        return { ok: true, result: { accepted: true, jobId: "job-1" } }
      if (name === HOST_STATUS_COMMAND)
        return {
          ok: true,
          result: { jobs: [{ id: "job-2", providerId: "openai", status: "running" }] },
        }
      return {
        ok: true,
        result: {
          samples: [{ jobId: "job-1", providerId: "openai", status: "completed", probe: PROBE }],
        },
      }
    })
    const result = await probeOnHost({
      transport,
      target: TARGET,
      providerId: "openai",
      adminLease: "lease-1",
      ...clock(),
    })
    if (!result.ok) throw new Error(result.failure.error)
    expect(result.report).toMatchObject({ via: "host-job", status: "completed", settled: true })
  })

  it("stops waiting at the deadline and says the job is still running", async () => {
    const { now, sleep } = clock()
    const transport = fakeTransport("http", ({ name }) =>
      name === HOST_START_COMMAND
        ? { ok: true, result: { accepted: true, jobId: "job-1" } }
        : { ok: true, result: { jobs: [{ id: "job-1", providerId: "openai", status: "running" }] } }
    )
    const result = await probeOnHost({
      transport,
      target: TARGET,
      providerId: "openai",
      adminLease: "lease-1",
      waitMs: 1200,
      now,
      sleep,
    })
    if (!result.ok) throw new Error(result.failure.error)
    expect(result.report).toMatchObject({
      via: "host-job",
      status: "running",
      settled: false,
      rows: [],
    })
    expect(transport.calls.every((c) => c.name !== HOST_HISTORY_COMMAND)).toBe(true)
  })

  it("reports a start the Host refused", async () => {
    const transport = fakeTransport("http", () => ({
      ok: false,
      cause: "refused",
      status: 428,
      code: "interactive_approval_required",
      message: "a current device-bound approval lease is required",
    }))
    const result = await probeOnHost({
      transport,
      target: TARGET,
      providerId: "openai",
      adminLease: "expired",
    })
    expect(result).toMatchObject({
      ok: false,
      failure: {
        cause: "refused",
        fix: [
          `cognia-agent api call host_admin_lease_issue --operations '["${HOST_START_COMMAND}"]'`,
          "then pass --admin-lease <lease>",
        ],
      },
    })
  })
})
