/**
 * @jest-environment node
 */
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"

import type { ResolvedConfig } from "../config/schema"
import type { CliProviderExecutor } from "./local"
import {
  formatGatewayProbeRow,
  formatHostProbeRow,
  formatLocalProbeRow,
  probeLocally,
  probeReportFailed,
  type ProviderProbeReport,
} from "./probe"
import { LOCAL_ANSWER } from "./target"

const CONFIG: ResolvedConfig = {
  provider: "openai",
  permissionMode: "default",
  builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
  providers: { openai: { apiKey: "o" }, anthropic: { apiKey: "a" } },
  cwd: "/w",
}

const executor: CliProviderExecutor = {
  execute: jest.fn(async (operationId, providerId) =>
    providerId === "anthropic"
      ? {
          ok: false as const,
          operationId,
          availability: "needs-auth" as const,
          failure: { code: "authentication" as const, retryable: false, message: "401" },
        }
      : {
          ok: true as const,
          operationId,
          providerId,
          support: "native" as const,
          output: {
            reachable: true,
            authenticated: true,
            capabilityVerified: true,
            durationMs: 120,
            httpStatus: 200,
          },
        }
  ) as CliProviderExecutor["execute"],
}

describe("probeLocally", () => {
  beforeEach(() => jest.clearAllMocks())

  it("probes every configured provider through health.probe", async () => {
    const report = await probeLocally({ config: CONFIG, executor, timeoutMs: 5000 })
    expect(report.via).toBe("local")
    if (report.via !== "local") return
    expect(report.answeredBy).toBe(LOCAL_ANSWER)
    expect(report.rows.map((r) => r.providerId)).toEqual(["openai", "anthropic"])
    expect(report.rows[0]!.result?.reachable).toBe(true)
    expect(report.rows[1]!.failure?.availability).toBe("needs-auth")
    expect(executor.execute).toHaveBeenCalledWith("health.probe", "openai", { timeoutMs: 5000 }, {})
  })

  it("probes one provider with the model it was given", async () => {
    const report = await probeLocally({
      config: CONFIG,
      executor,
      providerId: "openai",
      model: "gpt-4o",
    })
    if (report.via !== "local") throw new Error("expected a local probe")
    expect(report.rows).toEqual([
      expect.objectContaining({ providerId: "openai", model: "gpt-4o" }),
    ])
    expect(executor.execute).toHaveBeenCalledWith("health.probe", "openai", { model: "gpt-4o" }, {})
  })

  it("names a provider this machine lacks instead of probing it", async () => {
    const report = await probeLocally({ config: CONFIG, executor, providerId: "groq" })
    expect(report).toMatchObject({ via: "local", notConfigured: "groq", rows: [] })
    expect(executor.execute).not.toHaveBeenCalled()
  })
})

describe("probeReportFailed", () => {
  const passed = {
    reachable: true,
    authenticated: true,
    capabilityVerified: true,
    durationMs: 5,
  }

  it("fails a local probe that reached the provider but was refused the credential", () => {
    const report: ProviderProbeReport = {
      via: "local",
      answeredBy: LOCAL_ANSWER,
      rows: [{ providerId: "openai", result: { ...passed, authenticated: false } }],
    }
    expect(probeReportFailed(report)).toBe(true)
    expect(probeReportFailed({ ...report, rows: [{ providerId: "openai", result: passed }] })).toBe(
      false
    )
  })

  it("fails a Host job that has not settled, did not complete, or has no sample", () => {
    const base: ProviderProbeReport = {
      via: "host-job",
      answeredBy: { plane: "host", label: "Host" },
      providerId: "openai",
      jobId: "job-1",
      status: "completed",
      settled: true,
      rows: [{ providerId: "openai", status: "completed", probe: passed }],
    }
    expect(probeReportFailed(base)).toBe(false)
    expect(probeReportFailed({ ...base, settled: false })).toBe(true)
    expect(probeReportFailed({ ...base, status: "failed" })).toBe(true)
    expect(probeReportFailed({ ...base, rows: [] })).toBe(true)
    expect(
      probeReportFailed({
        ...base,
        rows: [
          { providerId: "openai", status: "completed", probe: { ...passed, reachable: false } },
        ],
      })
    ).toBe(true)
  })

  it("fails a gateway probe with any failed candidate", () => {
    const report: ProviderProbeReport = {
      via: "gateway",
      answeredBy: { plane: "host", label: "Host" },
      model: "m",
      rows: [
        { providerId: "a", modelId: "m", ok: true, latencyMs: 1 },
        { providerId: "b", modelId: "m", ok: false, latencyMs: 1 },
      ],
    }
    expect(probeReportFailed(report)).toBe(true)
  })
})

describe("format rows", () => {
  it("renders gateway rows with status and error", () => {
    expect(
      formatGatewayProbeRow({
        providerId: "openai",
        modelId: "gpt-4o",
        ok: true,
        status: 200,
        latencyMs: 310,
      })
    ).toBe("ok   openai           gpt-4o                       310ms HTTP 200")
    expect(
      formatGatewayProbeRow({
        providerId: "azure",
        modelId: "gpt-4o",
        ok: false,
        latencyMs: 9,
        error: "bad key",
      })
    ).toBe("FAIL azure            gpt-4o                       9ms  bad key")
  })

  it("renders local rows from the probe result or the failure", () => {
    expect(
      formatLocalProbeRow({
        providerId: "openai",
        result: {
          reachable: true,
          authenticated: true,
          capabilityVerified: true,
          durationMs: 120,
          httpStatus: 200,
        },
      })
    ).toBe("ok   openai           120ms auth HTTP 200")
    expect(
      formatLocalProbeRow({
        providerId: "openai",
        result: {
          reachable: true,
          authenticated: false,
          capabilityVerified: false,
          durationMs: 80,
          httpStatus: 401,
          failure: { code: "authentication", retryable: false, message: "invalid key" },
        },
      })
    ).toBe("FAIL openai           80ms no-auth HTTP 401  invalid key")
    expect(
      formatLocalProbeRow({
        providerId: "anthropic",
        failure: {
          ok: false,
          operationId: "health.probe",
          availability: "needs-auth",
          failure: { code: "authentication", retryable: false, message: "no key" },
        },
      })
    ).toBe("FAIL anthropic        needs-auth: no key")
  })

  it("renders Host job rows from the sample's probe or its failure", () => {
    expect(
      formatHostProbeRow({
        providerId: "openai",
        modelId: "gpt-4o",
        status: "completed",
        probe: {
          reachable: true,
          authenticated: true,
          capabilityVerified: true,
          durationMs: 42,
          httpStatus: 200,
        },
      })
    ).toBe("ok   openai           gpt-4o                       42ms auth HTTP 200")
    expect(
      formatHostProbeRow({
        providerId: "openai",
        status: "failed",
        failure: { code: "network", retryable: true, message: "connection reset" },
      })
    ).toBe("FAIL openai           failed  network: connection reset")
  })
})
