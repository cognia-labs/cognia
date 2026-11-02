---
"cognia-next": minor
---

Google sign-in is now a Host-managed `auth.google` provider. The desktop Host performs the OAuth code exchange, refresh and revoke, so the Google client secret and refresh tokens never reach the WebView; the settings card stores the client secret write-only and lists each Google connection with re-authorize and disconnect. Google Docs reads through a granted Google connection, plugins can consume `auth.google` with a grant, and existing Google connections and secrets migrate automatically (ADR-0246).
