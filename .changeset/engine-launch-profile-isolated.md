---
"cognia-next": patch
---

Bot runs now launch their external agent with an isolated launch profile instead of a Bot-only switch. The host keeps the agent's private state under its own data directory, applies the engine's own home settings inside it and deletes it when the run's agent is removed. The agent inherits no credentials, SSH agent or Git helpers from your environment, and an engine that cannot run privately, or a host without a sandbox, is reported as needing setup. Isolated Devin runs no longer copy your Devin sign-in: give the Bot a Devin API key or a Cognia model.
