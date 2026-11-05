---
"cognia-next": patch
---

Plugin file watching follows the folder you actually edit.

- A plugin added with "Load unpacked" is now watched in the folder you picked, not in the app's installed copy, so saving your source reloads it. The folder is reinstalled before each reload; if its plugin id or permissions changed, the watcher stops and asks you to load it again so you can review them.
- The watch card lists every watched folder and what it is.
- With the watch on, each `cognia plugin dev` build no longer reloads the plugin a second time.
- Re-enabling or updating a TypeScript / ES module plugin in the CLI now loads all of its own modules fresh, instead of mixing new and old versions of them.
