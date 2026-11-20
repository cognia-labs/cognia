/**
 * App binding for `@cognia/tts/tts-orchestrator` (ADR-0068 E3): keeps the
 * historical `@/lib/tts/tts-orchestrator` specifier stable and guarantees the
 * host bridges (Tauri proxy fetch, native-shell gate, PII gate, usage meter,
 * sonner toasts) are installed before the orchestrator synthesizes anything.
 *
 * Usage is metered by the host's `recordSynthesis` bridge
 * (`lib/tts/host-bindings.ts`), which the orchestrator calls once per
 * synthesis a provider actually performed. Metering here, after `speak()`
 * settled, counted cache hits as new spend, missed reads a stop interrupted,
 * and billed whichever provider the next request had switched to.
 */

import "./host-bindings"

export * from "@cognia/tts/tts-orchestrator"
