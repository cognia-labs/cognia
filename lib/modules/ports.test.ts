import type { HostModuleManifest } from "./manifest-types"
import {
  __resetPortsForTesting,
  __setPortForTesting,
  __setPortModulesForTesting,
  loadPort,
  portProvider,
  readPort,
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
