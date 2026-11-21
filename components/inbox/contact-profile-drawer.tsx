"use client"

/**
 * Contact-profile drawer (CRM, schema v83). A side sheet, opened from the
 * conversation header, that resolves the DM contact behind the open
 * conversation (platform + remoteChatId → platformIdentities) and shows its
 * directory entry plus any cross-platform identities it has absorbed, each
 * reversible via unmergeIdentity, and the user-authored relationship / note the
 * IM reply copilot reads as always-on knowledge (ADR-0194). The identity directory is populated by the
 * connector bus on every inbound; conversations whose chat id isn't a known
 * user (group chats, never-seen contacts) show an empty state.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from "@/components/ui/item"
import { CopyIcon, KeyRoundIcon, ShieldCheckIcon, UserRoundXIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  MAX_CONTACT_NOTE_CHARS,
  MAX_RELATIONSHIP_CHARS,
  listMergeCandidates,
  setIdentityHostOwner,
  unmergeIdentity,
  updateIdentityProfile,
  type IdentityUnmergeFailureReason,
} from "@/lib/db/platform-identities"
import type { PlatformIdentityRow } from "@/lib/db/connector-types"
import {
  issueHostOwnerBindCode,
  type IssuedHostOwnerBindCode,
} from "@/lib/connectors/identity-bind-code"
import { useInboxWriteRoute } from "@/lib/connectors/inbox-writes"
import { resolveConversationContact } from "@/lib/reply-copilot/resolve-contact"
import { IdentityMergeDialog } from "@/components/connectors/identity-merge-dialog"

interface ContactGroup {
  primary: PlatformIdentityRow
  merged: PlatformIdentityRow[]
  candidates: PlatformIdentityRow[]
}

export interface ContactProfileDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  conversationKey: string
}

function useContact(conversationKey: string): ContactGroup | null {
  return (
    useLiveQuery<ContactGroup | null>(async () => {
      if (typeof window === "undefined") return null
      // The latest sender, not the chat id: on Slack / Discord / Lark a DM
      // channel id is not the member id (`resolveConversationContact`).
      const primary = await resolveConversationContact(conversationKey)
      if (!primary) return null
      return {
        primary,
        merged: primary.mergedSnapshots ?? [],
        candidates: await listMergeCandidates(primary.id),
      }
    }, [conversationKey]) ?? null
  )
}

/**
 * Relationship + note for the contact. Editable only where this device owns
 * the identity directory (local inbox writes); a paired companion mirrors the
 * directory read-only — the sync handler never writes identities back — so it
 * shows the values with the reason instead of an editor that could not save.
 */
