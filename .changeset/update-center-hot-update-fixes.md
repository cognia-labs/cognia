---
"cognia-next": patch
---

Updates now install exactly what you were shown. The desktop app installs only the offered version, background download no longer installs or opens the release page, a revoked release cannot return through the fallback feed, the Update Center offers Restart once an update is installed, and the About card on macOS hands off to the release page like the Update Center. Plugin and skill updates install the reviewed version or content, ask for review when a plugin widens its network access, and never swap a package under a plugin that is still running or failed to stop cleanly. Plugin development reloads stage the new package and only replace the old one after the plugin has stopped. A failed catalog check is shown as a failure instead of "up to date", automatic checks honour backoff, update state is no longer lost on quick consecutive actions or leaked across accounts, and the web app no longer reloads every time the network comes back.
