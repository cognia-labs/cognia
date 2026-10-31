---
"cognia-next": patch
---

Plugin network requests on the desktop no longer carry API keys or tokens (x-api-key, api-key, access-token and similar headers) to another host when a server redirects, and a redirect to a host outside the plugin's network allowlist is refused.
