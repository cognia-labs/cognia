import type {
  ExternalAgentRuntimeCatalog,
  ExternalAgentRuntimeCatalogEntry,
} from "@cognia/agent-contracts/external-agent-lifecycle"
import { createRuntimeCatalog } from "./catalog"

export const entry: ExternalAgentRuntimeCatalogEntry = {
  runtimeId: "example",
  presetIds: ["example"],
  displayName: "Example",
  ownership: "system",
  protocol: "acp",
  transport: "stdio",
  platforms: ["darwin", "linux"],
  systemCommand: "example",
  versionProbe: { args: ["--version"], parser: "semver-anywhere", timeoutMs: 1000 },
  distributions: [],
  sandbox: { required: true, windowsExceptionEligible: false },
}
export function fixtureCatalog() {
  return createRuntimeCatalog(
    {
      version: 1,
      runtimes: [entry],
      unpinnedLaunchWaivers: { runtimes: {} },
    } as ExternalAgentRuntimeCatalog,
    {
      presetId: (config) =>
        typeof config.metadata?.preset === "string" ? config.metadata.preset : undefined,
      baseCommandName: (command) => command.toLowerCase().replace(/\.exe$/, ""),
    }
  )
}
it("binds only the catalog supplied by its Host and recognizes platform aliases", () => {
  const catalog = fixtureCatalog()
  expect(catalog.findRuntimeById("example")).toBe(entry)
  expect(catalog.findRuntimeById("unknown")).toBeUndefined()
  expect(
    catalog.deriveRuntimeBinding({ protocol: "acp", process: { command: "example" } })
  ).toEqual({ runtimeId: "example", ownership: "system" })
  expect(catalog.runtimeSupportsPlatform(entry, "macos")).toBe(true)
  expect(catalog.isWindowsExceptionEligible(entry, "windows")).toBe(false)
})
it("does not offer an unpinned managed distribution", () => {
  const catalog = fixtureCatalog()
  expect(
    catalog.selectDistribution({
      ...entry,
      distributions: [
        {
          provider: "npm",
          packageName: "example",
          lockAsset: { path: "", sha256: "" },
          version: "1.0.0",
          entrypoint: "example",
        },
      ],
    }).distribution
  ).toBeUndefined()
})
