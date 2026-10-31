import { render, waitFor } from "@testing-library/react"
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
