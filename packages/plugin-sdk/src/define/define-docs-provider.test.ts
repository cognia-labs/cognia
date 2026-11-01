import { defineDocsProvider } from "./define-docs-provider"
import type { PluginDocsProvider } from "@cognia/plugin-contract/types/plugin/plugin-docs-providers"

it("preserves a provider implementation using only public contract types", async () => {
  const provider = {
    id: "docs",
    mentionPrefix: "acme.docs:",
    kinds: ["doc"],
    listAccounts: async () => [{ id: "connection-ref", label: "Alice", authorizationEpoch: "4" }],
    matchRef: () => null,
    fetch: async (ref) => ({ ref, title: "Report", text: "body", format: "text" }),
  } satisfies PluginDocsProvider
  expect(defineDocsProvider(provider)).toBe(provider)
  expect(await defineDocsProvider(provider).listAccounts()).toEqual([
    { id: "connection-ref", label: "Alice", authorizationEpoch: "4" },
  ])
})
