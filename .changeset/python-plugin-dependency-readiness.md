---
"cognia-next": patch
---

Python plugins now show whether their dependencies are ready: the card, the Library row and the detail page say "Ready to run", "Dependencies not ready" or "Installed · own environment", as the host computes it from the environment it built. Right after you install a Python plugin (marketplace, Git, a local folder or a cogpack) Cognia offers to prepare its dependencies, naming the packages, the installer and the network and disk it uses. Enabling a plugin whose dependencies are not ready stops with a "Prepare dependencies" action instead of failing on a guessed import name.
