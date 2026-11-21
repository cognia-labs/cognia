---
"cognia-next": patch
---

A Gateway request booked by the Passthrough Ledger is no longer counted a second time from its telemetry, Gateway usage is keyed by the request so two requests in the same millisecond stay separate and a redelivered event is not counted again, and a request that failed after the provider started answering is booked for the tokens it was billed.
