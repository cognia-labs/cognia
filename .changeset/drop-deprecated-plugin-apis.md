---
"cognia-next": major
---

Removed deprecated plugin APIs:

- `ctx.agent.executeAgent`: use `run` or `runStreamed`.
- `ctx.connectors.send` and `sendText`: use `enqueueSend`.
- `setSecretsAdapter` and `hydrateFromSecrets`, which no longer did anything.
- The type aliases `FullPluginContext` (use `PluginContext`), `PluginContextPanelIcon`, `ExternalSessionPermissionSpec`, `NativePlatform` and `PluginPointFormFactor`.

A plugin that still calls one of these methods now fails at runtime.
