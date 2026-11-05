---
"cognia-next": patch
---

A member's message on an organization Host now goes only through the Host's own queue: it waits for the connection, is never sent behind the Host's back, and comes back to the composer when it cannot be sent. Every refusal from a member's partition now says what actually happened (not a member, organization suspended, data being removed, workspace starting or stopping, storage failure) instead of one generic "unavailable".
