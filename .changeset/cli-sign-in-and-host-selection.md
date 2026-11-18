---
"cognia-next": patch
---

The CLI keeps sign-in, Host and provider credentials straight when they change. A stale refresh, sign-out or earlier sign-in no longer overwrites a newer `logto login`, and `logto status` names the signed-in person. `logto login --switch-account` makes the issuer ask again. A Host named with `--host` is used as saved, and a missing or misspelled name is an error instead of the environment's Host. `host use` says when the project file overrides it, `host remove` asks the Host to revoke the paired device, and a project hosts file holding a credential is kept out of Git. `auth login` saves the key you passed instead of an ambient Claude token, and `auth status` and `logout` say which source a run actually uses.
