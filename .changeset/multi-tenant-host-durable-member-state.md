---
"cognia-next": patch
---

A multi-tenant Host now keeps which member owns each conversation across restarts, so after a restart no other caller can take over a member's conversation. Purging a member is now recorded first and finished after a restart if it was interrupted; until it finishes the member cannot start again (`person_purging`), and the purge also removes their usage rows, their replayable events and their conversation ownership.
