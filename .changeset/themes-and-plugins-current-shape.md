---
"cognia-next": major
---

Custom themes, plugin themes and in-tree plugin data are read only in their current saved shape. The following are no longer read:

- themes saved as a single `colors` set
- the old visualization profile names
- Strix findings saved without a fingerprint
- issue-sync v1 resources
- screenshot notes saved as plain text

`registerCustomTheme` accepts only `tokens` / `baseVariant`.
