---
"cognia-next": minor
---

Issue identifiers such as `MERC-12` are now links wherever they appear: in chat messages (including messages from connected IM platforms), in issue descriptions and comments, in GitHub issue comments, in commit messages and in quoted IM replies.

- Only identifiers whose project exists in the current workspace become links. They open the issue on the board, on desktop and on a phone. A link to an identifier no issue has opens the board and says so.
- After you comment on, close or link a GitHub issue from the board, only that repository is read again, from where its last sync stopped, instead of a full re-read of the workspace. If that read fails, you are told.
- GitHub comments are read with the same credential rules as the issue sync. When no credential you may use can read the repository, the comments section says so and links to Connections.
- An agent task or Agent Team task started from an issue now shows that issue's own priority on the board, rather than the nearest of the engine's four levels.
