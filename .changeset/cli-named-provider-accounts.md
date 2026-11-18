---
"cognia-next": minor
---

The CLI can keep several named accounts for one provider, such as a personal and a work OpenAI key. `cognia-agent auth login --provider openai --name work` saves one beside the default, `--provider-account work` (or `COGNIA_PROVIDER_ACCOUNT`) picks it for a run, and `"providers": { "openai": { "account": "work" } }` in a project's config pins the repository to it. A named account wins over keys from config and the environment, and naming one that is not stored is an error rather than a quiet fallback. `auth status` lists every account and which one a run uses, `auth logout --name` or `--all` removes them, and `provider limits` names the account it measured. Accounts keep the provider's id, so the subscription path, models, limits and usage treat them as one provider.
