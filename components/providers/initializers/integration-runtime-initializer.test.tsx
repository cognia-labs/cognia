import { act, render, waitFor } from "@testing-library/react"
import { detectPlatform } from "@/lib/platform/detect"
import { startIntegrationRuntime } from "@/lib/integrations/runtime"
import { isIntegrationRuntimeOwner } from "@/lib/integrations/runtime-owner"
import { useAccountStore } from "@/stores/account/account-store"
import { IntegrationRuntimeInitializer } from "./integration-runtime-initializer"

jest.mock("@/lib/platform/detect", () => ({ detectPlatform: jest.fn() }))
jest.mock("@/lib/integrations/runtime-owner", () => ({ isIntegrationRuntimeOwner: jest.fn() }))
jest.mock("@/stores/account/account-store", () => ({ useAccountStore: jest.fn() }))
jest.mock("@/lib/integrations/runtime", () => ({
  startIntegrationRuntime: jest.fn(),
}))

const mockedDetectPlatform = jest.mocked(detectPlatform)
const mockedStartRuntime = jest.mocked(startIntegrationRuntime)
const disposeRuntime = jest.fn()

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(isIntegrationRuntimeOwner).mockResolvedValue(true)
  ;(useAccountStore as unknown as jest.Mock).mockImplementation((selector) =>
    selector({
      unlockedAccountId: "account-1",
      accountRevision: 0,
    })
  )
  mockedStartRuntime.mockResolvedValue(disposeRuntime)
})

it("does not execute platform actions in web or mobile clients", () => {
  mockedDetectPlatform.mockReturnValue("web")
  render(<IntegrationRuntimeInitializer />)
  expect(mockedStartRuntime).not.toHaveBeenCalled()
})

it("starts and disposes the shared runtime on the desktop host", async () => {
  mockedDetectPlatform.mockReturnValue("tauri")
  const { unmount } = render(<IntegrationRuntimeInitializer />)
  await waitFor(() => expect(mockedStartRuntime).toHaveBeenCalledTimes(1))
  unmount()
  expect(disposeRuntime).toHaveBeenCalledTimes(1)
})

it("does not start any drain in a secondary window", async () => {
  mockedDetectPlatform.mockReturnValue("tauri")
  jest.mocked(isIntegrationRuntimeOwner).mockResolvedValue(false)
  render(<IntegrationRuntimeInitializer />)
  await waitFor(() => expect(isIntegrationRuntimeOwner).toHaveBeenCalledTimes(1))
  expect(mockedStartRuntime).not.toHaveBeenCalled()
})

it("waits for an unlocked account and disposes when the owner account locks", async () => {
  mockedDetectPlatform.mockReturnValue("tauri")
  const store = useAccountStore as unknown as jest.Mock
  store.mockImplementation((selector) => selector({ unlockedAccountId: null, accountRevision: 0 }))
  const { rerender } = render(<IntegrationRuntimeInitializer />)
  expect(mockedStartRuntime).not.toHaveBeenCalled()
  store.mockImplementation((selector) =>
    selector({ unlockedAccountId: "account-1", accountRevision: 1 })
  )
  rerender(<IntegrationRuntimeInitializer />)
  await waitFor(() => expect(mockedStartRuntime).toHaveBeenCalledTimes(1))
  store.mockImplementation((selector) => selector({ unlockedAccountId: null, accountRevision: 1 }))
  rerender(<IntegrationRuntimeInitializer />)
  expect(disposeRuntime).toHaveBeenCalledTimes(1)
})

it("replaces the runtime once per unlocked account switch and revision change", async () => {
  mockedDetectPlatform.mockReturnValue("tauri")
  const disposers = [jest.fn(), jest.fn(), jest.fn()]
  for (const dispose of disposers) mockedStartRuntime.mockResolvedValueOnce(dispose)
  const store = useAccountStore as unknown as jest.Mock
  const { rerender, unmount } = render(<IntegrationRuntimeInitializer />)
  await waitFor(() => expect(mockedStartRuntime).toHaveBeenCalledTimes(1))

  store.mockImplementation((selector) =>
    selector({ unlockedAccountId: "account-2", accountRevision: 0 })
  )
  rerender(<IntegrationRuntimeInitializer />)
  await waitFor(() => expect(mockedStartRuntime).toHaveBeenCalledTimes(2))
  expect(disposers[0]).toHaveBeenCalledTimes(1)
  expect(disposers[1]).not.toHaveBeenCalled()

  store.mockImplementation((selector) =>
    selector({ unlockedAccountId: "account-2", accountRevision: 1 })
  )
  rerender(<IntegrationRuntimeInitializer />)
  await waitFor(() => expect(mockedStartRuntime).toHaveBeenCalledTimes(3))
  expect(disposers[1]).toHaveBeenCalledTimes(1)
  expect(disposers[2]).not.toHaveBeenCalled()

  rerender(<IntegrationRuntimeInitializer />)
  expect(mockedStartRuntime).toHaveBeenCalledTimes(3)
  expect(isIntegrationRuntimeOwner).toHaveBeenCalledTimes(3)
  unmount()
  for (const dispose of disposers) expect(dispose).toHaveBeenCalledTimes(1)
})

it("immediately disposes a runtime that finishes starting after unmount", async () => {
  mockedDetectPlatform.mockReturnValue("tauri")
  let finishStart!: (dispose: () => void) => void
  const starting = new Promise<() => void>((resolve) => {
    finishStart = resolve
  })
  mockedStartRuntime.mockReturnValueOnce(starting)
  const dispose = jest.fn()
  const { unmount } = render(<IntegrationRuntimeInitializer />)
  await waitFor(() => expect(mockedStartRuntime).toHaveBeenCalledTimes(1))
  unmount()
  expect(dispose).not.toHaveBeenCalled()

  await act(async () => {
    finishStart(dispose)
    await starting
  })
  expect(dispose).toHaveBeenCalledTimes(1)
  expect(mockedStartRuntime).toHaveBeenCalledTimes(1)
})
