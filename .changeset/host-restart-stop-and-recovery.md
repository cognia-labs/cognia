---
"cognia-next": patch
---

A turn you stopped stays stopped across a Host restart: it is no longer sent again when resume after restart is on, and it reads as stopped rather than interrupted. Starting the app no longer marks a chat turn that is still running (in this window, another window, or started during the scan) as needing recovery. Recovering a crashed IM room run now resumes the teammate's own session, keeps the text and approvals from an earlier crash, and no longer accepts a log with missing events or a result from another attempt as the call's answer.
