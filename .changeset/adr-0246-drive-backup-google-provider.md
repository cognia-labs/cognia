---
"cognia-next": minor
---

Google Drive backup now signs in through the Host's Google connection: device-code sign-in, refresh and revoke run in the desktop Host, the client secret is stored write-only, and disconnecting revokes the token without switching backup to another account. A shared device-code dialog also re-authorizes Google connections from Settings → External services and the Docs card. Existing Drive backup sign-ins migrate automatically (ADR-0246).
