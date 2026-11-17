---
"cognia-next": minor
---

WASM plugins now have runtime logs. On desktop, a WASM plugin's `log` calls appear in the plugin Dev Session's Runtime logs card, filtered to the generation being debugged, and in the log panel under the plugin source. Lines are bounded, credential-shaped text is redacted, and lines written before the card opened are read back from the host. The plugin detail menu now links WASM plugins to their logs like every other runtime.
