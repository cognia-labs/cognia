---
"cognia-next": patch
---

`cognia` CLI plugin installs and updates now download into a staging directory and swap the whole tree in, install the commit that was reviewed, refuse a source that now provides a different plugin, stop after a cancel, keep a disabled plugin disabled on reload, and no longer list a downgrade as an update.
