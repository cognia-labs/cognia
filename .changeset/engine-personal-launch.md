---
"cognia-next": patch
---

A conversation that has read your personal data now runs its next external-agent turns as a sealed task. The agent reaches only Cognia's model gateway and Cognia's own tools on this machine, so that content cannot leave through the network, a configured MCP server or the agent's own sign-in. Such a conversation needs an external agent that uses a Cognia model; one signed in with its own account, Codex included, is refused there instead of being restricted by a Codex-only setting. A remote Host whose network policy is restricted refuses these turns.
