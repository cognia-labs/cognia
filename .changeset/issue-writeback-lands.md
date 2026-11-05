---
"cognia-next": patch
---

GitHub write-backs from an issue now go through and show on the issue's activity.

- Commenting, labelling or closing a mirrored GitHub issue from the issue panel was refused every time, reported as "plugin unavailable". The write now carries the key the GitHub actions require.
- A write GitHub refused shows its error instead of a success message. A write that has not finished yet says so, and lands on the activity of every linked local issue once it does, even if the window was closed meanwhile.
- Workflows, plugins and issue wakeups see an issue change only once it is saved, and never one that was rolled back.
