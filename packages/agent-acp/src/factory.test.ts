import type { ExternalAgentConfig } from "@cognia/agent-contracts/external-agent"
import { SILENT_AGENT_LOGGER } from "@cognia/agent-contracts/host"
import { AcpClientAdapter, type AcpClientDeps } from "./client"
import { isolateNativeAcp, type AcpIsolationHost } from "./factory"
import { IsolatedAcpAdapter } from "./isolated-adapter"
import { DevinAcpAdapter } from "./devin-adapter"
import { MiniMaxAcpAdapter } from "./minimax-adapter"

const host: AcpIsolationHost = {
  createClient: () => {
    const client = new AcpClientAdapter({} as AcpClientDeps)
    jest.spyOn(client, "disconnect").mockResolvedValue(undefined)
    return client
  },
  logger: SILENT_AGENT_LOGGER,
  isWithinRoot: (path, root) => path === root || path.startsWith(`${root}/`),
  stateKey: (id) => id,
  stateKeyEnv: "COGNIA_AGENT_STATE_KEY",
}
const config = (command: string): ExternalAgentConfig =>
  ({
    id: "saved-config",
    name: command,
    protocol: "acp",
    transport: "stdio",
    process: { command, args: ["acp"], cwd: "/project" },
  }) as ExternalAgentConfig

it("preserves the original executable matching rules when selecting native isolation", () => {
  const client = host.createClient()
  expect(isolateNativeAcp(config("DEVIN.EXE"), client, host)).toBe(client)
  expect(isolateNativeAcp(config("MCODE.EXE"), client, host)).toBeInstanceOf(MiniMaxAcpAdapter)
})

it.each([
  ["devin", DevinAcpAdapter],
  ["mcode", MiniMaxAcpAdapter],
])("selects the package-owned process strategy for %s", (command, Adapter) => {
  expect(isolateNativeAcp(config(command), host.createClient(), host)).toBeInstanceOf(Adapter)
})

it("preserves a plugin's client, including a subclass of the built-in client", () => {
  class CustomClient extends AcpClientAdapter {}
  const custom = new CustomClient({} as AcpClientDeps)
  expect(isolateNativeAcp(config("hermes"), custom, host)).toBe(custom)
  expect(isolateNativeAcp(config("devin"), undefined, host)).toBeUndefined()
})

it.each(["hermes", "commandcode", "zcode-acp"])(
  "refuses a project-less discovery for %s before starting any child",
  async (command) => {
    const client = host.createClient()
    const connect = jest.spyOn(client, "connect")
    const input = config(command)
    delete input.process!.cwd
    const isolated = isolateNativeAcp(input, client, host)!
    expect(isolated).toBeInstanceOf(IsolatedAcpAdapter)
    await expect(isolated.connect(input)).rejects.toThrow("workspace")
    expect(connect).not.toHaveBeenCalled()
  }
)

it("uses the configured Host containment check for a child workspace", async () => {
  const input = config("hermes")
  const client = host.createClient()
  jest.spyOn(client, "connect").mockResolvedValue(undefined)
  jest.spyOn(client, "connectionStatus", "get").mockReturnValue("connected")
  const isolated = isolateNativeAcp(input, client, host)!
  await isolated.connect(input)
  await expect(isolated.createSession({ cwd: "/other" })).rejects.toThrow("workspace")
  await isolated.disconnect()
})
