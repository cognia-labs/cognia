import { detectPlatform } from "@/lib/platform/detect"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { isIntegrationRuntimeOwner } from "./runtime-owner"

jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: jest.fn(),
}))
jest.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: jest.fn() }))

it.each(["main", "settings", "chat-widget"])(
  "matches the plugin owner rule for window %s",
  async (label) => {
    jest.mocked(detectPlatform).mockReturnValue("tauri")
    jest.mocked(getCurrentWindow).mockReturnValue({ label } as ReturnType<typeof getCurrentWindow>)
    expect(await isIntegrationRuntimeOwner()).toBe(label === "main")
  }
)

it("allows the headless host without loading a native window", async () => {
  jest.mocked(getCurrentWindow).mockClear()
  jest.mocked(detectPlatform).mockReturnValue("headless")
  expect(await isIntegrationRuntimeOwner()).toBe(true)
  expect(getCurrentWindow).not.toHaveBeenCalled()
})
