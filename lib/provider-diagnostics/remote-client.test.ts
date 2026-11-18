/**
 * @jest-environment jsdom
 */

import type { Transport } from "@/lib/tauri/transport-types"

import {
  cancelRemoteProviderDiagnosticJob,
  fetchRemoteProviderDiagnosticsHistory,
  fetchRemoteProviderDiagnosticsStatus,
  getCachedRemoteProviderDiagnosticsStatus,
  startRemoteProviderDiagnosticJob,
} from "./remote-client"

function mockTransport(call: jest.Mock): Transport {
  return { call, subscribe: jest.fn(() => jest.fn()) }
}

beforeEach(() => localStorage.clear())

it("caches sanitized status per paired desktop and marks offline data stale", async () => {
  const online = mockTransport(
    jest.fn(async () => ({
      capturedAt: 10,
      desktopRevision: 9,
      stale: false,
      jobs: [],
      balanceSnapshots: [],
      balanceSources: [],
    }))
  )
  await fetchRemoteProviderDiagnosticsStatus("openai", {
    transport: online,
    cacheScope: "desktop-a",
  })

  const offline = mockTransport(jest.fn(async () => Promise.reject(new Error("offline"))))
  await expect(
    fetchRemoteProviderDiagnosticsStatus("openai", {
      transport: offline,
      cacheScope: "desktop-a",
    })
  ).resolves.toMatchObject({ capturedAt: 10, desktopRevision: 9, stale: true })
  expect(getCachedRemoteProviderDiagnosticsStatus("openai", { cacheScope: "desktop-b" })).toBeNull()
})

it("caches history without inventing an endpoint and bounds the requested limit", async () => {
  const call = jest.fn(async () => ({
    capturedAt: 20,
    desktopRevision: 19,
    stale: false,
    samples: [{ id: "sample-1", providerId: "openai" }],
  }))
  const result = await fetchRemoteProviderDiagnosticsHistory(
    { providerId: "openai", limit: 999 },
    { transport: mockTransport(call), cacheScope: "desktop-a" }
  )

  expect(call).toHaveBeenCalledWith("provider_diagnostics_history", {
    providerId: "openai",
    limit: 200,
  })
  expect(result.samples[0]).not.toHaveProperty("endpoint")
})

it("forwards only the constrained remote start and cancel contracts", async () => {
  const call = jest
    .fn()
    .mockResolvedValueOnce({ accepted: true, jobId: "job-1" })
    .mockResolvedValueOnce({ cancelled: true })
  const remote = mockTransport(call)
  const input = {
    targets: [{ providerId: "openai", modelId: "gpt-5", capability: "text-generation" as const }],
    mode: "quick" as const,
    costConfirmed: true,
    confirmedRequestLimit: 1,
    confirmedMaxEstimatedCostUsd: 0.01,
  }

  // A shell that is the Host itself attaches no lease.
  const approve = jest.fn(async (_command: string, args: Record<string, unknown>) => args)
  await startRemoteProviderDiagnosticJob(input, { transport: remote, approve })
  await cancelRemoteProviderDiagnosticJob("job-1", { transport: remote, approve })

  expect(call).toHaveBeenNthCalledWith(1, "provider_diagnostics_start", input)
  expect(call).toHaveBeenNthCalledWith(2, "provider_diagnostics_cancel", { jobId: "job-1" })
})

it("sends start and cancel with the lease minted for each command", async () => {
  const call = jest
    .fn()
    .mockResolvedValueOnce({ accepted: true, jobId: "job-2" })
    .mockResolvedValueOnce({ cancelled: true })
  const approve = jest.fn(async (command: string, args: Record<string, unknown>) => ({
    ...args,
    adminLease: `lease-for-${command}`,
  }))
  const input = {
    targets: [{ providerId: "openai", capability: "probe" as const }],
    mode: "quick" as const,
    costConfirmed: false,
    confirmedRequestLimit: 1,
    confirmedMaxEstimatedCostUsd: 0,
  }

  await startRemoteProviderDiagnosticJob(input, { transport: mockTransport(call), approve })
  await cancelRemoteProviderDiagnosticJob("job-2", { transport: mockTransport(call), approve })

  expect(approve).toHaveBeenNthCalledWith(1, "provider_diagnostics_start", input)
  expect(approve).toHaveBeenNthCalledWith(2, "provider_diagnostics_cancel", { jobId: "job-2" })
  expect(call).toHaveBeenNthCalledWith(1, "provider_diagnostics_start", {
    ...input,
    adminLease: "lease-for-provider_diagnostics_start",
  })
  expect(call).toHaveBeenNthCalledWith(2, "provider_diagnostics_cancel", {
    jobId: "job-2",
    adminLease: "lease-for-provider_diagnostics_cancel",
  })
})
