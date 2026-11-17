"use client"

/**
 * Mobile bottom sheet for per-message actions (Wave 1.7).
 *
 * Triggered by long-press on a message row in the mobile shell. Provides
 * copy / quote / share / branch, "Select text" (a sheet for choosing part of the
 * message, since the long press itself selects none), plus — when the parent
 * supplies `onSelect` — "Select messages", and — when the parent supplies the
 * handlers — Regenerate (last assistant reply; the hover-only footer
 * controls in `message-renderer` are invisible on touch) and Delete
 * (confirmed destructive; the parent owns the store + Dexie + desktop
 * mirror fan-out).
 */

import { Fragment, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  BrainIcon,
  CircleDotIcon,
  CornerUpLeftIcon,
  GitBranchIcon,
  PuzzleIcon,
  Repeat2Icon,
  ReplyIcon,
  ImageIcon,
  ListChecksIcon,
  Loader2Icon,
  PencilIcon,
  QuoteIcon,
  RefreshCcwIcon,
  LinkIcon,
  SendHorizontalIcon,
  Share2Icon,
  ScissorsIcon,
  HistoryIcon,
  SquareIcon,
  TextSelectIcon,
  Trash2Icon,
  Volume2Icon,
} from "lucide-react"
import { motion } from "motion/react"
import { toast } from "sonner"
import type { UIMessage } from "ai"

