import type { PluginDocsProvider } from "@cognia/plugin-contract/types/plugin/plugin-docs-providers"

/** Preserve the implementation's inference while checking the public document provider contract. */
export function defineDocsProvider<T extends PluginDocsProvider>(provider: T): T {
  return provider
}
