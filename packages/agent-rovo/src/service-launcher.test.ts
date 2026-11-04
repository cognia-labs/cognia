import type { AgentProcessHost } from "@cognia/agent-contracts/host"
import type { ExternalAgentConfig } from "@cognia/agent-contracts/external-agent"
import { createRovoDevServiceLauncher } from "./service-launcher"
it("requires a Host placement grant before attempting a service spawn", async () => {
  const spawn = jest.fn()
  const launcher = createRovoDevServiceLauncher(
    { available: true, spawn } as unknown as AgentProcessHost,
    jest.fn(),
    {
      assertLocal: () => {
        throw new Error("placement denied")
      },
      resolveEnvironment: async (_config, env) => env,
    }
  )
  await expect(launcher({ id: "agent" } as ExternalAgentConfig, "/work")).rejects.toThrow(
    "placement denied"
  )
  expect(spawn).not.toHaveBeenCalled()
})
