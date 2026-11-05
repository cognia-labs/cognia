/**
 * Remote document providers — public barrel and built-in registration.
 *
 * Importing this module registers the built-ins, so anything that reads the
 * registry (`components/chat/composer-trigger.ts`, the picker, the settings
 * cards) must import from here rather than from `./registry` directly.
 */

import { __clearDocsProvidersForTests, getDocsProvider, registerDocsProvider } from "./registry"
import { BUILTIN_DOCS_PROVIDERS } from "./providers/_builtin"

export * from "./types"
export * from "./registry"
export { clampDocText, truncationMarker } from "./limits"
export * from "./oauth-deep-link"

function registerBuiltinDocsProviders(): void {
  // Preserve registered providers and their active reads across dependency reloads.
  for (const provider of BUILTIN_DOCS_PROVIDERS) {
    if (!getDocsProvider(provider.id)) registerDocsProvider(provider)
  }
}

/** Test-only: restore the registry to exactly the built-in set. */
export function __resetDocsProvidersForTests(): void {
  __clearDocsProvidersForTests()
  registerBuiltinDocsProviders()
}

registerBuiltinDocsProviders()
