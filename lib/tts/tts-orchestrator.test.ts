/**
 * The app binding re-exports the package singleton unchanged and installs the
 * host bridges first, so every app caller shares one player and metering
 * reaches the Usage surface through `recordSynthesis`.
 */

jest.mock("@/lib/db/session-usage", () => ({
  recordSurfaceUsage: jest.fn(async () => null),
  swallowUsageWrite: (p: Promise<unknown>) => void p.catch(() => {}),
}))

import { getTtsHost } from "@cognia/tts/host"
import { ttsOrchestrator as coreOrchestrator } from "@cognia/tts/tts-orchestrator"

import { meterSynthesis } from "./host-bindings"
import { TTSOrchestrator, ttsOrchestrator } from "./tts-orchestrator"

it("is the package singleton, not a wrapper", () => {
  expect(ttsOrchestrator).toBe(coreOrchestrator)
  expect(ttsOrchestrator).toBeInstanceOf(TTSOrchestrator)
})

it("installs the host bridges before any synthesis, including the usage meter", () => {
  expect(getTtsHost().recordSynthesis).toBe(meterSynthesis)
  expect(typeof getTtsHost().allowCloudText).toBe("function")
})
