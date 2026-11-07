import {
  BUILD_SITE_TOOL_NAME,
  DEPLOY_SITE_TOOL_NAME,
  LIST_SITES_TOOL_NAME,
  SITES_TOOL_NAMES,
  buildSitesManifestEntries,
  runSitesBuiltinTool,
  toolFamily,
  type SitesToolRunDeps,
} from "./agent-tools"
import type { ToolSurfaceContext } from "@/lib/modules/manifest-types"

function deps(): SitesToolRunDeps {
  return {
    listSites: jest.fn(async () => [{ id: "site_1" }]),
    build: jest.fn(async () => ({ versionId: "ver_1" })),
    deploy: jest.fn(async () => ({ productionUrl: "https://x" })),
  }
}

it("surfaces exactly three tools", () => {
  expect(buildSitesManifestEntries().map((entry) => entry.name)).toEqual([
    LIST_SITES_TOOL_NAME,
    BUILD_SITE_TOOL_NAME,
    DEPLOY_SITE_TOOL_NAME,
  ])
})

it("tells the model that publishing cannot be undone", () => {
  // The description is the only place a model learns this before it acts.
  const deploy = buildSitesManifestEntries().find((entry) => entry.name === DEPLOY_SITE_TOOL_NAME)
  expect(deploy?.description).toMatch(/[Ii]rreversible/)
})

it("tells the model that building publishes nothing", () => {
  const build = buildSitesManifestEntries().find((entry) => entry.name === BUILD_SITE_TOOL_NAME)
  expect(build?.description).toMatch(/Publishes nothing/)
})

describe("toolFamily", () => {
  const ctx = (host: ToolSurfaceContext["host"]): ToolSurfaceContext => ({
    session: null,
    agent: null,
    settings: null,
    activeGoal: null,
    prompts: { snapshot: null, context: {} },
    host,
    activeProject: null,
  })

  it("offers the three tools on the desktop only", async () => {
    const surface = await toolFamily.surface(ctx("desktop"))
    expect(surface?.tools.map((tool) => tool.name)).toEqual([...SITES_TOOL_NAMES])
    for (const host of ["web", "mobile", "cli", "brain"] as const) {
      expect(await toolFamily.surface(ctx(host))).toBeNull()
    }
  })
})

it("lists sites without any arguments", async () => {
  const d = deps()
  await expect(runSitesBuiltinTool(LIST_SITES_TOOL_NAME, {}, d)).resolves.toEqual([
    { id: "site_1" },
  ])
})

it("builds with no network unless the model names hosts", async () => {
  // ADR-0084's fail-closed rule: an agent reaching the network during a build
  // is a decision, not an inherited convenience.
  const d = deps()
  await runSitesBuiltinTool(BUILD_SITE_TOOL_NAME, { siteId: "site_1" }, d)
  expect(d.build).toHaveBeenCalledWith({ siteId: "site_1", buildNetworkHosts: [] })

  await runSitesBuiltinTool(
    BUILD_SITE_TOOL_NAME,
    { siteId: "site_1", buildNetworkHosts: ["api.example.com", 42] },
    d
  )
  expect(d.build).toHaveBeenLastCalledWith({
    siteId: "site_1",
    buildNetworkHosts: ["api.example.com"],
  })
})

it("deploys the newest ready version when none is named", async () => {
  const d = deps()
  await runSitesBuiltinTool(DEPLOY_SITE_TOOL_NAME, { siteId: "site_1" }, d)
  expect(d.deploy).toHaveBeenCalledWith({ siteId: "site_1" })
})

it("deploys the version the model named", async () => {
  const d = deps()
  await runSitesBuiltinTool(DEPLOY_SITE_TOOL_NAME, { siteId: "site_1", versionId: "ver_9" }, d)
  expect(d.deploy).toHaveBeenCalledWith({ siteId: "site_1", versionId: "ver_9" })
})

it.each([BUILD_SITE_TOOL_NAME, DEPLOY_SITE_TOOL_NAME])(
  "%s refuses without a siteId rather than guessing one",
  async (tool) => {
    await expect(runSitesBuiltinTool(tool, {}, deps())).rejects.toThrow(/siteId is required/)
    await expect(runSitesBuiltinTool(tool, { siteId: "  " }, deps())).rejects.toThrow(
      /siteId is required/
    )
  }
)

it("refuses a tool it does not own", async () => {
  await expect(runSitesBuiltinTool("purge_site", {}, deps())).rejects.toThrow(/unknown Sites tool/)
})
