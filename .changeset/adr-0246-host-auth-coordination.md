---
"cognia-next": minor
---

Service sign-ins are coordinated by the app (ADR-0246): refreshing a connection runs once across windows and can no longer overwrite a newer token, signing out cannot be undone by a late refresh, OAuth callbacks are accepted once and only for their own sign-in attempt, and deleting a profile also clears its service connection credentials.
