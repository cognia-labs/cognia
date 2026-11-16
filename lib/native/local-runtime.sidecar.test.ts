/** @jest-environment jsdom */
import { transport } from "@/lib/tauri"
import {
  getSidecarStatus,
  getLiveSidecarSessionIds,
  ensureSidecarReady,
  restartSidecar,
} from "./local-runtime"

const TAURI_KEY = "__TAURI_INTERNALS__"

function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
}

let callSpy: jest.SpiedFunction<typeof transport.call>

beforeEach(() => {
  setTauri(true)
  callSpy = jest.spyOn(transport, "call")
})

afterEach(() => {
  setTauri(false)
  jest.restoreAllMocks()
})

describe("Agent Host lifecycle commands", () => {
  it("getSidecarStatus returns the parsed boolean", async () => {
    callSpy.mockResolvedValueOnce({ ready: true })
    await expect(getSidecarStatus()).resolves.toEqual({ ready: true })
  })

  it("ensureSidecarReady starts the Agent Host and returns its ready status", async () => {
    callSpy.mockResolvedValueOnce({ ready: true })
    await expect(ensureSidecarReady()).resolves.toEqual({ ready: true })
    expect(callSpy).toHaveBeenCalledWith("agent_start")
  })

  it("restartSidecar invokes its command", async () => {
    callSpy.mockResolvedValueOnce(undefined)
    await restartSidecar()
    expect(callSpy).toHaveBeenCalledWith("claude_restart_sidecar")
  })
})

describe("host-owned sidecar liveness", () => {
  it.each([["live"], []] as string[][])("reads active sessions from Rust: %j", async (...ids) => {
    callSpy.mockResolvedValue({ ready: true, liveSessionIds: ids })
    await expect(getLiveSidecarSessionIds()).resolves.toEqual(new Set(ids))
    expect(callSpy).toHaveBeenCalledWith("agent_status")
  })
  it.each([{}, { ready: true }, { liveSessionIds: [123] }])(
    "treats missing or invalid support as unknown: %j",
    async (status) => {
      callSpy.mockResolvedValue(status)
      await expect(getLiveSidecarSessionIds()).resolves.toBeUndefined()
    }
  )
  it("treats host errors as unknown", async () => {
    callSpy.mockRejectedValue(new Error("host disconnected"))
    await expect(getLiveSidecarSessionIds()).resolves.toBeUndefined()
  })
})

describe("web mode", () => {
  it("leaves host liveness unknown in web mode", async () => {
    setTauri(false)
    await expect(getLiveSidecarSessionIds()).resolves.toBeUndefined()
    expect(callSpy).not.toHaveBeenCalled()
  })

  it("rejects the status command with the WebStub error when no spy is attached", async () => {
    setTauri(false)
    callSpy.mockRestore()
    await expect(getSidecarStatus()).rejects.toThrow(/tauri-only command from web mode/)
  })
})
