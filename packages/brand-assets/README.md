# @cognia/brand-assets

One portable brand resource catalog for AI providers, sign-in, search, OCR,
external agents and link previews. It exports `brandIconAsset(id)` and
`hasBrandIcon(id)` without importing React, Next.js, Provider catalogs or any
runtime service.

Paths are relative to the application's public root. Resource files and their
license notices remain under the repository's `public/icons/` and are delivered
by the existing Web/Tauri/Capacitor static-export pipeline; this package does not
download or relocate images. Unknown IDs return `null`/`false`; renderers own
monograms and accessible labels.
