---
"cognia-next": patch
---

The Host now rejects device proofs that claim more than a 60-second lifetime, so no device can pin entries in the shared replay cache, and a full cache answers a retryable `503 device_proof_capacity` with a retry delay instead of a misleading `409 device_proof_replay`.
