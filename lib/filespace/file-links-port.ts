// The filespace module's implementation of the `conversation-file-links` port
// (`types/modules/ports/conversation-file-links.ts`, ADR-0250 §14).

import type { ConversationFileLinksPort } from "@/types/modules/ports/conversation-file-links"
import { copyConversationFileLink } from "./copy-link"

export const port: ConversationFileLinksPort = {
  copyLink: (input) => copyConversationFileLink(input),
}
