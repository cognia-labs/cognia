---
"cognia-next": minor
---

Plugins can now contribute cloud-document providers with `ctx.docsProviders.register` and the SDK's `defineDocsProvider` (ADR-0246): their documents show up in the @-picker, Discover and settings next to Lark and Google, are read through the plugin's granted connection, keep a namespaced provenance so the dock can reopen them, and are cancelled in flight when the provider is replaced or the plugin is disabled.
