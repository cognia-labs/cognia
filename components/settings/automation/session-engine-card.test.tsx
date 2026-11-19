/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const get = jest.fn()
const probe = jest.fn()
const saveRequest = jest.fn()
jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("@/lib/automation/client", () => ({
  desktop: {
    sessionEngineGet: () => get(),
    sessionEngineProbe: () => probe(),
    sessionEngineSet: (...args: unknown[]) => saveRequest(...args),
  },
}))
import { SessionEngineCard } from "./session-engine-card"

beforeEach(() => {
  get.mockReset().mockResolvedValue({
    revision: 4,
    configGeneration: "generation",
    desiredEngine: "agentDesktop",
    effectiveEngine: "native",
    needsRestart: true,
    agentDesktopAvailable: true,
    candidateHealth: "ready",
    health: "ready",
  })
  probe.mockReset().mockRejectedValue(new Error("unavailable"))
  saveRequest.mockReset().mockResolvedValue({
    revision: 1,
    configGeneration: "recovered",
    desiredEngine: "native",
    effectiveEngine: "native",
    needsRestart: true,
    configurationError: false,
    recoveryToken: null,
    health: "configError",
    candidateHealth: "missing",
    agentDesktopAvailable: false,
  })
})

it("keeps desired and effective engines distinct until restart", async () => {
  render(<SessionEngineCard />)
  expect(await screen.findByRole("status")).toHaveTextContent(/restart Cognia/i)
  expect(screen.getByText(/Active engine: Native/)).toBeInTheDocument()
})

it("reports a probe failure without displaying availability success", async () => {
  render(<SessionEngineCard />)
  const button = await screen.findByRole("button", { name: /check availability/i })
  await waitFor(() => expect(button).toBeEnabled())
  fireEvent.click(button)
  expect(await screen.findByRole("alert")).toHaveTextContent(/could not check/i)
})

it("recovers damaged settings using the exact snapshot token and still requires restart", async () => {
  get.mockResolvedValueOnce({
    revision: 0,
    configGeneration: "",
    desiredEngine: "native",
    effectiveEngine: "native",
    needsRestart: true,
    configurationError: true,
    recoveryToken: "bad-file-digest",
    health: "configError",
    candidateHealth: "missing",
    agentDesktopAvailable: false,
  })
  render(<SessionEngineCard />)
  fireEvent.click(await screen.findByRole("button", { name: /restore Native settings/i }))
  await waitFor(() => expect(saveRequest).toHaveBeenCalledWith(0, "native", "", "bad-file-digest"))
  expect(await screen.findByRole("status")).toHaveTextContent(/restart Cognia/i)
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: /restore Native settings/i })
    ).not.toBeInTheDocument()
  )
})
