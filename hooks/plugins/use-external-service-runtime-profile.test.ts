/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"
import { detectPlatform } from "@/lib/platform/detect"
import { setActiveRemoteTransport, __resetRoutingForTests } from "@/lib/tauri/transport-routing"
import { useExternalServiceRuntimeProfile } from "./use-external-service-runtime-profile"
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: jest.fn(() => "web"),
}))
jest.mock("@/lib/plugin/core/mirrored-client", () => ({ isMirroredPluginClient: () => false }))
afterEach(__resetRoutingForTests)
it("updates the displayed runtime when a paired gateway becomes active", () => {
  jest.mocked(detectPlatform).mockReturnValue("web")
  const { result, unmount } = renderHook(useExternalServiceRuntimeProfile)
  expect(result.current).toEqual({ local: "browser", gateway: "browser" })
  act(() => setActiveRemoteTransport({ call: jest.fn(), dispose: jest.fn() } as never))
  expect(result.current).toEqual({ local: "browser", gateway: "tauri" })
  act(() => setActiveRemoteTransport(null))
  expect(result.current).toEqual({ local: "browser", gateway: "browser" })
  unmount()
})
