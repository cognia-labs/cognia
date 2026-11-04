---
"cognia-next": minor
---

Add opt-in Bun runtimes for the brain and Agent sidecar with Node startup fallback.

Skip unused telemetry exporters during sidecar startup, await configured telemetry
before readiness, and cancel queued initialization during shutdown. Supervised Bun
children use the Host's explicit environment. Runtime comparisons retain RSS and
separately report macOS physical footprint.

Load only webclone configuration and SSRF helpers in the sidecar host; keep the
snapshot parser and conversion engine in their existing isolated child process.
Clear settled webclone worker deadlines so completed jobs release their runner,
and stop queued work when a worker fails.

Load npm Undici on the first guarded request when needed. Keep configured proxy
installation before readiness and preserve socket DNS protection, cancellation
and request cleanup across concurrent initialization and shutdown.
