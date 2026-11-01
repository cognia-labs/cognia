---
"cognia-next": minor
---

Disconnecting a sign-in connection, revoking one plugin's access, or uninstalling a plugin now cleans up consistently (ADR-0246 §4, §10): background syncs and queued actions stop, webhook deliveries and other data the Host derived from that connection are removed (retried at startup if a step fails), and uninstalling a provider plugin revokes its connections at the vendor first. The uninstall dialog now says exactly which of these happens for the plugin you are removing.
