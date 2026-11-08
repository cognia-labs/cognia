/**
 * @jest-environment jsdom
 *
 * Pins the places a serial session is NOT a PTY, because each one is a
 * base-class assumption that a cable cannot answer: resize is a no-op, the
 * exit carries no code, a failed write must throw rather than resolve, and a
 * detach closes the port because nothing could reattach to it.
 */

const subscribeMock = jest.fn()
const routingSubscribeMock = jest.fn(() => () => undefined)
// The port is this machine's, so its topics come from the LOCAL transport. The
// routing one follows whichever Host the desktop selected and must stay unused.
jest.mock("@/lib/tauri/transport-instance", () => ({
  localTransport: {
    subscribe: (topic: string, handler: (payload: unknown) => void) =>
      subscribeMock(topic, handler),
  },
  transport: { subscribe: () => routingSubscribeMock() },
}))
jest.mock("@/lib/tauri", () => ({
  transport: { subscribe: () => routingSubscribeMock() },
}))

const openSerialPortMock = jest.fn()
const attachSerialPortMock = jest.fn()
const writeSerialPortMock = jest.fn()
const closeSerialPortMock = jest.fn()
/** Every host call, in the order the session made it. */
const calls: string[] = []
jest.mock("./serial/serial-connection", () => {
  const actual = jest.requireActual("./serial/serial-connection")
  return {
    ...actual,
    openSerialPort: (...args: Parameters<typeof openSerialPortMock>) => openSerialPortMock(...args),
    attachSerialPort: (...args: Parameters<typeof attachSerialPortMock>) =>
      attachSerialPortMock(...args),
    writeSerialPort: (...args: Parameters<typeof writeSerialPortMock>) =>
      writeSerialPortMock(...args),
    closeSerialPort: (...args: Parameters<typeof closeSerialPortMock>) =>
      closeSerialPortMock(...args),
  }
})

import { DEFAULT_SERIAL_CONFIG } from "./serial/types"
import {
  decodeBase64,
  SerialTerminalSession,
  serialDataTopic,
  serialStatusTopic,
} from "./serial-session"

const config = { ...DEFAULT_SERIAL_CONFIG, port: "/dev/cu.usbserial-1420" }
/** topic → the handler the session registered for it. */
const handlers = new Map<string, (payload: unknown) => void>()

beforeEach(() => {
  handlers.clear()
  calls.length = 0
  subscribeMock.mockReset().mockImplementation((topic: string, handler) => {
    calls.push("subscribe")
    handlers.set(topic, handler)
    return () => handlers.delete(topic)
  })
  openSerialPortMock.mockReset().mockImplementation(async () => {
    calls.push("open")
    return { sessionId: "sess-1" }
  })
  attachSerialPortMock.mockReset().mockImplementation(async () => {
    calls.push("attach")
    return true
  })
  writeSerialPortMock.mockReset().mockResolvedValue(true)
  closeSerialPortMock.mockReset().mockResolvedValue(true)
})

it("labels the tab with the port and its line settings", async () => {
  const session = await SerialTerminalSession.open(config, "proj-a")
  expect(session.info.id).toBe("sess-1")
  expect(session.info.kind).toBe("serial")
  expect(session.info.projectId).toBe("proj-a")
  expect(session.info.shell).toBe("/dev/cu.usbserial-1420 (115200 8N1)")
})

/**
 * A device that greets on open (most bootloaders do) sends its banner before
 * any consumer mounts, and a Tauri event is not buffered. The host therefore
 * reads nothing until the attach, and the attach must come after both
 * subscriptions or the banner is emitted with nobody listening.
 */
it("opens, subscribes, and only then attaches", async () => {
  await SerialTerminalSession.open(config)
  expect(handlers.has(serialDataTopic("sess-1"))).toBe(true)
  expect(handlers.has(serialStatusTopic("sess-1"))).toBe(true)
  expect(calls).toEqual(["open", "subscribe", "subscribe", "attach"])
  expect(attachSerialPortMock).toHaveBeenCalledWith("sess-1")
})

/**
 * Writes are direct local IPC. Subscribing through the routing transport moved
 * the port's output to a remote Host the moment one was selected, while
 * keystrokes still went to the cable — a probe sent `ABC` and saw `AC`.
 */
it("listens on the local transport, never the Host-routing one", async () => {
  await SerialTerminalSession.open(config)
  expect(subscribeMock).toHaveBeenCalledTimes(2)
  expect(routingSubscribeMock).not.toHaveBeenCalled()
})

