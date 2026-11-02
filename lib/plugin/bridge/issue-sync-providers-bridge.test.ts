import { createIssuesAPI } from "@/lib/plugin/api/issues-api"
import { getIssueSyncRegistry, resetIssueSyncRegistry } from "@/lib/issues/sync/registry"
import {
  registerIssueSyncProvidersForPlugin,
  unregisterIssueSyncProvidersForPlugin,
} from "./issue-sync-providers-bridge"

jest.mock("@/lib/plugin/security/permission-guard", () => ({
  createGuardedAPI: (_id: string, api: unknown) => api,
  getPermissionGuard: () => ({ check: () => true }),
}))

afterEach(resetIssueSyncRegistry)

it("namespaces even built-in ids and tears down providers without allowing a stale activation", () => {
  const manifest = {
    id: "bridge-test",
    issueSyncProviders: [{ id: "github", label: "Tracker", schemaVersion: 1 }],
  }
  const api = createIssuesAPI(manifest.id, manifest)
  registerIssueSyncProvidersForPlugin(manifest)
  const provider = {
    id: "github",
    label: "Tracker",
    pullFields: [],
    pushFields: [],
    resource: {
      label: "Tracker",
      schemaVersion: 1,
      schema: { type: "object" as const, properties: {} },
      describe: () => ({ key: "one", label: "One" }),
    },
    pull: async () => ({ items: [], notModified: true }),
    pullPage: async () => ({ items: [], cursor: "next" }),
    confirmDeparted: async (_binding: unknown, ids: string[]) => ids,
    completeFullScan: true,
    fullScanOnly: true,
  }
  api.registerSyncProvider(provider)
  expect(getIssueSyncRegistry().get("github")).toBeUndefined()
  expect(getIssueSyncRegistry().get("plugin:bridge-test/github")).toBeDefined()
  expect(getIssueSyncRegistry().get("plugin:bridge-test/github")).toMatchObject({
    pullPage: expect.any(Function),
    confirmDeparted: expect.any(Function),
    completeFullScan: true,
    fullScanOnly: true,
  })
  expect(() => api.registerSyncProvider({ ...provider, pullPage: undefined })).toThrow(/descriptor/)
  expect(() => api.registerSyncProvider({ ...provider, id: "lark-task" })).toThrow(/declared/)
  expect(() =>
    registerIssueSyncProvidersForPlugin({
      ...manifest,
      issueSyncProviders: [...manifest.issueSyncProviders, ...manifest.issueSyncProviders],
    })
  ).toThrow(/Duplicate/)
  expect(() =>
    registerIssueSyncProvidersForPlugin({
      ...manifest,
      issueSyncProviders: [{ ...manifest.issueSyncProviders[0], id: "plugin:other/github" }],
    })
  ).toThrow(/namespace/)
  unregisterIssueSyncProvidersForPlugin(manifest.id)
  unregisterIssueSyncProvidersForPlugin(manifest.id)
  expect(getIssueSyncRegistry().get("plugin:bridge-test/github")).toBeUndefined()
  expect(() => api.registerSyncProvider(provider)).toThrow()
  createIssuesAPI(manifest.id, manifest).registerSyncProvider(provider)
  expect(getIssueSyncRegistry().get("plugin:bridge-test/github")).toBeDefined()
})
