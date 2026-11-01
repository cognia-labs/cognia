import {
  registerDocsProvidersForPlugin,
  unregisterDocsProvidersForPlugin,
} from "./docs-providers-bridge"
import { createDocsProvidersAPI } from "@/lib/plugin/api/docs-providers-api"
import { getDocsProvider } from "@/lib/docs-providers/registry"
import type { PluginManifest } from "@cognia/plugin-contract/types/plugin/plugin"

jest.mock("@/lib/plugin/auth/connections-api", () => ({
  createAuthConnectionsAPI: () => ({ list: async () => [], onDidChange: () => () => {} }),
}))

it("routes descriptor validation and teardown through the same public registration owner", () => {
  const manifest = {
    id: "bridge-test",
    docsProviders: [
      {
        id: "docs",
        label: "Docs",
        mentionPrefix: "bridge-test.docs:",
        kinds: ["doc"],
        urlOrigins: ["https://docs.example.test"],
      },
    ],
  } as PluginManifest
  const api = createDocsProvidersAPI(manifest.id, manifest, {
    hasPermission: () => true,
    connections: { list: async () => [], onDidChange: () => () => {} },
  })
  registerDocsProvidersForPlugin(manifest)
  const registration = api.register({
    id: "docs",
    mentionPrefix: "bridge-test.docs:",
    kinds: ["doc"],
    listAccounts: async () => [],
    matchRef: () => null,
    fetch: jest.fn(),
  })
  expect(getDocsProvider(registration.providerId)).toBeDefined()
  unregisterDocsProvidersForPlugin(manifest.id)
  unregisterDocsProvidersForPlugin(manifest.id)
  expect(getDocsProvider(registration.providerId)).toBeUndefined()
  expect(() =>
    registerDocsProvidersForPlugin({
      ...manifest,
      docsProviders: [{ ...manifest.docsProviders![0], mentionPrefix: "lark:" }],
    })
  ).toThrow(/namespace/)
})
