import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enExternalAgent from "@/i18n/messages/en/externalAgent.json"

const mockSupportsAgentTerminal = jest.fn(() => true)
jest.mock("@/lib/ai/agent/external/agent-transport", () => ({
  supportsAgentTerminal: () => mockSupportsAgentTerminal(),
}))

const mockGetAuthMethods = jest.fn()
const mockResolveLiveSessionId = jest.fn()
const mockGetSessionModels = jest.fn()
jest.mock("@/lib/ai/agent/external/manager", () => ({
  getExternalAgentManager: () => ({
    getAuthMethods: (...args: unknown[]) => mockGetAuthMethods(...args),
    resolveLiveSessionId: (...args: unknown[]) => mockResolveLiveSessionId(...args),
    getSessionModels: (...args: unknown[]) => mockGetSessionModels(...args),
  }),
}))

import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { OhMyPiStatusCard } from "./omp-status-card"

function renderCard(props?: { agentId?: string; connected?: boolean }) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ externalAgent: enExternalAgent }}>
      <OhMyPiStatusCard agentId={props?.agentId ?? "omp-1"} connected={props?.connected ?? true} />
    </NextIntlClientProvider>
  )
}

describe("OhMyPiStatusCard", () => {
  beforeEach(() => {
    mockSupportsAgentTerminal.mockReset().mockReturnValue(true)
    mockGetAuthMethods.mockReset().mockReturnValue({ status: "ok", data: [] })
    mockResolveLiveSessionId.mockReset().mockReturnValue(null)
    mockGetSessionModels.mockReset().mockReturnValue({ status: "unsupported" })

    useExternalAgentStore.setState({
      agents: {
        "omp-1": {
          id: "omp-1",
          name: "oh-my-pi",
          enabled: true,
          protocol: "acp",
          transport: "stdio",
          process: { command: "omp", args: ["acp"], cwd: "/work" },
          metadata: { preset: "oh-my-pi" },
          createdAt: "2026-11-18T00:00:00.000Z",
          updatedAt: "2026-11-18T00:00:00.000Z",
        },
      },
      agentValidity: {},
      lastRunSnapshots: {},
    })
  })

  it("renders certified version, desktop terminal readiness, negotiated auth, active model and first-turn status (#15)", () => {
    mockGetAuthMethods.mockReturnValue({
      status: "ok",
      data: [{ id: "native-oauth", name: "OMP Provider Sign-In" }],
    })
    mockResolveLiveSessionId.mockReturnValue("sess-1")
    mockGetSessionModels.mockReturnValue({
      status: "ok",
      data: {
        currentModelId: "cognia/claude-sonnet-4",
        availableModels: [{ modelId: "cognia/claude-sonnet-4", name: "Sonnet" }],
      },
    })
    useExternalAgentStore.setState({
      agentValidity: {
        "omp-1": {
          executable: true,
          checkedAt: new Date(),
          source: "connect",
          sessionExtensions: {
            "session/list": { state: "supported" },
            "session/resume": { state: "supported" },
            "session/fork": { state: "supported" },
          },
          negotiation: {
            protocol: "acp",
            agentInfo: { name: "omp", version: "18.22.2" },
            authRequired: false,
          },
        },
      },
      lastRunSnapshots: {
        "omp-1": {
          terminalOutcome: "ok",
          branchReasonCode: "ok",
          branchOutcome: "external",
          timestamp: new Date(),
        },
      },
    })

    renderCard({ connected: true })
    expect(screen.getByTestId("omp-status-card")).toBeInTheDocument()
    expect(screen.getByText("v18.22.2")).toBeInTheDocument()
    expect(screen.getByText("Certified 18.22.2")).toBeInTheDocument()
    expect(screen.getByTestId("omp-terminal-badge")).toHaveTextContent(/Desktop terminal ready/i)
    expect(screen.getByText("OMP Provider Sign-In")).toBeInTheDocument()
    expect(screen.getByTestId("omp-first-turn-badge")).toHaveTextContent(/Verified/i)
    expect(screen.getByText(/cognia\/claude-sonnet-4/)).toBeInTheDocument()
  })

  it("surfaces paired/remote terminal block (#16) and requireApprovalFor fail-closed warning (#17)", () => {
    mockSupportsAgentTerminal.mockReturnValue(false)
    useExternalAgentStore.setState({
      agents: {
        "omp-1": {
          id: "omp-1",
          name: "oh-my-pi",
          enabled: true,
          protocol: "acp",
          transport: "stdio",
          process: { command: "omp", args: ["acp"] },
          requireApprovalFor: ["bash"],
          metadata: { preset: "oh-my-pi" },
          createdAt: "2026-11-18T00:00:00.000Z",
          updatedAt: "2026-11-18T00:00:00.000Z",
        },
      },
    })

    renderCard({ connected: false })
    expect(screen.getByTestId("omp-terminal-badge")).toHaveTextContent(/ACP terminal unavailable/i)
    expect(screen.getByText(/paired|remote/i)).toBeInTheDocument()
    expect(screen.getByTestId("omp-approval-boundary-badge")).toHaveTextContent(
      /Blocked by config/i
    )
    expect(screen.getByText(/requireApprovalFor/i)).toBeInTheDocument()
  })
})
