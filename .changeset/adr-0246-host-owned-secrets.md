---
"cognia-next": patch
---

The app window and paired devices can no longer read or overwrite the Google sign-in record (refresh tokens and client secrets) through the generic secret store; only the desktop Host's Google controller touches it.