/**
 * The host not knowing the id means the session died between the two calls.
 * Returning it anyway would hand back a tab that can never produce a byte.
 */
it("refuses the session when the attach finds nothing to attach to", async () => {
  attachSerialPortMock.mockImplementation(async () => {
    calls.push("attach")
    return false
  })
  await expect(SerialTerminalSession.open(config)).rejects.toThrow(
    /was gone before it could stream/
  )
  expect(closeSerialPortMock).toHaveBeenCalledWith("sess-1")
  expect(handlers.size).toBe(0)
})

it("decodes inbound base64 into the data stream", async () => {
  const session = await SerialTerminalSession.open(config)
  const seen: Uint8Array[] = []
  session.onData((bytes) => seen.push(bytes))
  handlers.get(serialDataTopic("sess-1"))?.({ base64: btoa("boot\r\n") })
  expect(new TextDecoder().decode(seen[0])).toBe("boot\r\n")
})

/**
 * A cable pulled mid-transfer must be visible IN the stream. The scrollback
 * above it is real data, and without a marker there is nothing to tell the
 * user where the device stopped answering.
 */
it("writes the failure into the stream and exits with no code", async () => {
  const session = await SerialTerminalSession.open(config)
  const seen: string[] = []
  session.onData((bytes) => seen.push(new TextDecoder().decode(bytes)))
  const exits: (number | null)[] = []
  session.onExit((code) => exits.push(code))

  handlers.get(serialStatusTopic("sess-1"))?.({
    status: "error",
    reason: "the device closed the port",
  })

  expect(seen.join("")).toContain("the device closed the port")
  // Not 0, not 1. There was no process, so there is no exit code, and the dock
  // renders `null` as "no exit code" the same way it does for a signalled shell.
  expect(exits).toEqual([null])
  expect(session.connectionStatus).toBe("error")
})

it("passes bytes through on write and throws when the port refuses", async () => {
  const session = await SerialTerminalSession.open(config)
  await session.write("AT\r\n")
  expect(writeSerialPortMock).toHaveBeenCalledWith("sess-1", "AT\r\n")

  writeSerialPortMock.mockResolvedValue(false)
  await expect(session.write("AT\r\n")).rejects.toThrow(/did not accept/)
})

/** A serial line has no window size. Resizing must not reach the device. */
it("resizes without touching the transport", async () => {
  const session = await SerialTerminalSession.open(config)
  await expect(session.resize(120, 40)).resolves.toBeUndefined()
  expect(writeSerialPortMock).not.toHaveBeenCalled()
})

it("closes the port and stops listening on kill", async () => {
  const session = await SerialTerminalSession.open(config)
  await session.kill()
  expect(closeSerialPortMock).toHaveBeenCalledWith("sess-1")
  expect(handlers.size).toBe(0)
  expect(session.connectionStatus).toBe("disconnected")
})

it("surfaces an open failure as a throw rather than a half-built session", async () => {
  openSerialPortMock.mockResolvedValue({ error: "permission denied" })
  await expect(SerialTerminalSession.open(config)).rejects.toThrow(/permission denied/)
})

it("decodes base64 to bytes, including high bytes a text decoder would mangle", () => {
  expect(Array.from(decodeBase64(btoa("\x00\xff\x7f")))).toEqual([0, 255, 127])
})

/**
 * A detached PTY lives on in the durable host and is listed for reattach. A
 * serial port has no such owner: detaching used to leave it open with no way
 * back, holding the device busy for any later open.
 */
it("closes the port on detach, since nothing could reattach to it", async () => {
  const session = await SerialTerminalSession.open(config)
  const exits: (number | null)[] = []
  session.onExit((code) => exits.push(code))
  expect(session.reattachable).toBe(false)
  await session.detach()
  expect(handlers.size).toBe(0)
  expect(closeSerialPortMock).toHaveBeenCalledWith("sess-1")
  expect(session.connectionStatus).toBe("disconnected")
  expect(exits).toEqual([null])
})

it("closes the port once even when detach and kill both run", async () => {
  const session = await SerialTerminalSession.open(config)
  await session.detach()
  await session.kill()
  expect(closeSerialPortMock).toHaveBeenCalledTimes(1)
})

it("rejects PTY controller leases for a serial port", async () => {
  const session = await SerialTerminalSession.open(config)
  await expect(session.takeControl()).rejects.toThrow(
    "Serial sessions do not support controller leases"
  )
  await expect(session.releaseControl()).rejects.toThrow(
    "Serial sessions do not support controller leases"
  )
  expect(writeSerialPortMock).not.toHaveBeenCalled()
})
