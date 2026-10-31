---
"cognia-next": patch
---

Plugin sign-in is stricter: session-change events need `auth:consume` and no longer include tokens, revoking an auth permission takes effect immediately, the PKCE token exchange goes through the plugin's governed network access (`network:fetch`), plugins can only rename or enable/disable their integration accounts, and an auth provider id stays bound to the plugin that first registered it until that plugin is uninstalled.