function ContactProfileNotes({ primary }: { primary: PlatformIdentityRow }) {
  const t = useTranslations("inbox.contactProfile")
  const route = useInboxWriteRoute()
  const [relationship, setRelationship] = useState(primary.relationship ?? "")
  const [note, setNote] = useState(primary.note ?? "")
  const [saving, setSaving] = useState(false)
  const dirty = relationship !== (primary.relationship ?? "") || note !== (primary.note ?? "")

  if (route !== "local") {
    return (
      <div className="space-y-1 text-xs" data-testid="contact-profile-notes-readonly">
        <p className="font-medium">{t("profileTitle")}</p>
        <p>
          {primary.relationship
            ? t("relationshipValue", { value: primary.relationship })
            : t("noRelationship")}
        </p>
        {primary.note ? <p className="whitespace-pre-wrap">{primary.note}</p> : null}
        <p className="text-muted-foreground">{t("profileReadOnly")}</p>
      </div>
    )
  }

  async function save() {
    setSaving(true)
    try {
      const result = await updateIdentityProfile(primary.id, { relationship, note })
      if (!result.ok) toast.error(t(`errors.profile_${result.reason}`))
      else toast.success(t("profileSaved"))
    } catch {
      toast.error(t("errors.unexpected"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2" data-testid="contact-profile-notes">
      <p className="text-xs font-medium">{t("profileTitle")}</p>
      <div className="space-y-1">
        <Label htmlFor="contact-relationship" className="text-xs">
          {t("relationship")}
        </Label>
        <Input
          id="contact-relationship"
          className="h-8 text-xs"
          maxLength={MAX_RELATIONSHIP_CHARS}
          placeholder={t("relationshipPlaceholder")}
          value={relationship}
          onChange={(event) => setRelationship(event.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="contact-note" className="text-xs">
          {t("note")}
        </Label>
        <Textarea
          id="contact-note"
          className="min-h-16 text-xs"
          maxLength={MAX_CONTACT_NOTE_CHARS}
          placeholder={t("notePlaceholder")}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>
      <p className="text-xs text-muted-foreground">{t("profileHint")}</p>
      <Button type="button" size="sm" disabled={!dirty || saving} onClick={() => void save()}>
        {t("profileSave")}
      </Button>
    </div>
  )
}

function HostOwnerBindingSection({ primary }: { primary: PlatformIdentityRow }) {
  const t = useTranslations("inbox.contactProfile")
  const route = useInboxWriteRoute()
  const [busy, setBusy] = useState(false)
  const [issuedCode, setIssuedCode] = useState<IssuedHostOwnerBindCode | null>(null)
  const isHostOwner = primary.isHostOwner === true

  if (route !== "local") {
    return (
      <div
        className="space-y-1 rounded-md border bg-muted/20 p-2.5 text-xs"
        data-testid="contact-host-owner-readonly"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium">{t("hostOwner.title")}</span>
          {isHostOwner ? (
            <Badge variant="secondary" className="text-[11px]">
              {t("hostOwner.verifiedBadge")}
            </Badge>
          ) : null}
        </div>
        <p className="text-muted-foreground">{t("profileReadOnly")}</p>
      </div>
    )
  }

  async function toggleOwner() {
    setBusy(true)
    try {
      const result = await setIdentityHostOwner(primary.id, !isHostOwner, "manual_operator")
      if (!result.ok) {
        toast.error(t(`errors.profile_${result.reason}`))
      } else {
        toast.success(
          result.primary.isHostOwner ? t("hostOwner.boundToast") : t("hostOwner.unboundToast")
        )
      }
    } catch {
      toast.error(t("errors.unexpected"))
    } finally {
      setBusy(false)
    }
  }

  async function handleGenerateCode() {
    setBusy(true)
    try {
      const issued = await issueHostOwnerBindCode()
      setIssuedCode(issued)
    } catch {
      toast.error(t("errors.unexpected"))
    } finally {
      setBusy(false)
    }
  }

  async function handleCopyCommand() {
    if (!issuedCode) return
    try {
      await navigator.clipboard.writeText(issuedCode.commandText)
      toast.success(t("hostOwner.codeCopied"))
    } catch {
      toast.error(t("errors.unexpected"))
    }
  }

  return (
    <div
      className="space-y-2 rounded-md border bg-muted/20 p-2.5 text-xs"
      data-testid="contact-host-owner-section"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-medium">
          <ShieldCheckIcon className="size-3.5 text-muted-foreground" aria-hidden />
          {t("hostOwner.title")}
        </span>
        {isHostOwner ? (
          <Badge variant="secondary" className="text-[11px]" data-testid="contact-host-owner-badge">
            {t("hostOwner.verifiedBadge")}
          </Badge>
        ) : null}
      </div>
      <p className="text-muted-foreground">{t("hostOwner.hint")}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          variant={isHostOwner ? "outline" : "secondary"}
          className="h-7 px-2.5 text-xs"
          disabled={busy}
          onClick={() => void toggleOwner()}
          data-testid="contact-host-owner-toggle"
        >
          {isHostOwner ? t("hostOwner.unbindAction") : t("hostOwner.bindAction")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 gap-1 px-2.5 text-xs"
          disabled={busy}
          onClick={() => void handleGenerateCode()}
          data-testid="contact-generate-bind-code"
        >
          <KeyRoundIcon className="size-3" aria-hidden />
          {t("hostOwner.generateCodeAction")}
        </Button>
      </div>
      {issuedCode ? (
        <div
          className="space-y-1 rounded border bg-background p-2"
          data-testid="contact-bind-code-box"
        >
          <div className="flex items-center justify-between gap-2">
            <code
              className="truncate font-mono text-[11px] font-semibold"
              data-testid="contact-bind-code-value"
            >
              {issuedCode.commandText}
            </code>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 gap-1 px-2 text-[11px]"
              onClick={() => void handleCopyCommand()}
              data-testid="contact-copy-bind-code"
            >
              <CopyIcon className="size-3" aria-hidden />
              {t("hostOwner.copyAction")}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">{t("hostOwner.codeHint")}</p>
        </div>
      ) : null}
    </div>
  )
}

export function ContactProfileDrawer({
  open,
  onOpenChange,
  conversationKey,
}: ContactProfileDrawerProps) {
  const t = useTranslations("inbox.contactProfile")
  const contact = useContact(conversationKey)
  const [mergeCandidate, setMergeCandidate] = useState<PlatformIdentityRow | null>(null)

  const unmergeError = (reason: IdentityUnmergeFailureReason) => t(`errors.${reason}`)

  const handleUnmerge = async (secondaryId: string) => {
    if (!contact) return
    try {
      const result = await unmergeIdentity(contact.primary.id, secondaryId)
      if (!result.ok) toast.error(unmergeError(result.reason))
    } catch {
      toast.error(t("errors.unexpected"))
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-80 sm:max-w-sm">
        <SheetHeader>
          <SheetTitle>{t("title")}</SheetTitle>
          <SheetDescription>{t("subtitle")}</SheetDescription>
        </SheetHeader>

        {!contact ? (
          <Empty className="rounded-none border-0 px-4 py-6" data-testid="contact-profile-empty">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <UserRoundXIcon aria-hidden />
              </EmptyMedia>
              <EmptyTitle>{t("title")}</EmptyTitle>
              <EmptyDescription>{t("empty")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="space-y-4 px-4 py-2" data-testid="contact-profile">
            <div className="space-y-1">
              <p className="text-base font-semibold">
                {contact.primary.displayName ?? contact.primary.remoteUserId}
              </p>
              <dl className="space-y-0.5 text-xs text-muted-foreground">
                <div className="flex justify-between gap-2">
                  <dt>{t("platform")}</dt>
                  <dd className="font-mono">{contact.primary.platform}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>{t("remoteId")}</dt>
                  <dd className="truncate font-mono">{contact.primary.remoteUserId}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>{t("lastSeen")}</dt>
                  <dd>{new Date(contact.primary.lastSeenAt).toLocaleString()}</dd>
                </div>
              </dl>
            </div>

            <HostOwnerBindingSection
              key={`owner:${contact.primary.id}`}
              primary={contact.primary}
            />

            <ContactProfileNotes key={contact.primary.id} primary={contact.primary} />

            {contact.merged.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium">{t("mergedTitle")}</p>
                <ItemGroup className="divide-y border-y">
                  {contact.merged.map((m) => (
                    <Item key={m.id} role="listitem" size="sm" className="rounded-none px-0">
                      <ItemContent>
                        <ItemTitle className="block max-w-full truncate text-xs">
                          {m.displayName ?? m.remoteUserId}
                          <span className="ml-1 text-muted-foreground">({m.platform})</span>
                        </ItemTitle>
                      </ItemContent>
                      <ItemActions>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-xs"
                          onClick={() => void handleUnmerge(m.id)}
                        >
                          {t("unmerge")}
                        </Button>
                      </ItemActions>
                    </Item>
                  ))}
                </ItemGroup>
              </div>
            )}

            {contact.candidates.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium">{t("candidatesTitle")}</p>
                <ItemGroup className="divide-y border-y">
                  {contact.candidates.map((candidate) => (
                    <Item
                      key={candidate.id}
                      role="listitem"
                      size="sm"
                      className="rounded-none px-0"
                    >
                      <ItemContent>
                        <ItemTitle className="block max-w-full truncate text-xs">
                          {candidate.displayName ?? candidate.remoteUserId}
                          <span className="ml-1 text-muted-foreground">({candidate.platform})</span>
                        </ItemTitle>
                      </ItemContent>
                      <ItemActions>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-xs"
                          onClick={() => setMergeCandidate(candidate)}
                        >
                          {t("merge")}
                        </Button>
                      </ItemActions>
                    </Item>
                  ))}
                </ItemGroup>
              </div>
            )}
          </div>
        )}
      </SheetContent>
      {contact && mergeCandidate && (
        <IdentityMergeDialog
          key={`${contact.primary.id}:${mergeCandidate.id}`}
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setMergeCandidate(null)
          }}
          identities={[contact.primary, mergeCandidate]}
          lockedPrimaryId={contact.primary.id}
          onMerged={() => setMergeCandidate(null)}
        />
      )}
    </Sheet>
  )
}
