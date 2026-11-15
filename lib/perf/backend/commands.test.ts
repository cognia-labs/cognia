const isTauriMock = jest.fn()
const callMock = jest.fn()
const subscribeMock = jest.fn()

jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
  transport: {
    call: (...args: unknown[]) => callMock(...args),
    subscribe: (...args: unknown[]) => subscribeMock(...args),
  },
}))

import {
  PERF_FRAME_EVENT,
  controlManagedProcess,
  listManagedProcesses,
  perfHotspots,
  perfListTraces,
  perfOpenTraceDir,
  perfOpenTrace,
  perfReadTraceChunk,
  perfCloseTrace,
  perfReadSystemDetails,
  perfResetHotspots,
  perfSnapshot,
  perfSystemDetails,
  subscribePerfFrame,
} from "./commands"

beforeEach(() => {
  isTauriMock.mockReset()
  callMock.mockReset()
  subscribeMock.mockReset()
})

describe("when not in Tauri", () => {
  beforeEach(() => isTauriMock.mockReturnValue(false))

  it("returns inert values without calling transport", async () => {
    expect(await perfSnapshot()).toEqual(
      expect.objectContaining({ frames: [], running: false, intervalMs: 1000 })
    )
    expect(await perfHotspots()).toEqual([])
    expect(await perfListTraces()).toEqual([])
    expect(await perfSystemDetails()).toBeNull()
    await perfResetHotspots()
    await perfOpenTraceDir()
    expect(await listManagedProcesses()).toEqual([])
    await controlManagedProcess("chatSidecar", "chat-sidecar", "kill")
    expect(callMock).not.toHaveBeenCalled()
  })

  it("routes selected-host system details even outside a local Tauri shell", async () => {
    callMock.mockResolvedValueOnce({ os: "linux" })
    await expect(perfReadSystemDetails()).resolves.toEqual({ os: "linux" })
    expect(callMock).toHaveBeenCalledWith("perf_system_details")
  })
})

describe("when in Tauri", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(true)
    callMock.mockResolvedValue(undefined)
  })

  it("perfSnapshot calls the command", async () => {
    callMock.mockResolvedValueOnce({ frames: [], running: true, intervalMs: 1000 })
    const snap = await perfSnapshot()
    expect(callMock).toHaveBeenCalledWith("perf_snapshot")
    expect(snap.running).toBe(true)
  })

  it("reset / hotspots / traces / system / open call their commands", async () => {
    await perfResetHotspots()
    expect(callMock).toHaveBeenCalledWith("perf_reset_hotspots")

    callMock.mockResolvedValueOnce([])
    await perfHotspots()
    expect(callMock).toHaveBeenCalledWith("perf_hotspots")

    callMock.mockResolvedValueOnce([])
    await perfListTraces()
    expect(callMock).toHaveBeenCalledWith("perf_list_traces")

    callMock.mockResolvedValueOnce({ os: "x" })
    await perfSystemDetails()
    expect(callMock).toHaveBeenCalledWith("perf_system_details")

    await perfOpenTraceDir()
    expect(callMock).toHaveBeenCalledWith("perf_open_trace_dir")

    callMock.mockResolvedValueOnce({ handleId: "handle-a" })
    await perfOpenTrace("trace-a")
    expect(callMock).toHaveBeenCalledWith("perf_trace_open", { traceId: "trace-a" })
    callMock.mockResolvedValueOnce({ eof: true })
    await perfReadTraceChunk("handle-a", 0, 1024)
    expect(callMock).toHaveBeenCalledWith("perf_trace_read_chunk", {
      handleId: "handle-a",
      offset: 0,
      length: 1024,
    })
    await perfCloseTrace("handle-a")
    expect(callMock).toHaveBeenCalledWith("perf_trace_close", { handleId: "handle-a" })
  })

  it("subscribePerfFrame wires transport.subscribe to the frame event", () => {
    const unsub = jest.fn()
    subscribeMock.mockReturnValue(unsub)
    const handler = jest.fn()
    const result = subscribePerfFrame(handler)
    expect(subscribeMock).toHaveBeenCalledWith(PERF_FRAME_EVENT, handler)
    expect(result).toBe(unsub)
  })

  it("listManagedProcesses calls the command", async () => {
    callMock.mockResolvedValueOnce([{ subsystem: "chatSidecar", id: "chat-sidecar" }])
    const rows = await listManagedProcesses()
    expect(callMock).toHaveBeenCalledWith("list_managed_processes")
    expect(rows).toHaveLength(1)
  })

  it("controlManagedProcess forwards subsystem/id/action", async () => {
    await controlManagedProcess("mcpServer", "mcp-server", "kill")
    expect(callMock).toHaveBeenCalledWith("control_managed_process", {
      subsystem: "mcpServer",
      id: "mcp-server",
      action: "kill",
    })
  })
})
