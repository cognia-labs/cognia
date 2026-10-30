import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { GatewayClientConnections } from "./gateway-client-connections"
import type { GatewayClientConnectionReport } from "@/types/gateway"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@/lib/tauri/gateway", () => ({
  gatewayClientStatus: jest.fn(),
  gatewayClientConnect: jest.fn(),
  gatewayClientRollback: jest.fn(),
}))
const api = jest.requireMock("@/lib/tauri/gateway")
const report: GatewayClientConnectionReport = {
  ownerAccountId: "owner",
  accountGeneration: 3,
  clients: [
    {
      client: "claude-code",
      installed: true,
      path: "/test/.claude/settings.json",
      sourcePaths: ["/test/.claude/settings.json"],
      revision: "read-version",
      state: "unmanaged",
      modelAlias: null,
      helperAlias: null,
      endpoint: null,
      backupPaths: [],
      connectionVerified: false,
      supportsHelper: true,
      errorCode: null,
    },
    {
      client: "gemini",
      installed: false,
      path: "/test/.gemini/settings.json",
      sourcePaths: ["/test/.gemini/settings.json", "/test/.gemini/.env"],
      revision: "missing",
      state: "unmanaged",
      modelAlias: null,
      helperAlias: null,
      endpoint: null,
      backupPaths: [],
      connectionVerified: false,
      supportsHelper: false,
      errorCode: null,
    },
  ],
}

beforeEach(() => {
  jest.clearAllMocks()
  api.gatewayClientStatus.mockResolvedValue(report)
  api.gatewayClientConnect.mockResolvedValue({
    ...report,
    clients: [
      {
        ...report.clients[0],
        state: "configured",
        modelAlias: "fast",
        endpoint: "http://127.0.0.1:8317",
        connectionVerified: true,
        backupPaths: ["/test/private-backup"],
      },
    ],
  })
  api.gatewayClientRollback.mockResolvedValue(report)
})

it("applies the selected aliases against the reviewed owner and file revision", async () => {
  const user = userEvent.setup()
  render(
    <GatewayClientConnections
      primaryAlias="fast"
      helperAlias="helper"
      running
      accountGeneration={3}
    />
  )
  await user.click(await screen.findByRole("button", { name: "clientApply:clientClaudeCode" }))
  expect(api.gatewayClientConnect).toHaveBeenCalledWith({
    client: "claude-code",
    modelAlias: "fast",
    helperAlias: "helper",
    expectedRevision: "read-version",
    ownerAccountId: "owner",
    accountGeneration: 3,
  })
  expect(await screen.findByText("clientVerified")).toBeInTheDocument()
  expect(screen.getByText("http://127.0.0.1:8317")).toBeInTheDocument()
})

it("does not enable configuration for an absent executable", async () => {
  render(<GatewayClientConnections primaryAlias="fast" running accountGeneration={3} />)
  expect(await screen.findByRole("button", { name: "clientApply:clientGemini" })).toBeDisabled()
  expect(screen.getByText("clientNotInstalled")).toBeInTheDocument()
})

it("shows a conflict without claiming a connection succeeded", async () => {
  api.gatewayClientConnect.mockRejectedValue(new Error("gateway_client_config_changed"))
  const user = userEvent.setup()
  render(<GatewayClientConnections primaryAlias="fast" running accountGeneration={3} />)
  await user.click(await screen.findByRole("button", { name: "clientApply:clientClaudeCode" }))
  expect(await screen.findByText("clientConfigChanged")).toBeInTheDocument()
  expect(screen.queryByText("clientVerified")).not.toBeInTheDocument()
})

it("restores from the latest managed file revision", async () => {
  api.gatewayClientStatus.mockResolvedValue({
    ...report,
    clients: [
      {
        ...report.clients[0],
        state: "configured",
        revision: "applied-version",
        modelAlias: "fast",
        connectionVerified: true,
      },
    ],
  })
  const user = userEvent.setup()
  render(<GatewayClientConnections primaryAlias="fast" running accountGeneration={3} />)
  await user.click(await screen.findByRole("button", { name: "clientRestore:clientClaudeCode" }))
  await waitFor(() =>
    expect(api.gatewayClientRollback).toHaveBeenCalledWith({
      client: "claude-code",
      expectedRevision: "applied-version",
      ownerAccountId: "owner",
      accountGeneration: 3,
    })
  )
})
