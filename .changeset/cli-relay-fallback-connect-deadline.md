---
"cognia-next": patch
---

A paired Host whose address stops answering no longer costs the whole timeout before the CLI tries its relay room. The direct route now gives up connecting after a short deadline (a third of the budget, at most 5 seconds), and a command moves to the relay when it provably never left this machine, or when the Host deduplicates it. A command that may already have run and must not run twice is not repeated, and the error says to check on the Host first.
