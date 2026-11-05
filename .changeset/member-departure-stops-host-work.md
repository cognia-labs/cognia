---
"cognia-next": minor
---

When a member leaves an organization, or the organization is suspended, a multi-tenant Host now stops their running turns and sandboxed runs at once (each ends as "Stopped because your access changed"), stops their brain, closes their devices' connections and keeps their data. The Host follows the collaboration server's standing changes and re-checks active members every 30 seconds.
