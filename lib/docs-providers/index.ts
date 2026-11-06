/**
 * Remote document providers — the framework's public barrel.
 *
 * The built-in providers are members of the `docs-provider` collection port,
 * which `./registry` loads on first read; importing this barrel starts that
 * load so they are usually registered before anything asks.
 */

import { whenDocsProvidersReady } from "./registry"

export * from "./types"
export * from "./registry"
export { clampDocText, truncationMarker } from "./limits"
export * from "./oauth-deep-link"

void whenDocsProvidersReady()
