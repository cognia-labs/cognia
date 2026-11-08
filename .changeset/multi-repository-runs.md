---
"cognia-next": minor
---

Agent runs, workflow agent steps and Agent Team members in a multi-repository workspace now work in task copies of every repository the workspace has, not only the one they started in. Untrusted repositories are left out of unattended runs. External agents get the other repositories only when they can take more than one folder; a new "workspace.additional-roots" row in the agent capability matrix shows which ones work in the primary repository only (Codex, Aider, A2A, OpenCode V2). Source Control's repository switcher lists the conversation's task copies first, and moving work to an always-on Host now says when only the primary repository is cloned there.
