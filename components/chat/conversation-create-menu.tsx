"use client"

import { useRef, useState, type ReactElement } from "react"
import { useTranslations } from "next-intl"
import { LinkIcon, PlusIcon } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useSharedChatAvailability } from "@/hooks/collab/use-shared-chat-enabled"
import { sharedChatInertMessageKey } from "@/lib/collab/shared-chat-availability"
import { SharedSessionJoin } from "./shared-session-join"

/** Shared by the desktop rail, compact list header, and mobile list's +. */
export function ConversationCreateMenu({
  children,
  onNewConversation,
  newConversationLabel,
}: {
  children: ReactElement
  onNewConversation: () => void
  newConversationLabel: string
}) {
  const t = useTranslations("chatCollaboration")
  // Inert rather than hidden when shared chat is not offered: the item says
  // why, so a missing server reads as a missing server, not a missing feature.
  const inertKey = sharedChatInertMessageKey(useSharedChatAvailability())
  const sharedChatEnabled = inertKey === null
  const [joinOpen, setJoinOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild ref={triggerRef}>
          {children}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(event) => {
            // The invitation dialog takes focus when its menu item is chosen.
            if (joinOpen) event.preventDefault()
          }}
        >
          <DropdownMenuGroup>
            <DropdownMenuItem className="pointer-coarse:min-h-11" onSelect={onNewConversation}>
              <PlusIcon className="size-4" aria-hidden />
              {newConversationLabel}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="items-start pointer-coarse:min-h-11"
              disabled={!sharedChatEnabled}
              onSelect={() => setJoinOpen(true)}
              data-testid="conversation-create-join"
            >
              <LinkIcon className="mt-0.5 size-4" aria-hidden />
              <span className="flex min-w-0 flex-col">
                <span>{t("joinViaInvite")}</span>
                {inertKey ? (
                  <span
                    className="max-w-64 text-xs text-muted-foreground"
                    data-testid="conversation-create-join-reason"
                  >
                    {t(inertKey)}
                  </span>
                ) : null}
              </span>
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {sharedChatEnabled && joinOpen ? (
        <SharedSessionJoin
          open={joinOpen}
          onOpenChange={setJoinOpen}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            triggerRef.current?.focus()
          }}
        />
      ) : null}
    </>
  )
}
