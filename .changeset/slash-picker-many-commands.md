---
"cognia-next": patch
---

The `/` command list opens and filters without lag, however many commands plugins, skills and custom command files add: only the commands in view are drawn, and section headers stay pinned while you scroll. When the desktop app is connected to a remote host, project commands now come from the host's workspace (your own commands in `~/.claude/commands` still appear), the list refreshes when you switch hosts, and the previous project's commands no longer show while the new list loads.
