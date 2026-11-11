---
"cognia-next": patch
---

Applying or undoing an agent's changes no longer loses a file when the write fails partway (a full disk, a permission error). The new content is written beside the file and swapped in, so a failed write leaves the file as it was, and files already written in the same operation are put back; if one cannot be put back, the error names it.
