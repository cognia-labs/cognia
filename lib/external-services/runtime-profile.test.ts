import { detectPlatform } from "@/lib/platform/detect"
import { isMirroredPluginClient } from "@/lib/plugin/core/mirrored-client"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"
import { currentExternalServiceRuntimeContext } from "./runtime-profile"
jest.mock("@/lib/platform/detect", () => ({ detectPlatform: jest.fn() }))
jest.mock("@/lib/plugin/core/mirrored-client", () => ({ isMirroredPluginClient: jest.fn() }))
jest.mock("@/lib/tauri/transport-routing", () => ({ isRemoteHostActive: jest.fn() }))

it.each([
  ["web", false, false, { local: "browser", gateway: "browser" }],
  ["tauri", false, false, { local: "tauri", gateway: "tauri" }],
  ["mobile", true, false, { local: "mobile", gateway: "mobile" }],
  ["headless", false, false, { local: "headless", gateway: "headless" }],
  ["web", true, false, { local: "tauri", gateway: "tauri" }],
  // A paired gateway serves exchange and network only; secrets, callbacks and
  // background sync stay in the local runtime.
  ["mobile", true, true, { local: "mobile", gateway: "tauri" }],
  ["web", false, true, { local: "browser", gateway: "tauri" }],
] as const)("resolves %s mirrored=%s remote=%s to %o", (local, mirrored, remote, effective) => {
  jest.mocked(detectPlatform).mockReturnValue(local)
  jest.mocked(isMirroredPluginClient).mockReturnValue(mirrored)
  jest.mocked(isRemoteHostActive).mockReturnValue(remote)
  expect(currentExternalServiceRuntimeContext()).toEqual(effective)
  // Stable snapshot for useSyncExternalStore.
  expect(currentExternalServiceRuntimeContext()).toBe(currentExternalServiceRuntimeContext())
})
