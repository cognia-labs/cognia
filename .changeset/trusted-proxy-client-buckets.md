---
"cognia-next": patch
---

Behind the Compose deployment's Caddy (or any proxy named in `COGNIA_TRUSTED_PROXIES`), each client now gets its own sign-in rate-limit bucket from the proxy's `X-Forwarded-For`, so one user's logins, token refreshes and reconnects no longer push everyone else into `429`.
