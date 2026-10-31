---
"cognia-next": minor
---

Plugins that sign in with an OAuth client secret can now exchange tokens through the desktop or always-on Host (ADR-0246): the Host keeps the client secret where plugins cannot read it back, only calls token endpoints the plugin declared, never follows redirects with it, and removes it when the plugin is uninstalled.
