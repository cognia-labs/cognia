---
"cognia-next": minor
---

Each repository in a multi-repository workspace now gets its task copy set up from its own `.cognia/workspace.json` instead of the primary repository's, which used to narrow a second repository to folders it does not have. Another repository's file is approved on its own in Settings → Environments, and the workspace's Environments chip shows when one is waiting; approvals you already gave for the primary repository stay valid. A repository can now declare what it builds against with `"dependsOn": [{ "repository": "github.com/org/sdk" }]`, and when an Agent Team merges all of its work, a repository whose dependency in another repository changed in that run waits for a person instead of merging on its own, as does one whose declared dependency matches no repository of the run, or several.
