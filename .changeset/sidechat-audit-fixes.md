---
"cognia-next": patch
---

Side chats keep parent context redacted and formatting-intact, respect the parent's current tool limits, keep drafts for sends refused before transcript admission without duplicating retained failed turns, no longer lose questions or drafts on failure, and survive concurrent promotion/deletion safely.

Clearing a main conversation retires its side chats' inherited context while preserving their own messages and showing a localized notice.

Paired-host external agents now reset their retained side-chat session after a parent clear. Older Hosts receive compatible requests and show a notice that the remote agent may still remember earlier context; the reset remains pending until a supporting Host accepts it.

Side chats are findable in search and @chat / @msg within their parent conversation’s scope, with links opening the parent and revealing the source side chat.

Conclusions brought back or sent to the main thread retain their exact side-chat source through draft recovery and show a source chip that opens the original message.

Side chats show their privacy-filtered inherited scope, let users pin earlier parent messages with a separate context budget, and stage explicitly picked local attachments through the normal composer.
