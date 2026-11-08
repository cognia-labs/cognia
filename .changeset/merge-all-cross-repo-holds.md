---
"cognia-next": patch
---

An Agent Team's merge-all now holds a change back while anything it depends on is not going in, across repositories too: a prerequisite that owes changes or an approval, failed, was blocked or did not merge keeps its dependents out, and each held change records which prerequisite it waits for. Managed chat turns also keep `@`-referenced folders, slash-command paths and extra project roots, moved into the isolated checkout when they live inside one.
