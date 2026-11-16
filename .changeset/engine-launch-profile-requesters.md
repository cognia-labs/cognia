---
"cognia-next": patch
---

An external agent now runs a turn that is not yours in a separate, isolated launch: a message from someone else in a Feishu chat, a service run, and a run Cognia cannot attribute to you. That last kind includes webhooks, integration events, and workflow or scheduled runs that record no local person as their author. That launch inherits none of your credentials, SSH agent, Git helpers or native sign-ins. It keeps its own private state for each conversation and set of requesters, so a later requester never resumes an earlier one's engine session. Your own chat turns, and IM turns from the account the connector is signed in as, keep running on your configured agent as before.
