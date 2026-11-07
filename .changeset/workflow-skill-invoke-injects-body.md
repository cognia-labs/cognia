---
"cognia-next": patch
---

The workflow "Invoke skill" step now injects each skill's text into the next AI step. It used to inject only the skill names, because it read a field skills don't have. Plugin skills stored as folders or archives are included on desktop, with their plugin paths filled in.
