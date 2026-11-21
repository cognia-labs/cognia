/** @jest-environment jsdom */

import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { AgentTeam } from "@/types/agent/agent-team"

let liveValue: unknown = null
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => liveValue }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
const retryChildMock = jest.fn<Promise<void>, [string, string?]>(async () => undefined)
jest.mock("@/lib/squads/durable/retry-squad-child", () => ({
  retrySquadChild: (childRunId: string, hostRef?: string) => retryChildMock(childRunId, hostRef),
}))

jest.mock("@/lib/ai/agent/execution/local-tauri-environment", () => ({
  createLocalTauriExecutionEnvironment: () => ({ preflight: () => ({ ok: true, missing: [] }) }),
}))

const approveAndPublishMock = jest.fn(async (..._args: unknown[]) => "graph-1")
jest.mock("@/lib/squads/delivery/github-delivery-adapter", () => ({
  ...jest.requireActual("@/lib/squads/delivery/github-delivery-adapter"),
  approveAndPublishGithubStack: (...args: unknown[]) => approveAndPublishMock(...args),
}))

import { DurableOperations } from "./durable-operations"

const team = (): AgentTeam =>
  ({
    id: "team-1",
    name: "Team",
    description: "",
    task: "Ship",
    status: "idle",
    config: {},
    teammateIds: [],
    taskIds: [],
    messageIds: [],
    events: [],
    createdAt: new Date(),
  }) as unknown as AgentTeam

const stop = (state: "requested" | "unconfirmed" | "confirmed") => ({
  state,
  epoch: 3,
  requestedAt: 1,
})
const fence = {
  fenceCapable: true,
  lastRenewalSentAt: 1_000,
  leaseTtlMs: 5_000,
  fenceGraceMs: 1_000,
}
function operationsData(child: Record<string, unknown>, run: Record<string, unknown> = {}) {
  return {
    run: { id: "run-1", status: "running", decisionVersion: 0, ...run },
    children: [
      {
        id: "child-1",
        status: "needs_input",
        repositoryId: "primary",
        attempt: 2,
        dispatchEpoch: 3,
        hostRef: "device:a",
        remoteSessionId: "remote-1",
        ...child,
      },
    ],
    decisions: [],
    evidence: [],
    deliveryNodes: [],
    retrospectives: [],
  }
}
const renderOperations = () =>
  render(
    <DurableOperations
      team={team()}
      onOpenEditor={jest.fn()}
      onOpenTerminal={jest.fn()}
      onOpenBrowser={jest.fn()}
    />
  )

