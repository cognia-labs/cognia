import type { HostModuleManifest } from "./manifest-types"
import {
  __resetPortsForTesting,
  __setPortForTesting,
  __setPortModulesForTesting,
  loadPort,
  loadPortCollection,
  portCollectionProviders,
  portProvider,
  readPort,
  readPortCollection,
  subscribePorts,
} from "./ports"

interface EchoPort {
  echo(text: string): string
}

declare module "./ports" {
  interface PortMap {
    "test.echo": EchoPort
    "test.missing": EchoPort
  }
  interface PortCollectionMap {
    "test.voices": EchoPort
  }
}

const echo: EchoPort = { echo: (text) => text }

function provider(
  id: string,
  load: () => Promise<unknown>,
  stage: HostModuleManifest["stage"] = "stable"
): HostModuleManifest {
  return {
    id,
    kind: "module",
    stage,
    provides: [{ port: "test.echo", load: load as () => Promise<{ port: unknown }> }],
  }
}

beforeEach(() => {
  __resetPortsForTesting()
})

describe("capability ports", () => {
  it("loads the provider's port once and remembers it", async () => {
    const load = jest.fn(async () => ({ port: echo }))
    __setPortModulesForTesting([provider("echoer", load)])
    expect(readPort("test.echo")).toBeUndefined()
    const [a, b] = await Promise.all([loadPort("test.echo"), loadPort("test.echo")])
    expect(a).toBe(echo)
    expect(b).toBe(echo)
    expect(await loadPort("test.echo")).toBe(echo)
    expect(readPort("test.echo")).toBe(echo)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("answers null for a port no module provides, without loading anything", async () => {
    __setPortModulesForTesting([provider("echoer", async () => ({ port: echo }))])
    expect(await loadPort("test.missing")).toBeNull()
    expect(readPort("test.missing")).toBeNull()
  })

  it("names the module that provides a port", () => {
    __setPortModulesForTesting([provider("echoer", async () => ({ port: echo }))])
    expect(portProvider("test.echo")?.module).toBe("echoer")
    expect(portProvider("test.missing")).toBeNull()
  })

  it("refuses two providers of one port", () => {
    const load = async () => ({ port: echo })
    __setPortModulesForTesting([provider("a", load), provider("b", load)])
    expect(() => portProvider("test.echo")).toThrow(/one provider/)
  })

  it("reads providers from the active modules of the generated registry by default", () => {
    // The generated registry never lists the test-only port: no module provides it.
    expect(portProvider("test.echo")).toBeNull()
  })

  it("rejects a provider file that exports no port, and tries again next time", async () => {
    const load = jest
      .fn<Promise<unknown>, []>()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ port: echo })
    __setPortModulesForTesting([provider("echoer", load)])
    await expect(loadPort("test.echo")).rejects.toThrow(/exports no port/)
    expect(readPort("test.echo")).toBeUndefined()
    expect(await loadPort("test.echo")).toBe(echo)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it("tries a failed load again", async () => {
    const load = jest
      .fn<Promise<unknown>, []>()
      .mockRejectedValueOnce(new Error("chunk failed"))
      .mockResolvedValueOnce({ port: echo })
    __setPortModulesForTesting([provider("echoer", load)])
    await expect(loadPort("test.echo")).rejects.toThrow("chunk failed")
    expect(await loadPort("test.echo")).toBe(echo)
  })

  it("tells subscribers when a port resolves, and stops after unsubscribe", async () => {
    __setPortModulesForTesting([provider("echoer", async () => ({ port: echo }))])
    const listener = jest.fn()
    const unsubscribe = subscribePorts(listener)
    await loadPort("test.echo")
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    __setPortForTesting("test.echo", null)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("keeps telling the others when one subscriber throws", async () => {
    __setPortModulesForTesting([provider("echoer", async () => ({ port: echo }))])
    const error = jest.spyOn(console, "error").mockImplementation(() => {})
    const after = jest.fn()
    subscribePorts(() => {
      throw new Error("boom")
    })
    subscribePorts(after)
    await loadPort("test.echo")
    expect(after).toHaveBeenCalled()
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it("lets a test answer a port directly", async () => {
    __setPortForTesting("test.echo", echo)
    expect(readPort("test.echo")).toBe(echo)
    expect(await loadPort("test.echo")).toBe(echo)
    __setPortForTesting("test.echo", null)
    expect(await loadPort("test.echo")).toBeNull()
  })
})

describe("collection ports", () => {
  function member(
    id: string,
    load: () => Promise<unknown>,
    stage: HostModuleManifest["stage"] = "stable"
  ): HostModuleManifest {
    return {
      id,
      kind: "module",
      stage,
      provides: [{ port: "test.voices", load: load as () => Promise<{ port: unknown }> }],
    }
  }
  const loud: EchoPort = { echo: (text) => text.toUpperCase() }

  it("loads every provider's member once, in registry order", async () => {
    const quietLoad = jest.fn(async () => ({ port: echo }))
    const loudLoad = jest.fn(async () => ({ port: loud }))
    __setPortModulesForTesting([member("quiet", quietLoad), member("loud", loudLoad)])
    expect(portCollectionProviders("test.voices").map((p) => p.module)).toEqual(["quiet", "loud"])
    expect(readPortCollection("test.voices")).toEqual([])
    const [first] = await Promise.all([
      loadPortCollection("test.voices"),
      loadPortCollection("test.voices"),
    ])
    expect(first).toEqual({
      members: [
        { module: "quiet", port: echo },
        { module: "loud", port: loud },
      ],
      failures: [],
    })
    await loadPortCollection("test.voices")
    expect(quietLoad).toHaveBeenCalledTimes(1)
    expect(loudLoad).toHaveBeenCalledTimes(1)
    expect(readPortCollection("test.voices").map((m) => m.module)).toEqual(["quiet", "loud"])
  })

  it("keeps the other members when one fails, and retries the failed one next time", async () => {
    const broken = jest
      .fn<Promise<unknown>, []>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ port: loud })
    __setPortModulesForTesting([
      member("quiet", async () => ({ port: echo })),
      member("loud", broken),
    ])
    const first = await loadPortCollection("test.voices")
    expect(first.members).toEqual([{ module: "quiet", port: echo }])
    expect(first.failures).toEqual([{ module: "loud", error: new Error("offline") }])
    const second = await loadPortCollection("test.voices")
    expect(second.members.map((m) => m.module)).toEqual(["quiet", "loud"])
    expect(second.failures).toEqual([])
  })

  it("reports a provider file that exports no port as a failure", async () => {
    __setPortModulesForTesting([member("empty", async () => ({}))])
    const { members, failures } = await loadPortCollection("test.voices")
    expect(members).toEqual([])
    expect(String(failures[0].error)).toMatch(/exports no port/)
  })

  it("is empty when no module provides it", async () => {
    __setPortModulesForTesting([])
    expect(await loadPortCollection("test.voices")).toEqual({ members: [], failures: [] })
  })

  it("tells subscribers as each member arrives", async () => {
    __setPortModulesForTesting([member("quiet", async () => ({ port: echo }))])
    const listener = jest.fn()
    subscribePorts(listener)
    await loadPortCollection("test.voices")
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("forgets loaded members on reset", async () => {
    __setPortModulesForTesting([member("quiet", async () => ({ port: echo }))])
    await loadPortCollection("test.voices")
    __resetPortsForTesting()
    expect(readPortCollection("test.voices")).toEqual([])
  })
})
