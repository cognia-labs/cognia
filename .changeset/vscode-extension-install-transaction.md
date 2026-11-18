---
"cognia-next": patch
---

VS Code extension installs now install only the reviewed .vsix, reach the plugin runtime so the extension can be enabled, stop and snapshot an installed version before replacing it, and restore it when the install fails; a failed Open VSX graph puts back replaced extensions instead of removing them.
