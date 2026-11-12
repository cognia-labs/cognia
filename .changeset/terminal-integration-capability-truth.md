---
"cognia-next": patch
---

Terminals no longer claim command tracking they don't have. When shell integration is unsupported, fails to load, or never starts, the session says so (and recovers if a slow shell startup finishes later). Agent and workflow terminal steps then stop right away with a clear reason instead of waiting for a timeout, and a command that was already sent is never reported as safe to resend. Running an agent's command in a terminal tab from chat keeps working on such shells.
