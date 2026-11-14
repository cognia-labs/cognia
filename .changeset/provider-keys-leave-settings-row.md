---
"cognia-next": patch
---

Provider API keys, key pools, OAuth refresh tokens, Bedrock IAM secrets, OpenRouter provisioning/BYOK keys and the CLIProxyAPI management key are no longer stored in plaintext in the settings database. They move to the platform secret store (the desktop secret store, the phone's Keychain/Keystore, the Browser Vault or a device-wrapped store on the web) the first time the app reads settings, and backups and exports still include them when "Include API keys" is on. Deleting an account, a runtime target or all data now also deletes these credentials.
