---
"cognia-next": minor
---

A task copy of several repositories now keeps them where they sit next to each other, so a relative dependency such as `file:../sdk` resolves inside it. When that is not possible (different disks, one repository inside another, only the home folder in common, or names that would collide), the repositories go side by side and the chat says why once, when the copy is made.
