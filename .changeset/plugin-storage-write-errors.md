---
"cognia-next": patch
---

Plugin storage now rejects browser write failures, including quota errors, so plugins can detect lost checkpoints. Daily quests keep working in memory and log failed saves. Storage removal continues to reject browser failures, and Feishu calendar retains its checkpoint read-back verification.
