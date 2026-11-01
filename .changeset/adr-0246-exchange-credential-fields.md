---
"cognia-next": patch
---

The Host confidential token exchange can inject client credentials under field names declared in the plugin manifest (`tokenEndpoints[].credentialFields`, e.g. `app_id`/`app_secret`). The Host-managed connect flow now keeps the provider's configuration form values (ADR-0246).
