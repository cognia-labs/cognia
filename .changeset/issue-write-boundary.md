---
"cognia-next": patch
---

Every issue edit now goes through one set of checks, whichever screen or device it comes from.

- Creating a project together with its first issue is one save: if the issue is refused, no empty project is left behind.
- An issue can no longer be created with a parent, blocker or cycle that does not exist or belongs to another workspace, or with an unknown status, priority or assignee. This applies to the desktop, a paired phone, the browser companion, assistant tools and plugins.
- Unbinding or replacing a synced repository on a project now keeps the background refresh in step. Removing a resource that fails says so instead of failing silently.
- A refused board drop and a board refresh that fails after a GitHub write-back now show a message.
- An issue created in a shared workspace opens once the server has it, unless you have opened another issue in the meantime.
