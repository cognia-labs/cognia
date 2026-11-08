---
"cognia-next": patch
---

Terminal fixes: an agent or workflow command in a new dock tab now runs instead of failing with "unknown session", and dock runs return what the command printed rather than its command line; cancelling a workflow while a terminal session opens no longer leaves it running; switching the Host a desktop drives no longer reuses the previous Host's shell, and a phone's new tab uses the Host's default shell; closing a serial tab closes the port, and a selected remote Host no longer steals an open serial port's output.
