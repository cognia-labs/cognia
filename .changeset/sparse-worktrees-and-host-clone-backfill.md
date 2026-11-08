---
"cognia-next": patch
---

A sparse worktree now checks out only its declared paths, keeps files the snapshot deleted inside them, and still runs post-checkout hooks. On an always-on Host, a repository clone no longer fails with "not our ref" after upstream moves. Its worktrees now follow the repository's approved declaration, and the Host fetches only the declared paths. Best-of-N candidates and harness probes get the same provisioning as the session's own worktrees.