describe("DurableOperations", () => {
  beforeEach(() => {
    liveValue = null
    retryChildMock.mockClear()
  })

  it("shows the durable empty state before a run exists", () => {
    render(
      <DurableOperations
        team={team()}
        onOpenEditor={jest.fn()}
        onOpenTerminal={jest.fn()}
        onOpenBrowser={jest.fn()}
      />
    )
    expect(screen.getByText(/no durable run/i)).toBeInTheDocument()
  })

  describe("a stack publish the outbound policy held (ADR-0239 phase 2)", () => {
    const held = (recoveryReason: string, graphStatus = "draft", status = "needs_input") => ({
      run: {
        id: "run-1",
        status,
        recoveryReason,
        decisionVersion: 0,
        resourceUsage: { totalTokens: 0 },
      },
      children: [],
      decisions: [],
      evidence: [],
      graph: { id: "graph-1", runId: "run-1", status: graphStatus, createdAt: 1, updatedAt: 1 },
      deliveryNodes: [],
      retrospectives: [],
      environment: undefined,
    })
    const renderPanel = () =>
      render(
        <DurableOperations
          team={team()}
          onOpenEditor={jest.fn()}
          onOpenTerminal={jest.fn()}
          onOpenBrowser={jest.fn()}
        />
      )

    beforeEach(() => approveAndPublishMock.mockClear())

    it("says why it waits and publishes on a person's approval", async () => {
      const user = userEvent.setup()
      liveValue = held("delivery_awaiting_approval")
      renderPanel()
      expect(screen.getByTestId("delivery-publish-held")).toHaveTextContent(
        /nothing authorized publishing/i
      )
      await user.click(screen.getByRole("button", { name: /approve and publish/i }))
      expect(approveAndPublishMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: "team-1" }),
        "run-1"
      )
    })

    it("says when a person refused it, and still offers approval", () => {
      liveValue = held("delivery_refused")
      renderPanel()
      expect(screen.getByTestId("delivery-publish-held")).toHaveTextContent(/refused/i)
      expect(screen.getByRole("button", { name: /approve and publish/i })).toBeInTheDocument()
    })

    it.each([
      ["a failed delivery", held("delivery_failed")],
      ["a published graph", held("delivery_awaiting_approval", "running")],
      ["a run no longer waiting", held("delivery_awaiting_approval", "draft", "completed")],
    ])("offers nothing for %s", (_label, value) => {
      liveValue = value
      renderPanel()
      expect(screen.queryByRole("button", { name: /approve and publish/i })).not.toBeInTheDocument()
      expect(screen.queryByTestId("delivery-publish-held")).not.toBeInTheDocument()
    })
  })

  it("opens the takeover terminal at the persisted child worktree", async () => {
    const user = userEvent.setup()
    const onOpenTerminal = jest.fn()
    liveValue = {
      run: {
        id: "run-1",
        status: "running",
        decisionVersion: 0,
        resourceUsage: { totalTokens: 0 },
      },
      children: [
        {
          id: "child-1",
          repositoryId: "primary",
          workspacePath: "/repo/.worktrees/child-1",
          status: "paused",
        },
      ],
      decisions: [],
      evidence: [],
      graph: undefined,
      deliveryNodes: [],
      retrospectives: [],
      environment: undefined,
    }
    render(
      <DurableOperations
        team={team()}
        onOpenEditor={jest.fn()}
        onOpenTerminal={onOpenTerminal}
        onOpenBrowser={jest.fn()}
      />
    )

    await user.click(screen.getByRole("button", { name: /open terminal/i }))
    expect(onOpenTerminal).toHaveBeenCalledWith("/repo/.worktrees/child-1")
  })

  it("shows remote lineage and routes same-host recovery through the manager", async () => {
    const user = userEvent.setup()
    liveValue = {
      run: {
        id: "run-1",
        status: "needs_input",
        decisionVersion: 0,
        resourceUsage: { totalTokens: 0 },
      },
      children: [
        {
          id: "child-remote",
          repositoryId: "primary",
          status: "needs_input",
          hostRef: "device:worker-a",
          remoteSessionId: "remote-session-1",
          waitingReason: "recovery_required",
          dispatchLeaseId: "lease-1",
          dispatchLeaseExpiresAt: Date.now() + 60_000,
          dispatchEpoch: 3,
          stop: { ...stop("confirmed"), proof: { kind: "ack", epoch: 3, at: 1 } },
        },
      ],
      decisions: [],
      evidence: [],
      graph: undefined,
      deliveryNodes: [],
      retrospectives: [],
      environment: undefined,
    }
    render(
      <DurableOperations
        team={team()}
        onOpenEditor={jest.fn()}
        onOpenTerminal={jest.fn()}
        onOpenBrowser={jest.fn()}
      />
    )

    expect(screen.getByText(/device:worker-a/)).toBeInTheDocument()
    expect(screen.getByText(/remote-session-1/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /retry same host/i }))
    expect(retryChildMock).toHaveBeenCalledWith("child-remote", "device:worker-a")
  })

  it("renders a child with no stop request without claiming it stopped", () => {
    liveValue = operationsData({})
    renderOperations()
    // An idle child carries no stop line at all, and nothing says "stopped".
    expect(screen.queryByText(/No stop requested/)).not.toBeInTheDocument()
    expect(screen.queryByText(/^Stopped/)).not.toBeInTheDocument()
    expect(screen.queryByRole("status", { name: "Run stop summary" })).not.toBeInTheDocument()
  })

  it.each([
    ["requested", "Stopping"],
    ["unconfirmed", "Stop unconfirmed"],
  ] as const)("renders a %s stop in the child and run summary", (state, label) => {
    liveValue = operationsData({ stop: stop(state) })
    renderOperations()
    expect(screen.getByRole("status", { name: "Run stop summary" })).toHaveTextContent(label)
    expect(screen.getByText(`${label} · No stop proof`)).toBeInTheDocument()
  })

  it("renders Worker-acknowledged stop proof", () => {
    liveValue = operationsData({
      stop: { ...stop("confirmed"), proof: { kind: "ack", epoch: 3, at: 1 } },
    })
    renderOperations()
    expect(screen.getByText("Stopped · confirmed by the Worker")).toBeInTheDocument()
  })

  it("shows the confirmed stop summary for a run with no children", () => {
    liveValue = {
      ...operationsData({}, { stop: stop("confirmed"), status: "cancelled" }),
      children: [],
    }
    renderOperations()
    expect(screen.getByRole("status", { name: "Run stop summary" })).toHaveTextContent("Stopped")
  })

  it("renders persisted Worker isolation expiry proof", () => {
    liveValue = operationsData({
      ...fence,
      stop: { ...stop("confirmed"), proof: { kind: "fence-expiry", epoch: 3, at: 7_000 } },
    })
    renderOperations()
    expect(
      screen.getByText("Stopped · Worker self-fenced after its lease expired")
    ).toBeInTheDocument()
  })

  it("updates a derived fence proof at the deadline without a store write", () => {
    jest.useFakeTimers()
    jest.setSystemTime(6_000)
    liveValue = operationsData({
      ...fence,
      stop: stop("unconfirmed"),
      waitingReason: "recovery_required",
    })
    try {
      const view = renderOperations()
      expect(screen.getByRole("button", { name: "Retry same host" })).toBeDisabled()
      act(() => jest.advanceTimersByTime(1_000))
      expect(
        screen.getByText("Stopped · Worker self-fenced after its lease expired")
      ).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Retry same host" })).toBeEnabled()
      view.unmount()
    } finally {
      jest.useRealTimers()
    }
  })

  it("shows control loss rather than a failed or stopped remote child", () => {
    liveValue = operationsData(
      {
        status: "failed",
        stop: stop("unconfirmed"),
        error: "Worker connection conn-1 detached: socket_closed",
      },
      { status: "failed" }
    )
    renderOperations()
    expect(
      screen.getAllByText("Control lost — the remote run may still be running").length
    ).toBeGreaterThan(0)
    expect(screen.queryByText("Failed")).not.toBeInTheDocument()
    expect(screen.queryByText("Stopped")).not.toBeInTheDocument()
  })

  it("shows the previous attempt and disables both retries with a reason without proof", async () => {
    liveValue = operationsData({ stop: stop("unconfirmed"), waitingReason: "recovery_required" })
    renderOperations()
    expect(screen.getByText("Latest attempt: #2")).toBeInTheDocument()
    expect(screen.getByText("Latest attempt status: Needs input")).toBeInTheDocument()
    expect(screen.getByText("Epoch: 3")).toBeInTheDocument()
    expect(screen.getByText("Host: device:a")).toBeInTheDocument()
    for (const name of ["Retry same host", "Retry selected host"]) {
      const retry = screen.getByRole("button", { name })
      expect(retry).toBeDisabled()
      expect(retry).toHaveAccessibleDescription(
        "Retry is unavailable until the previous attempt has stop proof."
      )
      await userEvent.setup().click(retry)
    }
    expect(retryChildMock).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Cancel child" })).toBeEnabled()
    expect(
      within(screen.getByRole("status", { name: "Run stop summary" })).getByText("Stop unconfirmed")
    ).toBeInTheDocument()
  })

  it.each(["completed", "failed", "cancelled", "terminated"] as const)(
    "hides child steering controls when the child is already %s (F06)",
    (terminalStatus) => {
      liveValue = operationsData({ status: terminalStatus })
      renderOperations()
      expect(screen.queryByRole("button", { name: "Send steering" })).not.toBeInTheDocument()
    }
  )
})
