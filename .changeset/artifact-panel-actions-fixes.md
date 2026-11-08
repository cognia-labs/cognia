---
"cognia-next": patch
---

Artifact panel actions now do what they say. "Open in new tab" shows HTML and SVG artifacts in an isolated page that cannot reach the app's storage, and scripts run there only for artifacts you allowed to run. "Edit in Canvas" opens Canvas, PNG/PDF export switches to Preview first and shows an error if it fails, a code artifact can still be saved as PDF, and "Reveal" finds files saved outside Downloads. The "Default view" setting is now applied, plugin renderers report ready only once they have rendered, and a notebook exports to PDF as cells and outputs instead of raw JSON.
