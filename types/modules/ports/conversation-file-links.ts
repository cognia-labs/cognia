// The `conversation-file-links` capability port (ADR-0222 §2, ADR-0250 §14):
// copy a link to one file of a conversation, addressed inside its FileSpace.
// The filespace module (`lib/filespace/module.ts`) provides it. The chat
// dock's editor asks for it instead of importing `lib/filespace/`, because
// filespace already depends on the artifact module the dock lives in; with
// no provider the editor offers no "Copy Link".

export type ConversationFileLinkResult = "copied" | "outside" | "failed"

export interface ConversationFileLinkInput {
  sessionId: string
  /** Absolute, or relative to the conversation's `/workspace` directory. */
  path: string
  line?: number
}

export interface ConversationFileLinksPort {
  /**
   * Put the file's FileSpace link on the clipboard. `outside` means the path
   * lies in none of the conversation's mounts, so no link could open it.
   */
  copyLink(input: ConversationFileLinkInput): Promise<ConversationFileLinkResult>
}

declare module "@/lib/modules/ports" {
  interface PortMap {
    "conversation-file-links": ConversationFileLinksPort
  }
}
