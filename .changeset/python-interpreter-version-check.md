---
"cognia-next": patch
---

Python plugins now check the interpreter they load on: a custom interpreter path is probed for its version, and any interpreter older than Python 3.9 or outside the plugin's `requires-python` gets a warning next to the interpreter field and in the plugin's log. The plugin still loads.
