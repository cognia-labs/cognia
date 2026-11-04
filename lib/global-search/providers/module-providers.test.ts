import { loggers } from "@cognia/logging"

import type { HostModuleManifest } from "@/lib/modules/manifest-types"
import {
  __resetGlobalSearchRegistryForTesting,
  getGlobalSearchRegistryRevision,
  listGlobalSearchProviders,
} from "../registry"
import type { GlobalSearchProvider } from "../types"
import { registerModuleGlobalSearchProviders } from "./module-providers"

const provider = (id: string): GlobalSearchProvider =>
  ({ id, kind: "squad", search: async () => ({ items: [] }) }) as unknown as GlobalSearchProvider

const manifest = (
  id: string,
  searchProviders?: HostModuleManifest["searchProviders"]
): HostModuleManifest => ({ id, kind: "module", stage: "beta", searchProviders })

let logError: jest.SpyInstance

beforeEach(() => {
  __resetGlobalSearchRegistryForTesting()
  logError = jest.spyOn(loggers.search, "error").mockImplementation(() => undefined)
})

afterEach(() => logError.mockRestore())

describe("registerModuleGlobalSearchProviders", () => {
  it("registers what each module's entry exports and bumps the revision", async () => {
    const before = getGlobalSearchRegistryRevision()
    const ids = await registerModuleGlobalSearchProviders([
      manifest("crew", async () => ({ searchProviders: [provider("crew.a"), provider("crew.b")] })),
      manifest("quiet"),
    ])
    expect(ids).toEqual(["crew.a", "crew.b"])
    expect(listGlobalSearchProviders().map((p) => p.id)).toEqual(["crew.a", "crew.b"])
    expect(getGlobalSearchRegistryRevision()).toBeGreaterThan(before)
  })

  it("keeps the other modules when one fails to load, and logs which one failed", async () => {
    const failure = new Error("chunk failed")
    const ids = await registerModuleGlobalSearchProviders([
      manifest("broken", async () => {
        throw failure
      }),
      manifest("crew", async () => ({ searchProviders: [provider("crew.a")] })),
    ])
    expect(ids).toEqual(["crew.a"])
    expect(logError).toHaveBeenCalledWith("module search providers failed to load", failure, {
      module: "broken",
    })
  })

  it("is idempotent: registering twice replaces by id", async () => {
    const modules = [manifest("crew", async () => ({ searchProviders: [provider("crew.a")] }))]
    await registerModuleGlobalSearchProviders(modules)
    await registerModuleGlobalSearchProviders(modules)
    expect(listGlobalSearchProviders()).toHaveLength(1)
  })

  it("defaults to the active modules of the generated registry", async () => {
    const ids = await registerModuleGlobalSearchProviders()
    expect(ids).toContain("builtin.squads")
  })
})
