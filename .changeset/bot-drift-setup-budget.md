---
"cognia-next": patch
---

Bots: a plugin update no longer blocks running a Bot by hand or replaying a delivery, and a run that was waiting when the update landed stops with a failure you can replay instead of resuming with the old version's checkpoints. A Bot installed without its required settings, including from a paired device, now installs as "Needs setup" and the Settings section says how many are empty; a setting the schema rejects is still refused. A run's time limit now counts the time it spends running across every attempt and resume, so a run that waits for an approval no longer gets a fresh limit each time it resumes.