import { Button } from "@/components/ui/button"
import { AnimatedActionIcon } from "@/components/shared/animated-action-icon"
import { BookmarkIcon as AnimatedBookmarkIcon } from "@/components/ui/bookmark"
import { CopyIcon as AnimatedCopyIcon } from "@/components/ui/copy"
import { Textarea } from "@/components/ui/textarea"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { useBackDismiss } from "@/hooks/ui/use-back-dismiss"
import { useReadAloudStatus } from "@/hooks/chat/use-read-aloud-status"
import { notify, selectionFeedback } from "@/lib/capacitor/haptics"
import { buildMessagePermalink } from "@/lib/chat/message-permalink"
import { writeClipboardText } from "@/lib/tauri/clipboard"
import { loadPort } from "@/lib/modules/ports"
import { STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
import { BranchDialog } from "@/components/chat/branch-dialog"
import { BranchNavigator } from "@/components/chat/branch-navigator"
import { UsageBreakdown } from "@/components/chat/usage-breakdown"
import { dispatchComposerAppend } from "@/components/chat/composer"
import type { UsageInfo } from "@/lib/chat/sdk-message-adapter"
import { useChatStore } from "@/stores/chat"
import { useSpeechSettingsView } from "@/lib/speech/settings"
import type { CharacterVoiceSource } from "@/lib/plugin/character-pack/character-voice"
import {
  resolveMessageActionCommands,
  type MessageActionCommand,
  type MessageActionCommandId,
} from "@/lib/chat/message-action-commands"
import { useMessagePluginItems } from "@/components/chat/message-plugin-menu"
import { useMessageCommands } from "@/components/chat/use-message-commands"
import { useTranscriptSessionId } from "@/components/chat/transcript-session-context"
import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import type { MessageMotion } from "@/types/appearance"
import { QuoteCardDialog } from "@/components/share/quote-card-dialog"
import { TruncateFromDialog } from "@/components/chat/truncate-from-dialog"
import { RestorePointDialog } from "@/components/chat/restore-point-dialog"
import { runMetadataOf } from "@/lib/chat/message-run-metadata"
import {
  buildMessageShareContent,
  copyMessageContent,
  messageTypedText,
  shareMessageContent,
} from "@/lib/chat/message-share"
import { MessageTextSelectionSheet } from "./message-text-selection-sheet"

export interface MessageActionSheetProps {
  message: UIMessage | null
  onOpenChange: (next: boolean) => void
  /**
   * Re-run the last assistant turn. Only pass when `message` IS the last
   * assistant message and no turn is in flight — the row renders iff set.
   */
  onRegenerate?: () => void | Promise<void>
  /**
   * Remove the message everywhere (store + local Dexie + desktop mirror).
   * The row renders iff set; the sheet adds the confirm step.
   */
  onDelete?: (message: UIMessage) => void | Promise<void>
  /**
   * Edit the message text and resend from that point. Only pass for the
   * user's own messages while no turn is in flight — the row renders iff
   * set. This is the touch path for the hover-only pencil in
   * `message-renderer`, which is unreachable on mobile.
   */
  onEditResend?: (message: UIMessage, newText: string) => void | Promise<void>
  /**
   * The character that spoke this message (team sender or the session's
   * 1:1 character) — drives the per-character voice of the Read-aloud row.
   * The row itself renders for assistant messages when TTS is enabled.
   */
  character?: CharacterVoiceSource | null
  messageMotion?: MessageMotion
  /**
   * Open the transcript's selection mode with this message ticked. Passed by a
   * transcript that mounts the mode; the row renders iff set, so a read-only
   * transcript offers no "Select messages" that would open nothing.
   */
  onSelect?: (message: UIMessage) => void
  /**
   * The commands the surface can carry out, when it supports only some (the
   * phone's view of a Host session). Absent means all.
   */
  allowedCommands?: ReadonlySet<MessageActionCommandId>
}

export function MessageActionSheet({
  message,
  onOpenChange,
  onRegenerate,
  onDelete,
  onEditResend,
  character,
  messageMotion = "restrained",
  onSelect,
  allowedCommands,
}: MessageActionSheetProps) {
  const t = useTranslations("mobile.messageActions")
  // The rows the desktop bar also draws read its labels, so the two match.
  const tMessage = useTranslations("chat.message")
  const tCommon = useTranslations("common")
  const open = message !== null
  const [cardOpen, setCardOpen] = useState(false)
  const [truncateOpen, setTruncateOpen] = useState(false)
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [nowFallback] = useState(() => new Date())
  // Android hardware / browser back closes the sheet instead of navigating.
  useBackDismiss(open, () => onOpenChange(false))
  // `busy` is always reset in the action handlers' try/finally below;
  // no separate effect needed to clear it on close.
  const [busy, setBusy] = useState(false)
  const [branchTarget, setBranchTarget] = useState<{
    sessionId: string
    messageId: string
  } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // Held apart from `message`, which the parent clears as this sheet closes.
  const [textTarget, setTextTarget] = useState<{ message: UIMessage; sessionId: string } | null>(
    null
  )
  // `null` = action-list mode; a string = edit mode holding the draft text.
  // Reset on every close so a reopened sheet always starts at the list.
  const [editText, setEditText] = useState<string | null>(null)

  // Touch path for the hover-only footer controls in `message-renderer`
  // (bookmark toggle, read-aloud, branch prev/next) — all unreachable on
  // mobile without these rows.
  const ttsEnabled = useSpeechSettingsView((s) => s?.ttsEnabled ?? false)
  const isBookmarked = useChatStore((s) =>
    message ? s.bookmarkedIds.includes(message.id) : false
  )
  const toggleBookmark = useChatStore((s) => s.toggleBookmark)
  const {
    available: readAloudAvailable,
    isActive: readAloudActive,
    isLoading: readAloudLoading,
  } = useReadAloudStatus(message?.id ?? "")

  // What the user typed, for quote, edit, resend and read-aloud; copy and
  // share hand over the whole message (images, sources) as desktop does.
  const text = message ? messageTypedText(message) : ""
  const shareable = useMemo(() => (message ? buildMessageShareContent(message) : null), [message])
  const canShare = shareable?.hasContent ?? false
  // Per-message token/cost — on desktop this lives in the hover-only action bar
  // (unreachable on touch), so surface it here as a non-interactive footer.
  const usage = (message?.metadata as { usage?: UsageInfo } | undefined)?.usage
  // A live reply has no session id yet; the transcript the sheet was opened
  // from knows whose it is, as the desktop row does.
  const transcriptSessionId = useTranscriptSessionId()
  const branchSessionId =
    message && typeof (message.metadata as { sessionId?: unknown } | undefined)?.sessionId === "string"
      ? ((message.metadata as { sessionId?: string }).sessionId as string)
      : message
        ? (transcriptSessionId ?? undefined)
        : undefined

  // A branch snapshots the visible thread, so taking one mid-turn would copy a
  // half-written reply. Read the branch target's OWN slice — the sheet can be
  // opened on a message belonging to a session that is not the active one.
  const branchSessionStreaming = useChatStore((s) => {
    const status = branchSessionId ? s.sessions[branchSessionId]?.status : undefined
    // `awaiting_approval` counts: a send there steers too, and a snapshot or
    // truncate would still freeze a half-written turn.
    return status === "streaming" || status === "awaiting_approval"
  })
  // Reply, rerun, save and hand-back do the same work as on the desktop bar.
  const shared = useMessageCommands({ message, sessionId: branchSessionId })
  const pluginItems = useMessagePluginItems({
    messageId: message?.id ?? "",
    sessionId: branchSessionId,
  })
  const commands = useMemo(
    () =>
      message
        ? resolveMessageActionCommands({
            role: message.role,
            hasContent: canShare,
            hasSession: Boolean(branchSessionId),
            canEdit: Boolean(onEditResend),
            canRegenerate: Boolean(onRegenerate),
            // Off where no module provides the `speech` port (ADR-0250 §14).
            canReadAloud: ttsEnabled && readAloudAvailable,
            canBringBack: Boolean(shared.handBackTargetId),
            canRerunTemplate: Boolean(shared.templateRun && branchSessionId),
            canSaveAsMemory: Boolean(branchSessionId),
            canSaveAsIssue: Boolean(branchSessionId),
            canSendToMain: Boolean(shared.asideTargetSessionId),
            canDelete: Boolean(onDelete),
            canSelect: Boolean(onSelect),
            // This sheet is the touch surface the capability exists for.
            canSelectText: true,
            allowed: allowedCommands,
            streaming: branchSessionStreaming,
          })
        : [],
    [
      allowedCommands,
      branchSessionId,
      branchSessionStreaming,
      canShare,
      message,
      onDelete,
      onEditResend,
      onRegenerate,
      onSelect,
      readAloudAvailable,
      shared.asideTargetSessionId,
      shared.handBackTargetId,
      shared.templateRun,
      ttsEnabled,
    ]
  )

  /** Run a command and close the sheet; the command reports its own outcome. */
  const runAndClose = (run: () => unknown) => {
    void selectionFeedback()
    void run()
    onOpenChange(false)
  }

  const onSelectText = () => {
    if (!message || !branchSessionId) return
    void selectionFeedback()
    setTextTarget({ message, sessionId: branchSessionId })
    onOpenChange(false)
  }

  const onSelectMessages = () => {
    if (!message || !onSelect) return
    void selectionFeedback()
    onSelect(message)
    onOpenChange(false)
  }

  const onBranch = () => {
    if (!message || !branchSessionId || branchSessionStreaming) return
    setBranchTarget({ sessionId: branchSessionId, messageId: message.id })
    onOpenChange(false)
  }

  const onCopy = async () => {
    if (!shareable?.hasContent) return
    setBusy(true)
    try {
      // The plain write throws on failure, which the catch below reports.
      await copyMessageContent(shareable, text, async (plain) => {
        await writeClipboardText(plain)
        return true
      })
      void notify("success")
      toast.success(t("copySuccess"))
      onOpenChange(false)
    } catch (err) {
      void notify("error")
      toast.error(t("copyFailed", { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }

  /**
   * A permalink back into THIS app, not a published share link — the row below
   * sits next to "Share…" and the two must not be confused.
   */
  const onCopyLink = async () => {
    if (!message || !branchSessionId) return
    setBusy(true)
    try {
      await writeClipboardText(
        buildMessagePermalink({ sessionId: branchSessionId, messageId: message.id })
      )
      void notify("success")
      toast.success(t("copyLinkSuccess"))
      onOpenChange(false)
    } catch (err) {
      void notify("error")
      toast.error(t("copyFailed", { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }

  const onQuote = () => {
    if (!text) return
    // Build a markdown blockquote from the message body and drop it into the
    // composer draft via the existing append bridge (composer.tsx). No new IPC
    // needed — the user then types their reply under the quote and sends.
    const quoted = text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n")
    // Addressed to the message's own session so a split pane / sidechat
    // composer never mirrors the quote.
    dispatchComposerAppend({ text: `${quoted}\n\n`, sessionId: branchSessionId })
    void selectionFeedback()
    onOpenChange(false)
  }

  const onRegenerateRow = () => {
    if (!onRegenerate) return
    void onRegenerate()
    onOpenChange(false)
  }

  // The touch sibling of the hover bar's resend button: same `onEditResend`
  // replay, skipping the draft step "Edit" opens.
  const onResendRow = async () => {
    if (!message || !onEditResend || !text) return
    setBusy(true)
    try {
      await onEditResend(message, text)
      onOpenChange(false)
    } catch (err) {
      void notify("error")
      toast.error(t("editFailed", { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }

  const onEditSubmit = async () => {
    if (!message || !onEditResend || editText === null) return
    const trimmed = editText.trim()
    if (!trimmed) return
    setBusy(true)
    try {
      await onEditResend(message, trimmed)
      setEditText(null)
      onOpenChange(false)
    } catch (err) {
      toast.error(t("editFailed", { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }

  const onDeleteConfirmed = async () => {
    if (!message || !onDelete) return
    setConfirmDelete(false)
    setBusy(true)
    try {
      await onDelete(message)
      void notify("success")
      toast.success(t("deleteSuccess"))
      onOpenChange(false)
    } catch (err) {
      void notify("error")
      toast.error(t("deleteFailed", { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }

  const onShare = async () => {
    if (!shareable?.hasContent) return
    setBusy(true)
    try {
      // The same share as desktop: images go along, and where there is no
      // share surface the message goes to the clipboard, said so.
      const out = await shareMessageContent(shareable, { dialogTitle: t("shareDialogTitle") })
      if (out.kind === "shared" || out.kind === "copied") {
        void notify("success")
        if (out.kind === "copied") toast.success(t("shareCopiedFallback"))
        onOpenChange(false)
      } else if (out.kind === "failed") {
        void notify("error")
        toast.error(t("shareFailed", { message: out.message ?? "" }))
      }
      // cancelled — silent.
    } finally {
      setBusy(false)
    }
  }

  const onBookmark = () => {
    if (!message) return
    toggleBookmark(message.id)
    void selectionFeedback()
    onOpenChange(false)
  }

  const onReadAloud = () => {
    if (!message || !text) return
    void selectionFeedback()
    const messageId = message.id
    const stopping = readAloudActive
    // Fire-and-forget like `ReadAloudButton` — progress surfaces in the
    // speech module's global "now playing" bar, so the sheet closes at once.
    void loadPort("speech")
      .then((speech) => {
        if (!speech) return
        if (stopping) {
          speech.readAloud.stop()
          return
        }
        return speech.readAloud.speakChatMessage({ messageId, text, character })
      })
      .catch(() => {
        void notify("error")
      })
    onOpenChange(false)
  }

  const renderRow = (command: MessageActionCommand): React.ReactNode => {
    const off = busy || command.disabled
    switch (command.id) {
      case "copy":
        return (
          <Row
            icon={<AnimatedActionIcon icon={AnimatedCopyIcon} size={16} />}
            label={t("copy")}
            onClick={onCopy}
            disabled={off}
            testid="message-action-copy"
          />
        )
      case "edit":
        return onEditResend ? (
          <Row
            icon={<PencilIcon className="size-4" />}
            label={t("edit")}
            onClick={() => setEditText(text)}
            disabled={off || !text}
            testid="message-action-edit"
          />
        ) : null
      case "resend":
        return onEditResend ? (
          <Row
            icon={<SendHorizontalIcon className="size-4" />}
            label={t("resend")}
            onClick={() => void onResendRow()}
            disabled={off || !text}
            testid="message-action-resend"
          />
        ) : null
      case "reply":
        return (
          <Row
            icon={<ReplyIcon className="size-4" />}
            label={tMessage("replyLabel")}
            onClick={() => runAndClose(shared.reply)}
            disabled={off}
            testid="message-action-reply"
          />
        )
      case "rerunTemplate":
        return (
          <Row
            icon={<Repeat2Icon className="size-4" />}
            label={tMessage("rerunTemplateLabel")}
            onClick={() => runAndClose(shared.rerunTemplate)}
            disabled={off}
            testid="message-action-rerun-template"
          />
        )
      case "saveAsMemory":
        return (
          <Row
            icon={<BrainIcon className="size-4" />}
            label={tMessage("saveAsMemoryLabel")}
            onClick={() => runAndClose(shared.saveAsMemory)}
            disabled={off}
            testid="message-action-save-as-memory"
          />
        )
      case "saveAsIssue":
        return (
          <Row
            icon={<CircleDotIcon className="size-4" />}
            label={tMessage("saveAsIssueLabel")}
            onClick={() => runAndClose(shared.saveAsIssue)}
            disabled={off}
            testid="message-action-save-as-issue"
          />
        )
      case "regenerate":
        return onRegenerate ? (
          <Row
            icon={<RefreshCcwIcon className="size-4" />}
            label={t("regenerate")}
            onClick={onRegenerateRow}
            disabled={off}
            testid="message-action-regenerate"
          />
        ) : null
      case "readAloud":
        return (
          <Row
            icon={
              readAloudLoading ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : readAloudActive ? (
                <SquareIcon className="size-4" />
              ) : (
                <Volume2Icon className="size-4" />
              )
            }
            label={readAloudActive ? t("stopReading") : t("readAloud")}
            onClick={onReadAloud}
            disabled={off || !text}
            testid="message-action-read-aloud"
          />
        )
      case "share":
        return (
          <Row
            icon={<Share2Icon className="size-4" />}
            label={t("share")}
            onClick={onShare}
            disabled={off}
            testid="message-action-share"
          />
        )
      case "quote":
        return (
          <Row
            icon={<QuoteIcon className="size-4" />}
            label={t("quote")}
            onClick={onQuote}
            disabled={off || !text}
            testid="message-action-quote"
          />
        )
      case "copyLink":
        return (
          <Row
            icon={<LinkIcon className="size-4" />}
            label={t("copyLink")}
            onClick={onCopyLink}
            disabled={off}
            testid="message-action-copy-link"
          />
        )
      case "shareCard":
        return (
          <Row
            icon={<ImageIcon className="size-4" />}
            label={t("shareCard")}
            onClick={() => setCardOpen(true)}
            disabled={off || !text}
            testid="message-action-share-card"
          />
        )
      case "bookmark":
        return (
          <Row
            icon={
              <AnimatedActionIcon
                icon={AnimatedBookmarkIcon}
                size={16}
                animateOnChange={isBookmarked}
                className={isBookmarked ? "fill-current text-yellow-500" : undefined}
              />
            }
            label={isBookmarked ? t("bookmarkRemove") : t("bookmark")}
            onClick={onBookmark}
            disabled={off}
            testid="message-action-bookmark"
          />
        )
      case "select":
        return onSelect ? (
          <Row
            icon={<ListChecksIcon className="size-4" />}
            label={t("select")}
            onClick={onSelectMessages}
            disabled={off}
            testid="message-action-select"
          />
        ) : null
      case "selectText":
        return (
          <Row
            icon={<TextSelectIcon className="size-4" />}
            label={t("selectText")}
            onClick={onSelectText}
            disabled={off}
            testid="message-action-select-text"
          />
        )
      case "branch":
        return (
          <Row
            icon={<GitBranchIcon className="size-4" />}
            label={t("branch")}
            onClick={onBranch}
            disabled={off}
            testid="message-action-branch"
          />
        )
      case "restorePoint":
        return (
          <Row
            icon={<HistoryIcon className="size-4" />}
            label={t("restorePoint")}
            onClick={() => setRestoreOpen(true)}
            disabled={off}
            testid="message-action-restore-point"
          />
        )
      case "truncate":
        return (
          <Row
            icon={<ScissorsIcon className="size-4 text-destructive" />}
            label={t("truncate")}
            onClick={() => setTruncateOpen(true)}
            disabled={off}
            testid="message-action-truncate"
          />
        )
      case "sendToMain":
        return (
          <Row
            icon={<CornerUpLeftIcon className="size-4" />}
            label={tMessage("sendToMainLabel")}
            onClick={() => runAndClose(shared.sendToMain)}
            disabled={off}
            testid="message-action-send-to-main"
          />
        )
      case "bringBack":
        return (
          <Row
            icon={<CornerUpLeftIcon className="size-4" />}
            label={tMessage("bringBackLabel")}
            onClick={() => runAndClose(shared.bringBack)}
            disabled={off}
            testid="message-action-bring-back"
          />
        )
      case "delete":
        return onDelete ? (
          <Row
            icon={<Trash2Icon className="size-4 text-destructive" />}
            label={t("delete")}
            onClick={() => setConfirmDelete(true)}
            disabled={busy}
            testid="message-action-delete"
          />
        ) : null
    }
  }

  return (
    <>
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (!next) setEditText(null)
        onOpenChange(next)
      }}
    >
      <DrawerContent data-testid="message-action-sheet">
        <DrawerHeader>
          <DrawerTitle>{t("title")}</DrawerTitle>
          <DrawerDescription>{t("description")}</DrawerDescription>
        </DrawerHeader>
        {editText !== null ? (
          <div className="flex flex-col gap-3 p-4 pb-8" data-testid="message-action-edit-pane">
            <Textarea
              aria-label={t("editInputAria")}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              disabled={busy}
              rows={5}
              // 16px floor avoids the iOS focus auto-zoom path.
              className="max-h-48 text-base"
              data-testid="message-action-edit-input"
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setEditText(null)}
                disabled={busy}
                data-testid="message-action-edit-cancel"
              >
                {tCommon("cancel")}
              </Button>
              <Button
                type="button"
                onClick={() => void onEditSubmit()}
                disabled={busy || !editText.trim()}
                data-testid="message-action-edit-send"
              >
                {t("editResend")}
              </Button>
            </div>
          </div>
        ) : (
        <StaggeredRows disabled={messageMotion === "off"}>
          {/* Every command the surface allows, the bar's first (D10). */}
          {commands.map((command) => (
            <Fragment key={command.id}>{renderRow(command)}</Fragment>
          ))}
          {message?.role === "assistant" && (
            // BranchNavigator renders null when the message has <2 regeneration
            // siblings; `has-[...]` keeps the labeled row hidden with it.
            <div
              className="hidden items-center justify-between px-3 py-2 has-[[data-testid=branch-navigator]]:flex"
              data-testid="message-action-branch-variants"
            >
              <span className="text-sm text-muted-foreground">{t("branchVariants")}</span>
              <BranchNavigator message={message} />
            </div>
          )}
          {/* What plugins contributed, as on the desktop "…" menu. */}
          {pluginItems.map((item) => (
            <Row
              key={item.id}
              icon={<PuzzleIcon className="size-4" />}
              label={item.label}
              onClick={() => runAndClose(item.run)}
              disabled={busy || item.disabled}
              testid="message-action-plugin"
            />
          ))}
          {message?.role === "assistant" && usage && (
            <div
              className="mt-1 border-t border-border px-3 pt-2 text-xs text-muted-foreground"
              data-testid="message-action-usage"
            >
              <UsageBreakdown usage={usage} />
            </div>
          )}
        </StaggeredRows>
        )}
      </DrawerContent>
    </Drawer>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("deleteConfirmDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void onDeleteConfirmed()}
              data-testid="message-action-delete-confirm"
            >
              {t("deleteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {branchTarget && (
        <BranchDialog
          sessionId={branchTarget.sessionId}
          messageId={branchTarget.messageId}
          open={branchTarget !== null}
          onOpenChange={(o) => {
            if (!o) setBranchTarget(null)
          }}
        />
      )}
      {cardOpen && message && (
        <QuoteCardDialog
          open
          onOpenChange={setCardOpen}
          role={message.role}
          text={text}
          model={runMetadataOf(message)?.modelId}
          timestamp={
            typeof (message.metadata as { createdAt?: unknown } | undefined)?.createdAt === "number"
              ? new Date((message.metadata as { createdAt: number }).createdAt)
              : nowFallback
          }
        />
      )}
      <MessageTextSelectionSheet
        message={textTarget?.message ?? null}
        sessionId={textTarget?.sessionId ?? null}
        onOpenChange={(next) => {
          if (!next) setTextTarget(null)
        }}
      />
      {truncateOpen && message && branchSessionId && (
        <TruncateFromDialog
          sessionId={branchSessionId}
          messageId={message.id}
          open
          onOpenChange={setTruncateOpen}
        />
      )}
      {restoreOpen && message && branchSessionId && (
        <RestorePointDialog
          sessionId={branchSessionId}
          messageId={message.id}
          open
          onOpenChange={setRestoreOpen}
          busy={branchSessionStreaming}
          {...(onEditResend && text ? { onEdit: () => setEditText(text) } : {})}
          onBranch={onBranch}
          onTruncate={() => setTruncateOpen(true)}
        />
      )}
    </>
  )
}

function StaggeredRows({
  children,
  disabled = false,
}: {
  children: React.ReactNode
  disabled?: boolean
}) {
  const { reduce } = useFlowMotion()
  return (
    <motion.div
      className="flex flex-col gap-1 p-4 pb-8"
      initial={reduce || disabled ? false : "initial"}
      animate="animate"
      variants={STAGGER_CONTAINER}
    >
      {/* Each Row is wrapped in a motion span so it picks up STAGGER_CHILD
       *  without forcing Row itself to be a motion component (keeps the
       *  Button slot intact for shadcn focus + disabled handling). */}
      {Array.isArray(children)
        ? children.map((child, i) => (
            <motion.span key={i} variants={STAGGER_CHILD} className="contents">
              {child}
            </motion.span>
          ))
        : children}
    </motion.div>
  )
}

interface RowProps {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  testid: string
}

function Row({ icon, label, onClick, disabled, testid }: RowProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      disabled={disabled}
      data-testid={testid}
      className="touch-target h-auto w-full justify-start gap-3 px-3 py-2 text-left text-sm font-normal"
    >
      <span aria-hidden="true">{icon}</span>
      <span className="flex-1">{label}</span>
    </Button>
  )
}
