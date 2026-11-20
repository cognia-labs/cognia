---
"cognia-next": patch
---

Router + Fusion runs keep their promises: two concurrent creates with one idempotency key start one run, a Delegate lead that asks a question waits for the answer in the same run, an approval interrupted before its run resumed can be retried, a cancelled run never returns an answer, a run waiting for a person's reconciliation survives a restart, a Panel finds a distinct model set whenever one exists, and a degraded code Panel says so in the compatible response.
