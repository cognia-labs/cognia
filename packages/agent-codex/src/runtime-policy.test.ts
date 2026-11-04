import type { ExternalAgentConfig } from "@cognia/agent-contracts/external-agent"
import { codexRuntimePolicy } from "./runtime-policy"
it("keeps native timeout/retry ownership and transmits only the Host's granted write scope", () => {
  const config = {
    protocol: "codex-app-server",
    codexOptions: { writableRoots: ["/ungranted"] },
  } as ExternalAgentConfig
  expect(codexRuntimePolicy.ownsExecutionRetries).toBe(true)
  expect(codexRuntimePolicy.ownsConnectionTimeout).toBe(true)
  expect(
    codexRuntimePolicy.connectionConfig!(config, undefined).codexOptions?.writableRoots
  ).toEqual([])
  expect(
    codexRuntimePolicy.sessionMetadata!(config, undefined, {
      roots: ["/granted"],
      ceiling: ["/project"],
      permissionMode: "acceptEdits",
      users: 1,
      ready: Promise.resolve(),
    }).codexOptions
  ).toMatchObject({ writableRoots: ["/granted"] })
})
