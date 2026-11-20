---
"cognia-next": patch
---

Account sync keeps both devices' changes when they edit different parts of your profile at the same time: a name changed on one device and a bio edited on another now both stay, where one of them used to be lost. The profile now syncs one property at a time (sync schema 3); a device still on an older build holds these changes until it is updated.
