/**
 * @jest-environment jsdom
 */

let mockChain: string[] = []
const mockDescribeHost = jest.fn(async () => {})

jest.mock("./pick-transport", () => ({
  selectTerminalTransportChain: () => mockChain,
}))

jest.mock("./transport-ws", () => ({
  RemoteTerminalSession: {
    describeHost: (...args: unknown[]) => mockDescribeHost(...(args as [])),
  },
}))

import { __resetRoutingForTests, setActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import type { Transport } from "@/lib/tauri/transport-types"
import {
  __resetHostCapabilitiesForTests,
  currentTerminalHostKey,
  ensureHostCapabilities,
  getHostCapabilities,
  parseHostCapabilities,
  recordHostCapabilities,
  subscribeHostCapabilities,
  getProtocolFeatures,
  hostSupportsProtocolFeature,
  recordProtocolFeatures,
} from "./host-capabilities"

const HOST = {
  platform: "linux",
  defaultShell: "/bin/bash",
  availableShells: [
    { path: "/bin/bash", kind: "bash" },
    { path: "/bin/sh", kind: "sh" },
  ],
  homeDir: "/root",
}

/** A stand-in for the remote transport the routing holder installs per switch. */
function remoteTransport(): Transport {
  return { call: jest.fn(), subscribe: jest.fn(() => () => undefined) } as unknown as Transport
}

const WINDOWS_HOST = {
  platform: "windows",
  defaultShell: "pwsh.exe",
  availableShells: [{ path: "pwsh.exe", kind: "pwsh" }],
  homeDir: "C:\\Users\\me",
}

beforeEach(() => {
  __resetRoutingForTests()
  __resetHostCapabilitiesForTests()
  mockChain = []
  mockDescribeHost.mockReset()
  mockDescribeHost.mockResolvedValue(undefined)
})

describe("parseHostCapabilities", () => {
  it("accepts a complete description", () => {
    expect(parseHostCapabilities(HOST)).toEqual(HOST)
  })

  // A blank default shell would be handed straight to the host as the shell to
  // spawn, and the caller cannot tell it apart from a deliberate choice.
  it("rejects a description with no usable default shell", () => {
    expect(parseHostCapabilities({ ...HOST, defaultShell: "   " })).toBeNull()
    expect(parseHostCapabilities({ ...HOST, defaultShell: 42 })).toBeNull()
  })

  it("rejects a platform outside the shared vocabulary", () => {
    expect(parseHostCapabilities({ ...HOST, platform: "plan9" })).toBeNull()
  })

  it("drops malformed shell entries rather than the whole description", () => {
    const parsed = parseHostCapabilities({
      ...HOST,
      availableShells: [{ path: "/bin/bash" }, { path: "" }, null, { kind: "zsh" }],
    })
    expect(parsed?.availableShells).toEqual([{ path: "/bin/bash", kind: "unknown" }])
  })

  it("ignores junk", () => {
    expect(parseHostCapabilities(undefined)).toBeNull()
    expect(parseHostCapabilities("nope")).toBeNull()
  })
})

describe("recordHostCapabilities", () => {
  it("publishes the host and notifies subscribers", () => {
    const listener = jest.fn()
    subscribeHostCapabilities(listener)
    recordHostCapabilities(HOST)
    expect(getHostCapabilities()).toEqual(HOST)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  // Every list frame carries the description, and the reattach path lists on
  // every boot; re-notifying on an unchanged host would re-render the picker
  // and the spawn path for nothing.
  it("does not notify when the host has not changed", () => {
    recordHostCapabilities(HOST)
    const listener = jest.fn()
    subscribeHostCapabilities(listener)
    recordHostCapabilities({ ...HOST })
    expect(listener).not.toHaveBeenCalled()
  })

  it("notifies when the host answers differently", () => {
    recordHostCapabilities(HOST)
    const listener = jest.fn()
    subscribeHostCapabilities(listener)
    recordHostCapabilities({ ...HOST, defaultShell: "/bin/zsh" })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(getHostCapabilities()?.defaultShell).toBe("/bin/zsh")
  })

  it("leaves the cache alone when handed junk", () => {
    recordHostCapabilities(HOST)
    recordHostCapabilities({ platform: "linux" })
    expect(getHostCapabilities()).toEqual(HOST)
  })
})

describe("ensureHostCapabilities", () => {
  it("returns the cache without probing when it is warm", async () => {
    recordHostCapabilities(HOST)
    await expect(ensureHostCapabilities()).resolves.toEqual(HOST)
    expect(mockDescribeHost).not.toHaveBeenCalled()
  })

  // The local PTY *is* the host: `shell-detect` already describes it, and a
  // remote probe there would be nonsense.
  it("never probes on the local PTY", async () => {
    mockChain = ["tauri-channel"]
    await expect(ensureHostCapabilities()).resolves.toBeNull()
    expect(mockDescribeHost).not.toHaveBeenCalled()
  })

  it("returns null without probing in web standalone", async () => {
    mockChain = []
    await expect(ensureHostCapabilities()).resolves.toBeNull()
    expect(mockDescribeHost).not.toHaveBeenCalled()
  })

  it("probes the host over a remote transport", async () => {
    mockChain = ["ws", "webrtc"]
    mockDescribeHost.mockImplementation(async () => {
      recordHostCapabilities(HOST)
    })
    await expect(ensureHostCapabilities()).resolves.toEqual(HOST)
    expect(mockDescribeHost).toHaveBeenCalledTimes(1)
  })

  // The dock's "+ New" and the shell picker opening together must not each pay
  // a socket ticket and a WebSocket.
  it("shares one probe between concurrent callers", async () => {
    mockChain = ["ws"]
    mockDescribeHost.mockImplementation(async () => {
      recordHostCapabilities(HOST)
    })
    const [a, b] = await Promise.all([ensureHostCapabilities(), ensureHostCapabilities()])
    expect(a).toEqual(HOST)
    expect(b).toEqual(HOST)
    expect(mockDescribeHost).toHaveBeenCalledTimes(1)
  })

  // Callers are on the spawn path: a failed probe must degrade to the caller's
  // own guess, not take the spawn down.
  it("swallows a failed probe and reports an unknown host", async () => {
    mockChain = ["ws"]
    mockDescribeHost.mockRejectedValue(new Error("unpaired"))
    await expect(ensureHostCapabilities()).resolves.toBeNull()
  })

  it("retries after a failed probe rather than caching the failure", async () => {
    mockChain = ["ws"]
    mockDescribeHost.mockRejectedValueOnce(new Error("host offline"))
    await expect(ensureHostCapabilities()).resolves.toBeNull()
    mockDescribeHost.mockImplementation(async () => {
      recordHostCapabilities(HOST)
    })
    await expect(ensureHostCapabilities()).resolves.toEqual(HOST)
    expect(mockDescribeHost).toHaveBeenCalledTimes(2)
  })
})

describe("protocol features", () => {
  beforeEach(() => {
    __resetHostCapabilitiesForTests()
  })

  it("starts unknown, which is not the same as empty", () => {
    expect(getProtocolFeatures()).toBeNull()
  })

  /**
   * The local PTY never sends a hello, and a probe that has not run yet has not
   * proved anything. Answering `false` there would turn "nobody asked" into
   * "the host cannot", which is how a working feature gets hidden.
   */
  it("assumes an un-introduced host speaks everything", () => {
    expect(hostSupportsProtocolFeature("sshForwarding")).toBe(true)
  })

  it("answers from the list once a host has introduced itself", () => {
    recordProtocolFeatures(["flowControl", "history"])
    expect(hostSupportsProtocolFeature("flowControl")).toBe(true)
    expect(hostSupportsProtocolFeature("sshForwarding")).toBe(false)
  })

  it("treats a host that named nothing as naming nothing", () => {
    recordProtocolFeatures([])
    expect(getProtocolFeatures()).toEqual([])
    expect(hostSupportsProtocolFeature("history")).toBe(false)
  })

  it("ignores junk rather than forgetting what the host said", () => {
    recordProtocolFeatures(["history"])
    recordProtocolFeatures("history")
    recordProtocolFeatures(null)
    expect(getProtocolFeatures()).toEqual(["history"])
  })

  it("keeps a name this build has never heard of", () => {
    recordProtocolFeatures(["history", "somethingNewer"])
    expect(getProtocolFeatures()).toEqual(["history", "somethingNewer"])
  })

  it("notifies subscribers, and only when the list actually changed", () => {
    const listener = jest.fn()
    const stop = subscribeHostCapabilities(listener)
    recordProtocolFeatures(["history"])
    recordProtocolFeatures(["history"])
    expect(listener).toHaveBeenCalledTimes(1)
    recordProtocolFeatures(["history", "sshForwarding"])
    expect(listener).toHaveBeenCalledTimes(2)
    stop()
  })
})

/**
 * A desktop can switch the Host it drives without reloading. Every cached answer
 * belongs to the host it came from: handing host A's `/bin/bash` to a spawn on
 * Windows host B, or to the desktop's own PTY, is the exact wrong-shell failure
 * this cache exists to prevent.
 */
describe("host switches", () => {
  it("does not hand one Host's answer to the next", async () => {
    mockChain = ["ws"]
    setActiveRemoteTransport(remoteTransport())
    recordHostCapabilities(HOST)
    recordProtocolFeatures(["history"])
    expect(getHostCapabilities()).toEqual(HOST)

    setActiveRemoteTransport(remoteTransport())
    expect(getHostCapabilities()).toBeNull()
    expect(getProtocolFeatures()).toBeNull()
    // Unknown again, so the feature gate falls back to trying.
    expect(hostSupportsProtocolFeature("sshForwarding")).toBe(true)

    mockDescribeHost.mockImplementation(async () => {
      recordHostCapabilities(WINDOWS_HOST)
    })
    await expect(ensureHostCapabilities()).resolves.toEqual(WINDOWS_HOST)
    expect(mockDescribeHost).toHaveBeenCalledTimes(1)
  })

  it("forgets the remote Host's answer when the desktop returns to its own PTY", async () => {
    mockChain = ["ws"]
    setActiveRemoteTransport(remoteTransport())
    recordHostCapabilities(WINDOWS_HOST)
    setActiveRemoteTransport(null)
    mockChain = ["tauri-channel"]
    expect(getHostCapabilities()).toBeNull()
    await expect(ensureHostCapabilities()).resolves.toBeNull()
    expect(mockDescribeHost).not.toHaveBeenCalled()
  })

  it("drops an answer that arrives for a Host no longer selected", async () => {
    mockChain = ["ws"]
    setActiveRemoteTransport(remoteTransport())
    const keyA = currentTerminalHostKey()
    setActiveRemoteTransport(remoteTransport())
    recordHostCapabilities(HOST, keyA)
    recordProtocolFeatures(["history"], keyA)
    expect(getHostCapabilities()).toBeNull()
    expect(getProtocolFeatures()).toBeNull()
  })

  it("does not let a probe still running for the previous Host answer for the new one", async () => {
    mockChain = ["ws"]
    setActiveRemoteTransport(remoteTransport())
    let finishFirst: () => void = () => undefined
    mockDescribeHost.mockImplementationOnce((async (key: string) => {
      await new Promise<void>((resolve) => {
        finishFirst = resolve
      })
      recordHostCapabilities(HOST, key)
    }) as never)
    const first = ensureHostCapabilities()
    // Let the first probe actually reach the host before switching away.
    while (mockDescribeHost.mock.calls.length < 1) await new Promise((r) => setTimeout(r, 0))
    setActiveRemoteTransport(remoteTransport())
    mockDescribeHost.mockImplementationOnce((async (key: string) => {
      recordHostCapabilities(WINDOWS_HOST, key)
    }) as never)
    const second = ensureHostCapabilities()
    finishFirst()
    await expect(first).resolves.toBeNull()
    await expect(second).resolves.toEqual(WINDOWS_HOST)
    expect(getHostCapabilities()).toEqual(WINDOWS_HOST)
  })

  it("tells subscribers when the selected Host changes", () => {
    const listener = jest.fn()
    const off = subscribeHostCapabilities(listener)
    setActiveRemoteTransport(remoteTransport())
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    setActiveRemoteTransport(null)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
