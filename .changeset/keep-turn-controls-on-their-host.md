---
"cognia-next": patch
---

Switching the desktop to another Host no longer sends a running turn's stop or close to the newly selected Host. A turn keeps controlling and hearing the Host it started on until it finishes; once that Host is out of reach, its late controls are refused instead of reaching another machine. Changeset checks likewise acquire, reset and clean up their checkout on the Host they started on, and stop rather than run against another Host's files.
