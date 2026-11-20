---
"cognia-next": patch
---

Custom export themes only accept CSS colors: the theme editor marks a value that is not a color and will not save it, and an exported page, quote card or usage card draws any such stored value with the base theme's color, so a theme can no longer inject markup into an export.
