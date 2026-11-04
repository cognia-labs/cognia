import {
  resolvePiSubagents,
  piSubagentSupport,
  type PiSubagentSnapshotDeps,
} from "./subagent-snapshot"
import type { ExternalAgentConfig } from "@cognia/agent-contracts/external-agent"

it("snapshots an installed pinned executor through injected ports and drops stale support", async () => {
  const files: Record<string, string> = {
    "/pi/settings.json": JSON.stringify({ packages: ["npm:pi-subagents@0.80.0"] }),
    "/pi/npm/node_modules/pi-subagents/package.json": JSON.stringify({
      name: "pi-subagents",
      version: "0.80.0",
      pi: { extensions: ["index.js"] },
    }),
    "/pi/npm/node_modules/pi-subagents/index.js": "extension",
  }
  const deps: PiSubagentSnapshotDeps = {
    agentDir: async () => "/pi",
    read: async (path) => files[path] ?? null,
    list: async () => [],
    parseSource: () => ({ kind: "npm", name: "pi-subagents" }),
    packages: (settings) => settings.packages as string[],
    parseFrontmatter: (content) => ({ data: {}, body: content }),
    digest: (content) => content,
  }
  const config = { protocol: "pi-rpc", process: { command: "pi" } } as ExternalAgentConfig
  const prepared = await resolvePiSubagents(config, deps)
  expect(piSubagentSupport(prepared)?.version).toBe("0.80.0")
  delete files["/pi/npm/node_modules/pi-subagents/index.js"]
  expect(piSubagentSupport(await resolvePiSubagents(prepared, deps))).toBeUndefined()
  const read = jest.fn(deps.read)
  await resolvePiSubagents({ ...prepared, protocol: "acp" }, { ...deps, read })
  expect(read).not.toHaveBeenCalled()
})
