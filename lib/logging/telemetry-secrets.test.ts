/** @jest-environment jsdom */

jest.mock("@/lib/platform/detect", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))
jest.mock("@/lib/keyring", () => ({
  setSecret: jest.fn(),
  getSecret: jest.fn(),
  clearSecret: jest.fn(),
}))

import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/platform/detect"
import { clearSecret, getSecret, setSecret } from "@/lib/keyring"
import {
  clearTelemetrySecret,
  hasTelemetrySecret,
  persistTelemetrySecret,
} from "./telemetry-secrets"

const invokeMock = invoke as jest.MockedFunction<typeof invoke>
const isTauriMock = isTauri as jest.MockedFunction<typeof isTauri>

describe("telemetry secret persistence", () => {
  beforeEach(() => {
    invokeMock.mockReset()
    isTauriMock.mockReturnValue(true)
    jest.mocked(setSecret).mockReset()
    jest.mocked(getSecret).mockReset()
    jest.mocked(clearSecret).mockReset()
  })

  it("uses the write-only telemetry command in Tauri", async () => {
    invokeMock.mockResolvedValue(undefined)
    await persistTelemetrySecret("grafanaCloudApiToken", "glc_secret")
    expect(invokeMock).toHaveBeenCalledWith("telemetry_secret_set", {
      kind: "grafanaCloudApiToken",
      value: "glc_secret",
    })
  })

  it("supports Tauri clear/has while keeping readback unavailable", async () => {
    invokeMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(true)
    await clearTelemetrySecret("langfuseSecretKey")
    await expect(hasTelemetrySecret("langfuseSecretKey")).resolves.toBe(true)
    expect(invokeMock).toHaveBeenNthCalledWith(1, "telemetry_secret_clear", {
      kind: "langfuseSecretKey",
    })
  })

  it("rejects empty secrets before persistence", async () => {
    await expect(persistTelemetrySecret("langfuseSecretKey", "")).rejects.toThrow(/empty/)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("uses the keyring adapter outside Tauri", async () => {
    isTauriMock.mockReturnValue(false)
    jest.mocked(getSecret).mockResolvedValue("sk-browser")
    await persistTelemetrySecret("langfuseSecretKey", "sk-browser")
    await clearTelemetrySecret("langfuseSecretKey")
    await expect(hasTelemetrySecret("langfuseSecretKey")).resolves.toBe(true)
    expect(setSecret).toHaveBeenCalledWith(
      { namespace: "telemetry", key: "langfuse-secret-key" },
      "sk-browser"
    )
    expect(clearSecret).toHaveBeenCalled()
  })

  it("rejects Grafana credentials outside the secure desktop Host", async () => {
    isTauriMock.mockReturnValue(false)

    await expect(
      persistTelemetrySecret("grafanaCloudApiToken", "glc_browser_secret")
    ).rejects.toThrow(/secure desktop Host/)
    expect(setSecret).not.toHaveBeenCalled()
  })
})
