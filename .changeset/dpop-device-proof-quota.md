---
"cognia-next": patch
---

One busy device can no longer exhaust the Host's device-proof replay cache for everyone: each device has its own share (a device far past its limits gets a retryable `429`), and the cache is larger and keeps proofs only as long as they could be replayed.
