---
"cognia-next": patch
---

Artifact previews recover from errors properly. Editing a React artifact that declares `const App` now shows the new version instead of keeping the old one, and a component that throws while rendering or loading now shows its error instead of a blank "ready" preview. Retry reloads the preview and its runtime, and a fixed error no longer blocks PNG/PDF export.
