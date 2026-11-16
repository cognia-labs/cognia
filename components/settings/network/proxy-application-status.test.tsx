/**
 * @jest-environment jsdom
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { ProxyActiveStatus } from "@/types/network/proxy"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const getProxyRuntimeStatus = jest.fn<Promise<ProxyActiveStatus>, []>()
jest.mock("@/stores/network-proxy", () => ({
  getProxyRuntimeStatus: () => getProxyRuntimeStatus(),
}))

const restartSidecar = jest.fn<Promise<void>, []>()
jest.mock("@/lib/native/local-runtime", () => ({
  restartSidecar: () => restartSidecar(),
}))

import { NETWORK_PROXY_APPLIED_EVENT } from "@/lib/network/proxy-events"
import { PENDING_REFRESH_MS, ProxyApplicationStatus } from "./proxy-application-status"

const READY: ProxyActiveStatus = {
  state: "ready",
  credentialConfigured: false,
  revision: "e-3",
  applications: [],
}

const pending = (): ProxyActiveStatus => ({
  ...READY,
  applications: [
    {
      owner: "agent-runtime",
      update: "process-restart",
      appliedRevision: "e-2",
      state: "restart-pending",
    },
  ],
})

beforeEach(() => {
  getProxyRuntimeStatus.mockReset()
  restartSidecar.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  jest.useRealTimers()
})

describe("ProxyApplicationStatus", () => {
  it("renders nothing where no native Host reports owners", async () => {
    getProxyRuntimeStatus.mockResolvedValue({ state: "ready", credentialConfigured: false })
    const { container } = render(<ProxyApplicationStatus />)
    await waitFor(() => expect(screen.queryByText("loading")).not.toBeInTheDocument())
    expect(container).toBeEmptyDOMElement()
  })

  it("says the agent runtime is not running when no owner is registered", async () => {
    getProxyRuntimeStatus.mockResolvedValue(READY)
    render(<ProxyApplicationStatus />)
    expect(await screen.findByText("ownerState.notRunning")).toBeInTheDocument()
    expect(screen.getByText("policy.ready")).toBeInTheDocument()
    expect(screen.queryByText("restart")).not.toBeInTheDocument()
  })

  it("shows a current owner without a restart action", async () => {
    getProxyRuntimeStatus.mockResolvedValue({
      ...READY,
      applications: [
        {
          owner: "agent-runtime",
          update: "process-restart",
          appliedRevision: "e-3",
          state: "current",
        },
      ],
    })
    render(<ProxyApplicationStatus />)
    expect(await screen.findByText("ownerState.current")).toBeInTheDocument()
    expect(screen.queryByText("restart")).not.toBeInTheDocument()
  })

  it("surfaces a blocked policy with its error code", async () => {
    getProxyRuntimeStatus.mockResolvedValue({
      ...READY,
      state: "blocked",
      errorCode: "PROXY_CREDENTIAL_UNAVAILABLE",
    })
    render(<ProxyApplicationStatus />)
    expect(await screen.findByText("policy.blocked")).toBeInTheDocument()
    expect(screen.getByText("PROXY_CREDENTIAL_UNAVAILABLE")).toBeInTheDocument()
  })

  it("reports a read failure instead of a fake state", async () => {
    getProxyRuntimeStatus.mockRejectedValue(new Error("ipc"))
    render(<ProxyApplicationStatus />)
    expect(await screen.findByRole("alert")).toHaveTextContent("unavailable")
  })

  it("restarts a pending agent runtime only after confirmation", async () => {
    getProxyRuntimeStatus.mockResolvedValueOnce(pending()).mockResolvedValue(READY)
    render(<ProxyApplicationStatus />)
    expect(await screen.findByText("ownerState.pending")).toBeInTheDocument()
    expect(screen.getByText("pendingHint")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "restart" }))
    expect(restartSidecar).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole("button", { name: "restartConfirm" }))

    await waitFor(() => expect(restartSidecar).toHaveBeenCalledTimes(1))
    expect(await screen.findByText("ownerState.notRunning")).toBeInTheDocument()
  })

  it("reports a failed restart", async () => {
    getProxyRuntimeStatus.mockResolvedValue(pending())
    restartSidecar.mockRejectedValue(new Error("busy"))
    render(<ProxyApplicationStatus />)
    fireEvent.click(await screen.findByRole("button", { name: "restart" }))
    fireEvent.click(await screen.findByRole("button", { name: "restartConfirm" }))
    expect(await screen.findByText("restartFailed")).toBeInTheDocument()
  })

  it("re-reads after a native apply and while an owner is pending", async () => {
    jest.useFakeTimers()
    getProxyRuntimeStatus.mockResolvedValue(READY)
    render(<ProxyApplicationStatus />)
    await act(async () => {})
    expect(getProxyRuntimeStatus).toHaveBeenCalledTimes(1)

    getProxyRuntimeStatus.mockResolvedValue(pending())
    await act(async () => {
      window.dispatchEvent(new Event(NETWORK_PROXY_APPLIED_EVENT))
    })
    expect(getProxyRuntimeStatus).toHaveBeenCalledTimes(2)
    expect(screen.getByText("ownerState.pending")).toBeInTheDocument()

    getProxyRuntimeStatus.mockResolvedValue(READY)
    await act(async () => {
      jest.advanceTimersByTime(PENDING_REFRESH_MS)
    })
    expect(getProxyRuntimeStatus).toHaveBeenCalledTimes(3)
    expect(screen.getByText("ownerState.notRunning")).toBeInTheDocument()

    // Nothing pending any more: no further polling.
    await act(async () => {
      jest.advanceTimersByTime(PENDING_REFRESH_MS * 3)
    })
    expect(getProxyRuntimeStatus).toHaveBeenCalledTimes(3)
  })
})
