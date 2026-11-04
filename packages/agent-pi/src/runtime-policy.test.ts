import type { ProtocolAdapter } from "@cognia/agent-contracts/adapter"
import { PiRpcClientAdapter } from "./rpc-client"
import { piRuntimePolicy } from "./runtime-policy"
it("prefers RPC model ordering and uses the CLI listing only when discovery is unavailable", async () => {
  const adapter = Object.create(PiRpcClientAdapter.prototype)
  adapter.listAgentModelsViaRpc = jest.fn(async () => ({
    currentModelId: "",
    availableModels: [{ modelId: "p/m", name: "Native name" }],
  }))
  adapter.listAgentModels = jest.fn(async () => ({
    status: "ok",
    models: [{ provider: "p", id: "m" }],
  }))
  expect(await piRuntimePolicy.discoverModels!(adapter as ProtocolAdapter)).toMatchObject({
    kind: "session-models",
    models: { availableModels: [{ name: "Native name" }] },
  })
  expect(adapter.listAgentModels).not.toHaveBeenCalled()
  adapter.listAgentModelsViaRpc.mockResolvedValueOnce(null)
  expect(await piRuntimePolicy.discoverModels!(adapter as ProtocolAdapter)).toEqual({
    kind: "catalog",
    models: [{ id: "p/m", name: "p/m" }],
  })
})
