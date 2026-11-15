---
"cognia-next": major
---

Agent sends without a frozen execution spec are now refused instead of falling back to provider-id dispatch, and the agent subprocess always gets the allowlisted environment. Skill AI rewrites and paired-Host utility calls now use the configured provider. The `claudeAgentSdk.plugins` send option is removed; use `runtimeExtensions`.
