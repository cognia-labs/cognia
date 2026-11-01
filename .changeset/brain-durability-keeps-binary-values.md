---
"cognia-next": patch
---

Restarting the headless brain no longer loses binary data such as attachments, voice clips and pet media, or turns dates, special numbers and other values into plain objects. Rows written before this fix cannot be repaired, so `cognia-agent durability verify` now lists them. An older build refuses to open a store this version has written instead of corrupting it. Saving many attachments at once, such as installing a pet media pack, no longer freezes the brain while their files are written.
