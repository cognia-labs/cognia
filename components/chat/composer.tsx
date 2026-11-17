"use client"

// Composer — Cognia-style chat input.
//
// Layout (horizontal flex inside a rounded box):
//
//   [📎 📷 🎤 ⚙ ⇧⇥]   ┌─Textarea (flex-1)─┐  [▶ Submit]
//                      │            chars  │
//                      └───────────────────┘
//
// State management still flows through `<PromptInputProvider>` so the
// existing slash/@/!/# popover machinery keeps working — the provider's
// `controller.textInput` and `attachments` contexts stay the source of
// truth. We just don't render `<PromptInput>` (which forces a vertical
// `<InputGroup>` layout), and we own the form/textarea ourselves.

import { stagedRemoteDocument } from "@/lib/chat/attachments/remote-document"
import { parseRemoteDocumentProvenance } from "@/lib/docs-providers/document-provenance"
import {
  PromptInputProvider,
  usePromptInputAttachments,
  usePromptInputController,
  type TextInputContext,
} from "@/components/ai-elements/prompt-input"
import type { ChatStatus as PromptStatus, UIMessage } from "ai"
import { FileTextIcon, XIcon } from "lucide-react"
import { chatDockColumnClass } from "./chat-column"
import {
  ChangeEvent,
  type CSSProperties,
  forwardRef,
  KeyboardEvent as ReactKeyboardEvent,
  memo,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import {
  selectComposerCitedRefs,
  selectComposerContextSelections,
  selectComposerCarriedPreambles,
  selectComposerPermissionMode,
  selectComposerReplyTo,
  selectComposerWebSearchOn,
  useChatStore,
  useComposerContextSelections,
  useComposerEphemeralSkillIds,
  useComposerPermissionMode,
  type ChatStatus as StoreChatStatus,
} from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { useProjectStore } from "@/stores/project/project-store"
import { resolveSessionWorkspace } from "@/lib/workspace/session-workspace"
import { allRootPaths } from "@/lib/workspace/roots"
import { formatSearchResultsForLLM } from "@/lib/search/search-service"
import { searchWithAppSettings } from "@/lib/search/configured-search"
import { resolveWebAccess } from "@/lib/chat/web-access"
import { wrapUntrustedContent } from "@/lib/web/untrusted-content"
import { formatContextSelectionsForLLM } from "@/lib/artifacts/format-selection-context"
import { refreshSelectionFreshness } from "@/lib/chat/mentions/selection-freshness"
import { citationsForSelections } from "@/lib/chat/mentions/selection-citations"
import { mergeContextRefs } from "@/lib/chat/mentions/merge-refs"
import type { ContextRef } from "@/lib/chat/mentions/types"
import {
  carriedPreambleSections,
  composeTurnText,
  mergeCarriedPreambleSummary,
  summarizeSelectionForPreamble,
} from "@/lib/chat/prompt-preamble"
import {
  COMPOSER_APPEND_EVENT,
  composerAppendHasContent,
  type ComposerAppendDetail,
} from "@/lib/chat/composer-append"
import { estimateFallbackTokens } from "@/lib/ai/tokens/fallback-estimator"
import { formatReviewReceiptsForLLM } from "@/lib/artifacts/format-review-receipt"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import type {
  SendContent,
  SendOptions,
  ChatSession,
  MessageReplyTo,
} from "@cognia/agent-config-types"
import {
  buildSendContent,
  INLINE_TOKEN_CEILING,
  type AttachmentManifestEntry,
  type ExtractedAttachment,
  type SubmittedFile,
} from "@/lib/chat/attachments/dispatch"
import { isVideoDescriptor } from "@/lib/chat/attachments/video/classify"
import type { NativeVideoVerdict } from "@/lib/chat/attachments/video/delivery-gate"
import { isVideoPreprocessSettings } from "@/lib/chat/attachments/video/settings"
import { isContextSelectionRef } from "@/lib/chat/mentions/selection-guard"
import { applyOrder } from "@/lib/chat/attachments/reorder"
import { StagedAttachmentsProvider, useStagedAttachments } from "./composer/staged-attachment-store"
import { useBrowserDownloadAttachIntake } from "@/hooks/browser/use-browser-download-attach-intake"
import { useCameraRecovery } from "@/hooks/use-camera-recovery"
import { attachmentToFiles } from "@/components/mobile/chat/composer-attachment"
import { useAttachmentIntake } from "./composer/hooks/use-attachment-intake"
import { useComposerVideoRoute } from "./composer/hooks/use-composer-video-route"
import {
  useComposerImageInput,
  type ComposerImageInput,
} from "./composer/hooks/use-composer-image-input"
import { ComposerBox, composerCardRadiusPx, composerNoticeVars } from "./composer/composer-box"
import {
  resolveComposerSkin,
  toolbarSitsInBox,
  type ComposerSkinId,
  type ResolvedComposerSkin,
} from "@/lib/chat/composer-skin"
import { resolveStylePack } from "@/types/appearance/style-pack"
import { buildLinkContextBlocks, mergeContextBlocks } from "@/lib/chat/link-context"
import { expandFoldedLinks } from "@/lib/chat/link-fold"
import { requestBrowserUrl } from "@/lib/browser/open-url-request"
import { openExternal } from "@/lib/tauri/opener"
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
import { getDocumentAcceptExtensions } from "@cognia/document/support-matrix"
import { toast } from "sonner"
import { isImeComposing } from "@/lib/ui/ime"
import { cn } from "@/lib/utils"
import { expandPastes, findPastePlaceholders } from "@/lib/paste-collapse"
import { usePlatform } from "@/hooks/use-platform"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"
import { useSoftKeyboardDevice } from "@/hooks/ui/use-keyboard-insets"
import { useComposerKeyboardAvoidance } from "./composer/use-composer-keyboard-avoidance"
import { useCoarsePointer } from "@/hooks/ui/use-pointer"
import { useStableCallback } from "@/hooks/ui/use-stable-callback"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { TooltipProvider } from "@/components/ui/tooltip"
import { type ComposerWorkflowMention } from "./composer-trigger"
import {
  createAttachmentCitations,
  type AttachmentCitations,
} from "@/lib/chat/mentions/attachment-citations"
import { isContextRef } from "@/lib/chat/mentions/read"
import { ComposerPopover, type ComposerPopoverHandle } from "./composer-popover"
import { usePluginSlashCommandExecution } from "@/hooks/chat/use-plugin-slash-commands"
import { useEffectiveCwd } from "@/hooks/chat/use-effective-cwd"
import { parseLeadingRoute } from "@/lib/chat/turn-route/parse"
import { resolveRouteLane } from "@/lib/chat/turn-route/resolve"
import { snapshotRouteContext } from "@/lib/chat/turn-route/snapshot"
import { type TurnRoute } from "@/lib/chat/turn-route/types"
import { isChatTurnQueued } from "@/lib/execution/chat-lease"
import { sessionStatusOf } from "@/lib/chat/steer-runtime"
import { routeFailureText } from "@/components/squads/agent-mention-picker"
import { ContextChipBar } from "./composer/context-chip-bar"
import { CommandHintBar } from "./composer/command-hint-bar"
import { ScheduleSuggestion } from "./composer/schedule-suggestion"
import { resolveSendButton } from "./composer/send-button-mode"
import { canContinueChat, lastUserMessage } from "@/lib/chat/continuation"
import { selectVisibleMessages } from "@/stores/chat"
import { readTurnRoute } from "@/lib/chat/turn-route/types"
import { useOpenGoal } from "@/components/goal/use-active-goal"
import { ComposerCheatsheet } from "./composer/composer-cheatsheet"
import { nextPermissionMode } from "./permission-mode-indicator"
import { canEnqueueInboxWrite, useInboxWriteReadiness } from "@/lib/connectors/inbox-writes"
import {
  sendManualMessageToConversation,
  UnsupportedPlatformAttachmentsError,
} from "@/lib/inbox/manual-send"
import { listPendingForConversation as listPendingDrafts } from "@/lib/db/connector-drafts"
import { DraftEditor } from "@/components/inbox/draft-editor"
import { PlatformReplyAssistance } from "./composer/platform-reply-assistance"
import { PlatformBadge } from "@/components/inbox/platform-badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  applyTemplate,
  type SettingsTab,
  type SlashCommand,
  type SlashContext,
  type SlashStagedFiles,
} from "@/lib/slash-commands/builtin"
import {
  DIAGNOSTICS_PART_TYPE,
  type SystemMessageBlock,
  type SlashCommandResultBlock,
} from "@/lib/slash-commands/system-blocks"
import { parseSegments } from "@/lib/slash-commands/parse-segments"
import { renderParamTokens } from "@/lib/chat/template/render-params"
import { templateRunFromBinding, type ChatTemplateRun } from "@/lib/chat/template/run"
import { unfilledRequiredParams } from "@/lib/chat/template/template"
import { REPO_TEMPLATE_ID_PREFIX } from "@/lib/chat/template/repo-templates"
import { recordChatTemplateUse } from "@/lib/db/chat-templates"
import { TemplateParamPopover } from "./composer/template-param-popover"
import { SaveAsTemplateDialog } from "./composer/save-as-template-dialog"
import { TemplateLaunchDiffBar } from "./template-launch-diff-bar"
import { pillDeleteRange } from "./composer-pill-delete"
import { runSegments, type CommandError } from "@/lib/slash-commands/run-segments"
import {
  isMemoryTargetAvailable,
  memoryFilesUnavailableKey,
  memoryTargetKey,
  parseMemoryTargetKey,
  type ComposerMemoryTarget,
} from "@/lib/chat/memory-target"
import { useComposerCommandStore } from "@/stores/chat/composer-command-store"
import { useComposerGhostText } from "@/hooks/chat/use-composer-ghost-text"
import { useFollowUpSuggestions } from "@/hooks/chat/use-follow-up-suggestions"
import { FollowUpSuggestions } from "./follow-up-suggestions"
import type { InlineCommandInfo } from "@/lib/chat/completion/inline/types"
import { useLatestTextInput } from "./composer/hooks/use-latest-text-input"
import { useInputHistory } from "./composer/hooks/use-input-history"
import { CommandParamForm } from "./composer/command-param-form"
import { trackEvent } from "@/lib/telemetry/events/track-event"
import { formatShellResult } from "@/lib/shell/exec"
import { useShellContext } from "@/hooks/chat/use-shell-intelligence"
import { runShellLine } from "@/lib/shell-intelligence/execute"
import { startShellJob } from "@/lib/shell-intelligence/shell-job"
import { buildShellJobCardMessage, startShellJobRun } from "@/lib/shell-intelligence/shell-job-run"
import { shellJobTranscript } from "@/lib/chat/shell-job-transcript"
import { useShellJobCopy } from "./shell-job/use-shell-job-copy"
import { runInTerminalDock } from "@/lib/terminal/run-in-dock"
import { terminalAvailable } from "@/lib/terminal/pick-transport"
import { detectInteractiveCommand } from "@/lib/ai/agent/execution/permissions/interactive-command"
// `rememberFact` is imported lazily at its call site, not here: it pulls in the
// Dexie session schema and the redaction package, which every composer test
// otherwise has to mock just to render the box.
import { useUpdateSession } from "@/lib/data-hooks/context"
import { loggers } from "@cognia/logging"
import { impact, notify } from "@/lib/capacitor/haptics"
import { hideKeyboard } from "@/lib/capacitor/keyboard"
import {
  clearDraft as clearChatDraft,
  getDraft as getChatDraft,
  setDraftDebounced as setChatDraftDebounced,
  type DraftAttachmentMeta,
} from "@/lib/db/chat-drafts"
import { draftAttachmentsFromFiles } from "@/lib/chat/draft-attachments"
import {
  useExternalSessionLinkForSession,
  useRuntimeRefForSession,
} from "@/stores/agent/agent-runtime-store"
import { ExternalAgentExtensionUi } from "@/components/agent/external/extension-ui"
import { mergeComposerIntentPrompt } from "@/lib/chat/merge-composer-intent"
import { useSidechatShortcut } from "@/hooks/chat/use-sidechat-shortcut"
import { useComposerIntentStore } from "@/stores/chat/composer-intent-store"
import { DraftRestoredAttachments } from "./composer/draft-restored-attachments"
import { OcrResultBubble } from "./composer/ocr-result-bubble"

import { mobileTransition, useReducedMotionTransition } from "@/lib/ui/motion"
import { BestOfNStartDialog } from "./composer/best-of-n-start-dialog"
import type { PreparedBestOfN } from "@/lib/best-of-n/entry"
import { BottomToolbar } from "./composer/bottom-toolbar"
import { Collapse } from "./composer/collapse"
import { SkillChipRow } from "./composer/skill-chip-row"
import { GoalStatusPill } from "@/components/goal/goal-status-pill"
import { PlanModeBanner } from "@/components/chat/plan-mode-banner"
import { LoopStatusPill } from "@/components/loop/loop-status-pill"
import { HelperHints } from "./composer/helper-hints"
import { VoiceControls } from "./composer/voice-controls"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { InboxComposerActionsHost } from "@/components/inbox/inbox-composer-actions-host"
import { CannedResponsePicker } from "@/components/inbox/canned-response-picker"
import { EnhanceButton } from "./composer/enhance-button"
import { WebSearchToggle } from "./composer/web-search-toggle"
import { RoomTargetPicker } from "./composer/room-target-picker"
import { clearComposerTyping, noteComposerTyping } from "@/stores/chat/composer-typing-store"
import { roomTargetsOf } from "@/stores/chat/room-target-store"
import { SkillsMenuEntry } from "./composer/skills-menu-entry"
import { ComposerSessionProvider } from "./composer/composer-session-context"

interface Props {
  session?: ChatSession | null
  /**
   * Status of the pane that owns this composer. Multi-pane chat passes this
   * explicitly so a background stream does not inherit the focused pane's
   * Send/Stop state.
   */
  status?: StoreChatStatus
  onStartNewSession: () => void | Promise<void>
  onOpenSettings: (tab: SettingsTab) => void
  /**
   * Dispatch the turn. `manifest` describes the leading attachment blocks so the
   * transcript can render file cards instead of raw extracted text.
   * Return `false` only when refused before the input reaches the transcript.
   * `true` (including a retained failed row) and legacy `void` clear the draft.
   */
  onSend: (
    content: SendContent,
    manifest?: readonly AttachmentManifestEntry[],
    /**
     * What this turn was written from, when it came from a template with
     * parameters. Recorded on the user message row so the turn can be re-run
     * with different values — the sent text has the values substituted in and
     * no longer says which words were parameters. Optional, so the hosts that
     * do not record it simply ignore the argument.
     */
    templateRun?: ChatTemplateRun | null,
    turnMetadata?: ComposerTurnMetadata
  ) => boolean | void | Promise<boolean | void>
  onStop: () => void | Promise<void>
  disabled?: boolean
  /**
   * Override the default placeholder. Useful for the team workspace which
   * needs a different hint text.
   */
  placeholder?: string
  /**
   * Placeholder while `disabled`, when the host knows WHY sends are off. The
   * generic "pick a conversation" copy was wrong over a live transcript whose
   * Host had merely gone offline.
   */
  disabledPlaceholder?: string
  /**
   * Workflow-editor copilot integration. When set, `@` (and `@node:` /
   * `@edge:`) open a picker over the workflow's graph elements; picking one
   * stages a reference chip. Its presence also flips `@` mode to `"workflow"`.
   * Undefined for every non-workflow composer.
   */
  workflowMention?: ComposerWorkflowMention
  /**
   * Whether a leading `@claude` / `@codex` / `@<Squad member>` may address a
   * runtime (`lib/chat/turn-route/`). Defaults to on; the session decides the
   * rest. Only the new-chat composer needs this: it has no session to read,
   * and when its first turn lands in a team room — which routes `@Name`
   * through its own router — the route would otherwise be offered and then
   * silently dropped by the room's send.
   */
  routing?: boolean
  /**
   * Where this composer sits. `"docked"` (default) is the bar pinned under a
   * message list. `"hero"` is the centred box on the welcome screen, which has
   * no list above it to fade from — see the class branch in the wrapper.
   */
  placement?: "docked" | "hero"
  /**
   * Per-surface default skin, used only when the user has NOT picked one
   * (`composerBehavior.skin` still wins, then this, then the style pack's).
   * The welcome hero passes `"dense"`: a first-run page should show the
   * tighter, mono box rather than whatever the pack default happens to be.
   */
  defaultSkin?: ComposerSkinId
  /**
   * Rotating example prompts shown inside the empty box (the welcome hero's
   * hint carousel). Painted as an overlay, never as a real placeholder — so
   * the caret, focus and the chip/ghost layers are untouched, and the first
   * keystroke hides it instantly. Omit for the static placeholder.
   */
  placeholderHints?: readonly string[]
  /**
   * Extra controls rendered inside the input card's control row, ahead of the
   * status toolbar — e.g. the welcome surface's character-entry button.
   */
  toolbar?: ReactNode
  /**
   * The live run strip (`RunStatusBar`), docked onto the top edge of the input
   * card. Passed in by the host rather than mounted above the composer: only
   * here can it sit flush against the box, inset by the skin's corner radius,
   * instead of floating above the dock's scrim padding as a separate band.
   */
  runStatus?: ReactNode
}

/**
 * Metadata assembled before dispatch that must travel with this exact turn.
 * Declared in `lib/chat/turn-metadata.ts` so every host maps it to send
 * options through one helper. Re-exported here because the hosts import it
 * from the composer.
 */
export type { ComposerTurnMetadata } from "@/lib/chat/turn-metadata"
import type { ComposerTurnMetadata } from "@/lib/chat/turn-metadata"
import { SideChatDispatchError } from "@/lib/slash-commands/actions/side-chat"
import { useComposerOcr } from "./composer/hooks/use-composer-ocr"
import { useComposerMentionSources } from "./composer/hooks/use-composer-mention-sources"
import { useComposerCustomCommands } from "./composer/hooks/use-composer-custom-commands"
import { useComposerSlashCommands } from "./composer/hooks/use-composer-slash-commands"
import { useComposerTemplates } from "./composer/hooks/use-composer-templates"
import { useComposerShellMode } from "./composer/hooks/use-composer-shell-mode"
import { useComposerSegments } from "./composer/hooks/use-composer-segments"
import { useComposerTrigger } from "./composer/hooks/use-composer-trigger"
import { useComposerPopoverActions } from "./composer/hooks/use-composer-popover-actions"

/**
 * Imperative handle exposed by `<Composer>`. The desktop shell uses it to
 * inject `@CharacterName` mentions at the caret when the user clicks a
 * row in the team member list.
 */
export interface ComposerHandle {
  insertMention: (name: string) => void
  /** Move keyboard focus to the textarea. The chat pane calls this after the
   *  empty→chat layout swap remounts the composer so focus isn't dropped. */
  focus: () => void
}

// Max composer textarea height before it scrolls. Single source of truth so the
// CSS cap (`maxHeight`) and the JS auto-resize fallback can't drift apart. The
// px form assumes the app's default 16px root (the JS path only runs on old
// WebViews lacking `field-sizing`).
const COMPOSER_MAX_HEIGHT_REM = 12
const COMPOSER_MAX_HEIGHT_PX = COMPOSER_MAX_HEIGHT_REM * 16

// --- Helpers ---------------------------------------------------------------

function supportsQQOriginalFiles(session?: ChatSession | null): boolean {
  const binding = session?.platformBinding
  return (
    binding?.platform === "qq-official" &&
    (binding.conversationRef.scene === "group" || binding.conversationRef.scene === "c2c")
  )
}

// Accept images plus every text/binary document type lib/document can extract
// (pdf, docx, xlsx, pptx, csv, md, code, …). A folder picked from the attach
// menu takes the @-mention reference path instead (absolute path, read on
// demand); only a *dropped* folder is flattened into this attachment input,
// since a drop carries no absolute path.
const ATTACHMENT_ACCEPT = ["image/*", ...getDocumentAcceptExtensions("chat")].join(",")
// Plus videos, which are sampled into frames at staging time. Not offered in a
// model conversation only. Native QQ group/C2C uses original-file intake instead.
const MOTION_ATTACHMENT_ACCEPT = [
  ATTACHMENT_ACCEPT,
  "video/*",
  "audio/*",
  ".mp3",
  ".wav",
  ".m4a",
  ".ogg",
  ".opus",
  ".flac",
  ".aac",
].join(",")

const blobUrlToDataUrl = async (url: string): Promise<string | null> => {
  try {
    const res = await fetch(url)
    const blob = await res.blob()
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(reader.result as string)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

// --- Inner box with full state wiring --------------------------------------

interface InnerProps {
  externalSessionLink?: { agentId: string; sessionId: string }
  session?: ChatSession | null
  status: PromptStatus
  disabled?: boolean
  /**
   * Submit a turn. Resolves `true` when the turn was handled (the input should
   * be cleared) and `false` when the user cancelled (e.g. declined the oversize
   * confirmation) so the composer keeps the draft + attachments intact.
   *
   * `precomputed` carries the staging-time extraction results (see
   * `staged-attachment-store`). It is threaded through the callback rather than
   * read from a hook because `handleSubmit` lives OUTSIDE `PromptInputProvider`
   * and so cannot reach the store.
   */
  onSubmit: (
    text: string,
    files: SubmittedFile[],
    precomputed?: ReadonlyMap<string, ExtractedAttachment>,
    templateRun?: ChatTemplateRun | null,
    submission?: { replyTo: MessageReplyTo | null },
    /**
     * The runtime the text's leading `@handle` addresses, read against the
     * targets this composer's `@` panel offered — so a handle the panel
     * disambiguated (`squad-member`) routes exactly as it was picked.
     */
    route?: TurnRoute | null
  ) => boolean | Promise<boolean>
  /**
   * Binds a picked document's citation to the attachment it staged. Owned by
   * the outer `Composer` for the same reason `precomputed` is threaded through
   * `onSubmit`: `handleSubmit` reads it, and cannot reach the provider whose
   * attachment list binds it.
   */
  attachmentCitations: AttachmentCitations
  canResume?: boolean
  onResume?: () => void | Promise<void>
  onStop: () => void | Promise<void>
  commandRunning?: boolean
  /**
   * Run an action command. `staged` is the composer's attachments at send time;
   * a command that uses one (`/video`'s start frame) consumes it, and the turn
   * sent after the batch leaves consumed files out.
   */
  onCommand: (cmd: SlashCommand, args: string, staged?: SlashStagedFiles) => Promise<boolean>
  onSubmitMemory: (target: ComposerMemoryTarget, text: string) => Promise<boolean>
  /**
   * Run a `!shell` line. Lives here (rather than being inferred from the
   * outgoing text in the outer `handleSubmit`) so the `!` mode is decided from
   * the ORIGINAL input: `/clear\n!ls` must not run a shell command just because
   * stripping the command left `!ls` as the outgoing prose.
   */
  onSubmitShell: (command: string) => Promise<boolean>
  /** Open the shortcut cheatsheet (bound to `?` on an empty input). */
  onOpenCheatsheet: () => void
  /** Open a settings tab — the enhance wand's "no model" toast uses it. */
  onOpenSettings: (tab: SettingsTab) => void
  /**
   * Drafted replies waiting in this platform conversation. With an empty box
   * the send button offers to review them (`send-button-mode.ts`).
   */
  pendingDraftCount?: number
  /** Open the draft review dialog the outer composer owns. */
  onReviewDrafts?: () => void
  handleRef?: Ref<ComposerHandle>
  placeholder?: string
  /** See the outer `Props.disabledPlaceholder`. */
  disabledPlaceholder?: string
  workflowMention?: ComposerWorkflowMention
  /** See the outer `Props.routing`. */
  routing?: boolean
  /** Rotating hints for the empty box — see `ComposerBoxProps`. */
  placeholderHints?: readonly string[]
  /** Compact mode embeds the model and agent controls into the input surface. */
  compactLayout?: boolean
  /** Resolved by the outer `Composer` so one read feeds the whole tree. */
  skin: ResolvedComposerSkin
  toolbar?: ReactNode
  /** See the outer `Props.runStatus`. */
  runStatus?: ReactNode
  /**
   * Whether this conversation could take an original video file. Resolved by
   * the outer `Composer`, whose `handleSubmit` reads the same verdict.
   */
  videoRoute: NativeVideoVerdict
  /** Whether staged images reach the model (`useComposerImageInput`). */
  imageInput: ComposerImageInput
}

function ComposerInner(props: InnerProps) {
  const t = useTranslations("chat.composer")
  const tAttach = useTranslations("chat.composer.attachments")
  const tCommands = useTranslations("chat.composer.commands")
  const tMemory = useTranslations("chat.composer.memory")
  const tTemplateParams = useTranslations("chat.composer.templateParams")
  const tSkill = useTranslations("chat.composer.skills")
  const platform = usePlatform()
  const isDesktop = platform === "tauri"
  // Three different questions, kept apart (see `hooks/ui/use-compact-layout.ts`):
  //
  //  - `nativeMobile`: the Capacitor shell — native camera / album pickers,
  //    haptics, the native keyboard plugin.
  //  - `isMobile`: the PHONE-SHAPED layout — textarea on top, one action row
  //    underneath, touch-sized controls — regardless of container width. A
  //    375px browser renders the same `AppShellMobile` the native shell does,
  //    and used to get the desktop composer inside it.
  //  - `softKeyboard`: a keyboard that covers the reply after a send. True in
  //    the native shell and in a narrow touch browser; a narrow DESKTOP window
  //    keeps its hardware keyboard, and blurring the box there would only cost
  //    the user a click before the follow-up.
  const nativeMobile = platform === "mobile"
  const compactShell = useCompactLayout()
  const coarsePointer = useCoarsePointer()
  const isMobile = nativeMobile || compactShell
  const softKeyboard = nativeMobile || (compactShell && coarsePointer)
  /** Keyboard hints (`Tab`, `Esc`, the manual-completion key) need a keyboard. */
  const touchInput = nativeMobile || coarsePointer
  const inboxReadiness = useInboxWriteReadiness()
  const outboundBlocked =
    !!props.session?.platformBinding &&
    (inboxReadiness.route === "unavailable" || !canEnqueueInboxWrite(inboxReadiness.availability))
  // Non-LLM composer behavior toggles (AppSettings.composerBehavior). Each
  // defaults ON via `!== false` so an absent block preserves prior behavior.
  const composerBehavior = useSettingsStore((s) => s.settings?.composerBehavior)
  // Opt-out (`!== false`), like every other composer-assistance switch.
  const enhanceEnabled = useSettingsStore(
    (s) => s.settings?.composerAssistance?.enhance?.enabled !== false
  )
  const compactLayout = props.compactLayout === true
  const sendOnEnter = composerBehavior?.sendOnEnter !== false
  const clearAfterSendEnabled = composerBehavior?.clearAfterSend !== false
  const inputHistoryRecall = composerBehavior?.inputHistoryRecall !== false
  const persistDrafts = composerBehavior?.persistDrafts !== false
  const controller = usePromptInputController()
  // The draft, two ways. `textValue` is the text THIS render is drawing —
  // memos over the draft and the JSX read it, and it is what re-renders them.
  // `textInput` is a stable handle whose `value` is always the latest text:
  // callbacks and effects go through it, so a keystroke no longer rebuilds
  // `submit`, `onKeyDown`, the popover pick, the imperative handle and the
  // attachment intake, or re-runs the draft hydration and the template re-run
  // subscription. See `useLatestTextInput`.
  const textValue = controller.textInput.value
  const textInput = useLatestTextInput(controller.textInput)
  const attachments = usePromptInputAttachments()
  // Extraction results / chip order / OCR opt-in for the staged attachments.
  const staged = useStagedAttachments()
  const { attachmentCitations } = props
  // Binds each newly staged file to the citation announced for it, and notices
  // removed chips. Declared ahead of the draft-persist effect on purpose:
  // effects run in declaration order, so a save in the same commit as a new
  // chip already sees its citation.
  useEffect(() => {
    attachmentCitations.observe(attachments.files)
  }, [attachmentCitations, attachments.files])
  const {
    setOcrBubbleOpen,
    openOcrBubble,
    ocrBubbleOpen,
    ocrBubbleResult,
    ocrBubbleImageSrc,
    handleExtractImageText,
    handleRunOcrForPanel,
    ocr,
    handleExtractOcrToInput,
  } = useComposerOcr({ textInput, attachments, staged })
  // Memoized so the `+` menus that receive it (a prop of the box) are handed
  // the same element between keystrokes.
  const capabilityMenu = useMemo(
    () =>
      props.session?.kind === "workflow-editor" ? null : (
        <ComposerCapabilityMenu
          session={props.session}
          status={props.status}
          disabled={props.disabled}
          onOpenSettings={props.onOpenSettings}
        />
      ),
    [props.session, props.status, props.disabled, props.onOpenSettings]
  )
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Send protection: the chat store only flips to "streaming" once the dispatch
  // pipeline reaches `setSessionStatus`, leaving a window after the click where
  // the button would still read as "send". The in-flight flags are set
  // synchronously the instant a message is dispatched so the button shows the
  // running state immediately and a second submit (a fast Enter / double-click)
  // is rejected. The refs are the synchronous re-entrancy guard; the state
  // drives the render.
  //
  // Two lanes, because `onSubmit` does not settle at the same point for every
  // runtime: an external agent's send awaits the WHOLE run. A single flag held
  // the button on a spinner for the entire turn (no Stop) and rejected every
  // follow-up typed meanwhile. So a fresh turn's dispatch only guards until
  // the turn is live; a follow-up (a submit made while the turn streams, which
  // the controller routes into the steer lane) is tracked on its own.
  const [turnInFlight, setTurnInFlight] = useState(false)
  const [followUpInFlight, setFollowUpInFlight] = useState(false)
  const turnInFlightRef = useRef(false)
  const followUpInFlightRef = useRef(false)
  const chipOverlayRef = useRef<HTMLDivElement>(null)
  const shellDiagnosticOverlayRef = useRef<HTMLDivElement>(null)
  const ghostOverlayRef = useRef<HTMLDivElement>(null)
  // The hint the carousel is currently showing — kept in a ref so Tab-accept
  // in onKeyDown reads it without re-subscribing the keydown handler.
  const activeHintRef = useRef("")
  const noteActiveHint = useCallback((hint: string) => {
    activeHintRef.current = hint
  }, [])
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null)
  const popoverRef = useRef<ComposerPopoverHandle | null>(null)

  const [caret, setCaret] = useState(0)
  const [popoverDismissed, setPopoverDismissed] = useState<{
    tokenStart: number
    kind: string
  } | null>(null)
  // When a picked command declares `params`, we open a guided form instead of
  // inserting raw text. The captured token range tells us where to splice the
  // built `/command <args>` chip back in.
  const [paramForm, setParamForm] = useState<{
    command: SlashCommand
    tokenStart: number
    tokenEnd: number
  } | null>(null)
  const [isComposing, setIsComposing] = useState(false)
  const [draftHydratedFor, setDraftHydratedFor] = useState<string | null>(null)
  const predictionAcceptance = useSettingsStore(
    (s) => s.settings?.composerAssistance?.suggestions?.acceptance ?? "draft"
  )
  // Restored draft attachments whose binary did NOT survive (evicted by the
  // draft quota, or saved before binaries were persisted at all). Declared here
  // so `handleSend`'s clear path can reset it. Everything else is re-staged as
  // a real attachment; these are the leftovers that surface as "re-attach"
  // reminder chips above the input.
  const [restoredAttachments, setRestoredAttachments] = useState<DraftAttachmentMeta[]>([])
  // Every path that gets bytes (or a folded text paste) INTO the composer —
  // paperclip, mobile "+", paste, drop, smart snapshot, remote doc pick. They
  // share one size/count/type gate; see `use-attachment-intake`.
  const {
    fileInputRef,
    attachmentPrepareCountRef,
    setPastedBlocks,
    onPlusAttach,
    onPaste,
    onFilePick,
    openFileDialog,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
    isDragging,
    pastedBlocks,
    removePastedBlock,
    isPreparingAttachments,
    preparingImageCount,
    captureSmartSnapshot,
    smartSnapshotPending,
    stageRemoteDoc,
    acceptFiles,
  } = useAttachmentIntake({
    destinationKey: props.session?.id,
    attachments,
    attachmentCitations,
    textInput: textInput,
    textareaRef,
    setCaret,
    isDesktop,
    t,
    tAttach,
    acceptMotion: !props.session?.platformBinding,
    originalFiles: supportsQQOriginalFiles(props.session),
  })
  // Files handed back from outside (a put-back follow-up) pass the same
  // size/count/type gate as a drop or a paste.
  const addStagedFiles = useCallback(
    (files: File[]) => {
      void acceptFiles(files)
    },
    [acceptFiles]
  )
  // Per-command failures from the last multi-command submit. Surfaced as
  // failed-state pills on the command queue bar; cleared when the user edits.
  const [commandErrors, setCommandErrors] = useState<CommandError[]>([])

  const setPermissionMode = useChatStore((s) => s.setPermissionMode)
  // Read the pane's OWN conversation, matching every write below. Reading
  // `s.permissionMode` here read the FOCUSED conversation, so in split view the
  // unfocused composer showed the other pane's mode and Shift+Tab cycled from
  // it — and the mode reaches the model through `resolveSendOptions`.
  const permissionMode = useComposerPermissionMode(props.session?.id ?? null)
  const addReferencedPath = useChatStore((s) => s.addReferencedPath)
  const updateSession = useUpdateSession()
  // Effective cwd (session override → workspace root → character → default) —
  // NOT the raw session.workingDir, so `@` file refs, custom slash commands
  // and the footer chip agree with what a send actually runs in.
  const cwd = useEffectiveCwd(props.session)
  const sessionId = props.session?.id ?? null
  // ADR-0201: an agent's `browser_download {action:"attach"}` for this chat
  // lands here as a staged attachment, through the same intake gate.
  useBrowserDownloadAttachIntake({ sessionId, acceptFiles })
  // Pending sends must settle against the draft that is currently mounted,
  // rather than the input/attachments captured before their first await.
  const currentDraftRef = useRef({
    sessionId,
    text: textValue,
    files: attachments.files,
  })
  useEffect(() => {
    currentDraftRef.current = {
      sessionId,
      text: textValue,
      files: attachments.files,
    }
  }, [sessionId, textValue, attachments.files])

  // The default provider, for the `@claude` route's engine (see `routeProviderId`).
  const defaultProvider = useSettingsStore((s) => s.settings?.defaultProvider)
  const {
    routes,
    chatAgents,
    teamMembers,
    resolvedMentionMode,
    applyPreset,
    isCombinedMention,
    teamMemberRoleById,
    chatSkills,
    chatPresets,
    entityContext,
  } = useComposerMentionSources({ cwd, defaultProvider, props })
  const { customCommands, memoryFilesAccess } = useComposerCustomCommands({ isDesktop, cwd, props })

  // --- Hydrate chat-store from session row on first session change -------
  // `hydratedFor` flips to the session id once the hydration write has
  // *committed*, not just been scheduled. The persist effect below reads
  // this ref to skip the first post-hydration render, where the store value
  // hasn't yet caught up with the session row and would otherwise look
  // divergent and trigger a redundant write.
  const hydratedFor = useRef<string | null>(null)
  const pendingHydrationFor = useRef<string | null>(null)
  useEffect(() => {
    if (!props.session) return
    if (
      hydratedFor.current === props.session.id ||
      pendingHydrationFor.current === props.session.id
    ) {
      return
    }
    pendingHydrationFor.current = props.session.id
    setPermissionMode(props.session.permissionMode ?? null, props.session.id)
  }, [props.session, setPermissionMode])

  // --- Persist active permission mode back to session row ---------------
  useEffect(() => {
    if (!props.session) return
    // Hydration two-phase commit: when permissionMode catches up with the
    // session row's value (the value we hydrated *to*), flip the
    // hydratedFor ref. Until that point the persist branch is a no-op so
    // the very first render after a session swap doesn't write the stale
    // store value back to the row.
    if (
      pendingHydrationFor.current === props.session.id &&
      hydratedFor.current !== props.session.id &&
      permissionMode === (props.session.permissionMode ?? null)
    ) {
      hydratedFor.current = props.session.id
      pendingHydrationFor.current = null
      return
    }
    if (hydratedFor.current !== props.session.id) return
    // Same normalization as the hydration check above: the row stores
    // `permissionMode` as optional (absent → `undefined`) while the store
    // uses `null` for "unset". Comparing raw values makes `undefined !== null`
    // diverge forever — each write bumps `updatedAt`, the live query re-emits
    // a fresh session object, this effect re-runs and writes again. That is a
    // self-sustaining IDB write loop that re-renders the whole sidebar tree.
    if ((props.session.permissionMode ?? null) === permissionMode) return
    void updateSession(props.session.id, {
      permissionMode: permissionMode ?? undefined,
    }).catch((err) => {
      loggers.chat.warn("updateSession permissionMode failed", {
        sessionId: props.session?.id,
        err: err instanceof Error ? err.message : String(err),
      })
    })
  }, [permissionMode, props.session, updateSession])

  const tBestOfN = useTranslations("bestOfNEntry")
  const { commandMap, slashCommands, commandScope } = useComposerSlashCommands({
    customCommands,
    tBestOfN,
    props,
  })
  const {
    overlaySegments,
    isLinkToken,
    foldedLinks,
    setFoldedLinks,
    segments,
    linkFolding,
    routeState,
  } = useComposerSegments({
    composerBehavior,
    textValue,
    textInput,
    textareaRef,
    setCaret,
    routes,
    commandMap,
  })
  const {
    setTemplateBinding,
    setPendingLaunchSpec,
    setActiveParamId,
    paramIds,
    effectiveBinding,
    paramDeclarations,
    paramTokens,
    activeParamId,
    paramTokenAt,
    pendingLaunchSpec,
    launchDifferences,
    launchFieldLabel,
    startSessionFromTemplate,
    paramPillState,
    preview,
    setSaveTemplateOpen,
    saveTemplateOpen,
    currentLaunchSpec,
    saveCurrentAsTemplate,
    searchTemplateResources,
    setParamValue,
    chatTemplates,
  } = useComposerTemplates({
    tTemplateParams,
    textValue,
    textInput,
    textareaRef,
    setCaret,
    cwd,
    sessionId,
    routes,
    chatAgents,
    teamMembers,
    overlaySegments,
    props,
  })

  // Recent / pinned slash commands for the popover's empty-query view.
  const recentCommands = useComposerCommandStore((s) => s.recentCommands)
  const pinnedCommands = useComposerCommandStore((s) => s.pinnedCommands)
  const noteCommandUsed = useComposerCommandStore((s) => s.noteCommandUsed)
  const togglePinnedCommand = useComposerCommandStore((s) => s.togglePin)

  // Shell-style ↑/↓ recall of previously sent messages for this session.
  const history = useInputHistory(sessionId)

  // Inline ghost-text completion. Declared here (rather than beside the other
  // refs above) because it consumes `history` and `slashCommands` — the same
  // per-session history ↑/↓ recalls and the same command list the `/` popover
  // shows, so the ghost can never disagree with either.
  const ghostCommands = useMemo<InlineCommandInfo[]>(
    () => slashCommands.map((c) => ({ name: c.name, description: c.description })),
    [slashCommands]
  )
  const ghost = useComposerGhostText({
    session: props.session,
    history: history.entries,
    commands: ghostCommands,
  })
  const { trigger, hasCommandPrefix, completionTrigger, routeOptionsForTrigger } =
    useComposerTrigger({
      textValue,
      caret,
      popoverDismissed,
      routes,
      resolvedMentionMode,
      slashCommands,
      isLinkToken,
      props,
    })
  const tShellUi = useTranslations("chat.composer.popover")
  const { dismissShell, markShellSubmitted, shellDiagnosticsForOverlay, shell, shellEmptyMessage } =
    useComposerShellMode({ textValue, caret, cwd, trigger, tShellUi })
  const {
    dismissPopover,
    removeCommandSegment,
    handleHighlightElement,
    onPickPopoverItem,
    handleParamFormSubmit,
    handleParamFormCancel,
  } = useComposerPopoverActions({
    tCommands,
    tMemory,
    tSkill,
    textValue,
    textInput,
    textareaRef,
    caret,
    setCaret,
    popoverDismissed,
    setPopoverDismissed,
    setParamForm,
    stageRemoteDoc,
    setCommandErrors,
    addReferencedPath,
    resolvedMentionMode,
    applyPreset,
    memoryFilesAccess,
    isLinkToken,
    setTemplateBinding,
    setPendingLaunchSpec,
    setActiveParamId,
    noteCommandUsed,
    trigger,
    hasCommandPrefix,
    dismissShell,
    props,
  })

  // The route a send is addressed to, read from the text it actually sends
  // (after any leading command ran) with the same parser and targets the
  // pill above was tinted from.
  const routeTargets = routes.targets
  const routeOf = useCallback(
    (outgoing: string): TurnRoute | null =>
      routeTargets.length > 0 ? (parseLeadingRoute(outgoing, routeTargets)?.route ?? null) : null,
    [routeTargets]
  )

  // --- Submit handler ----------------------------------------------------
  const localActionInFlightRef = useRef(false)
  const acceptedPredictionRef = useRef<{ sessionId: string | null; text: string } | null>(null)
  // Text an auto-sending intent staged, held until the input state catches up.
  // This one-shot latch also identifies handoffs that need lossless recovery.
  const pendingAutoSendRef = useRef<{
    text: string
    sessionId: string | null
    onSubmitted?: (sent: boolean) => void
    recoverHandoff?: boolean
    citations?: readonly ContextRef[]
  } | null>(null)
  const submit = useCallback(async (): Promise<boolean> => {
    const text = textInput.value
    const pendingHandoff = pendingAutoSendRef.current
    const recoverHandoff =
      pendingHandoff?.recoverHandoff &&
      pendingHandoff.sessionId === sessionId &&
      pendingHandoff.text === text
    const literalPrediction =
      acceptedPredictionRef.current?.sessionId === sessionId &&
      acceptedPredictionRef.current?.text === text
    if (localActionInFlightRef.current) return false
    // These local actions must remain available during a main-turn approval
    // wait. They never enter the main send lane or consume staged attachments.
    const asideCommand = !literalPrediction && text.trim().match(/^\/(btw|side)(?:\s+([\s\S]*))?$/)
    if (asideCommand) {
      if (localActionInFlightRef.current) return false
      const command = commandMap.get(asideCommand[1])
      if (!command) return false
      localActionInFlightRef.current = true
      const owningDraft = currentDraftRef.current
      try {
        const handled = await props.onCommand(command, asideCommand[2] ?? "")
        if (
          handled &&
          currentDraftRef.current === owningDraft &&
          owningDraft.sessionId === sessionId &&
          textInput.value === text
        )
          textInput.setInput("")
        return handled
      } finally {
        localActionInFlightRef.current = false
      }
    }
    if (props.disabled || outboundBlocked) return false
    if (attachmentPrepareCountRef.current > 0) return false
    // Re-entrancy guard (send protection): reject a second dispatch while one is
    // already in flight — covers the window between the click and the store
    // flipping to "streaming", where a fast Enter could otherwise double-send.
    // Once the turn is live, its own still-pending dispatch no longer blocks a
    // follow-up: that send joins the running turn instead of starting one.
    const liveTurn = props.status === "streaming"
    if (followUpInFlightRef.current) return false
    if (turnInFlightRef.current && !liveTurn) return false

    // Emptiness is decided from the synchronous attachment count (blob→data-url
    // conversion below preserves count) so the guard can be armed BEFORE the
    // first await, leaving no race for a concurrent submit to slip through.
    const empty = text.trim().length === 0 && attachments.files.length === 0
    if (empty && props.canResume && props.onResume) {
      turnInFlightRef.current = true
      setTurnInFlight(true)
      try {
        await props.onResume()
        return true
      } catch (error) {
        console.warn("chat continuation failed", error)
        return false
      } finally {
        turnInFlightRef.current = false
        setTurnInFlight(false)
      }
    }
    if (empty) return false

    // Validate before arming send protection: this return never enters the
    // dispatch's try/finally, and the user must be able to fill a chip and retry.
    const missingParams = unfilledRequiredParams(paramIds, effectiveBinding, paramDeclarations)
    if (!literalPrediction && missingParams.length > 0) {
      toast.error(tTemplateParams("unfilled", { count: missingParams.length }))
      const first = paramTokens.find((seg) => seg.paramId === missingParams[0])
      const ta = textareaRef.current
      if (first && ta) {
        ta.focus()
        ta.setSelectionRange(first.start, first.start)
        setCaret(first.start)
        setActiveParamId(first.paramId)
      }
      return false
    }

    // Best-of-N owns the whole prompt, including subsequent lines. Letting the
    // general command batch split it would also send the trailing prose as a
    // second ordinary parent turn.
    const bestOfNCommand = !literalPrediction && text.trim().match(/^\/best-of-n(?:\s+([\s\S]*))?$/)
    if (bestOfNCommand) {
      if (localActionInFlightRef.current) return false
      const command = commandMap.get("best-of-n")
      if (!command) return false
      localActionInFlightRef.current = true
      try {
        const args = expandFoldedLinks(
          expandPastes(bestOfNCommand[1] ?? "", pastedBlocks),
          foldedLinks
        )
        const handled = await props.onCommand(command, args, {
          files: attachments.files.flatMap((file) =>
            file.id && file.url
              ? [{ id: file.id, url: file.url, mediaType: file.mediaType ?? "" }]
              : []
          ),
          consume: () => undefined,
        })
        if (handled && textInput.value === text) {
          textInput.clear()
          setPastedBlocks({})
          setFoldedLinks({})
        }
        return handled
      } finally {
        localActionInFlightRef.current = false
      }
    }
    // Inside a mixed batch the general pipeline would hand `/best-of-n` only
    // its own line and then send the remaining prose as an ordinary parent
    // turn. Refuse the batch before any command in it runs.
    if (
      !literalPrediction &&
      segments.some((segment) => segment.kind === "command" && segment.name === "best-of-n")
    ) {
      toast.error(tBestOfN("mixedBatch"))
      return false
    }

    const lane = liveTurn ? "followUp" : "turn"
    if (lane === "followUp") {
      followUpInFlightRef.current = true
      setFollowUpInFlight(true)
    } else {
      turnInFlightRef.current = true
      setTurnInFlight(true)
    }

    // Tactile confirmation for the most frequent chat action. The wrapper
    // no-ops off the Capacitor shell, so this is safe unconditionally.
    if (nativeMobile) void impact("light")

    // Post-send focus policy: with a hardware keyboard the textarea keeps focus
    // for rapid follow-ups; with a soft keyboard it blurs so the keyboard folds
    // away and the streaming reply isn't hidden behind it (ChatGPT-app
    // behavior). `hideKeyboard` is the native plugin; a browser folds its
    // keyboard on the blur alone.
    const settleFocusAfterSend = () => {
      if (softKeyboard) {
        textareaRef.current?.blur()
        if (nativeMobile) void hideKeyboard()
      } else {
        textareaRef.current?.focus()
      }
    }

    // Snapshot the attachments BEFORE the optimistic clear so the actual send
    // still has them (and so a failed send can restore the composer). The chip
    // order is the user's (drag-reordered) order, and the model must receive
    // them in exactly that order — see `buildAttachmentBlocks`.
    const snapshotFiles = applyOrder([...attachments.files], staged.order)
    const platformSubmission = props.session?.platformBinding
      ? { replyTo: selectComposerReplyTo(useChatStore.getState(), sessionId) }
      : undefined
    // `id` is RETAINED here (unlike before): it is the key `buildSendContent`
    // uses to look each file up in the staging-time extraction cache.
    // Provenance survives even when this send captured an extraction that was
    // still pending. It belongs to the submitted File, independently of parsing.
    const snapshotAttachmentInputs = snapshotFiles.map((item) => {
      const remoteDocument = parseRemoteDocumentProvenance(
        staged.byId.get(item.id)?.remoteDocument ?? stagedRemoteDocument(item.sourceFile)
      )
      return { ...item, ...(remoteDocument ? { remoteDocument } : {}) }
    })
    // Snapshot the folded-paste bodies too: the optimistic clear wipes them, so
    // the send (and a restore-on-failure) reads from this stable map.
    const pasteMap = pastedBlocks
    // Same for the folded links: the text carries short labels, and this is the
    // map that turns them back into the URLs the user actually wrote.
    const linkMap = foldedLinks
    const restoreText = (text: string) => expandFoldedLinks(expandPastes(text, pasteMap), linkMap)

    // ── Optimistic clear ───────────────────────────────────────────────────
    // Natural chat UX: the box empties the instant you hit send — not after the
    // whole turn resolves (`onSubmit` only settles once the send pipeline has
    // run, which is why the text used to linger for the entire response). We
    // snapshot first and restore on a rejected/failed send. `clearAfterSend`
    // off keeps everything in place (the user resends/tweaks), so skip then.
    let cleared = false
    const clearInputOptimistically = () => {
      if (!clearAfterSendEnabled || cleared) return
      // Optimistically clear ONLY the text + folded-paste chips. Attachments are
      // deliberately held back until the send is confirmed (`finalizeSend`):
      // `attachments.clear()` revokes every staged blob URL, so clearing here
      // would irrecoverably destroy the files on any rejected / cancelled /
      // thrown send (e.g. declining the oversize dialog).
      textInput.clear()
      setPastedBlocks({})
      setFoldedLinks({})
      cleared = true
    }
    // Run only once a send is CONFIRMED successful: now it is safe to drop (and
    // revoke) the staged attachments, the reminder chips, and the saved draft.
    const finalizeSend = () => {
      // Remember what this template's parameters were set to, so the next
      // insert pre-fills them — in practice most values repeat. Fire-and-forget
      // and only after a CONFIRMED send: losing a usage counter must never
      // surface as a failure on a turn that actually went out.
      // Repository templates deliberately remember nothing. There is no row to
      // write to, and a checkout's template is not the sort of thing that
      // should accumulate one person's last answers — what it wants pre-filled
      // it declares as a default, in the file, where the team can see it.
      const usedTemplateId = effectiveBinding?.templateId
      if (usedTemplateId && !usedTemplateId.startsWith(REPO_TEMPLATE_ID_PREFIX)) {
        void recordChatTemplateUse(usedTemplateId, effectiveBinding.params).catch(() => undefined)
      }
      const currentDraft = currentDraftRef.current
      if (currentDraft.sessionId !== sessionId) return
      if (clearAfterSendEnabled) {
        for (const file of snapshotFiles) attachments.remove(file.id)
        setRestoredAttachments([])
        const hasNewFiles = currentDraft.files.some(
          (file) => !snapshotFiles.some((submitted) => submitted.id === file.id)
        )
        if (sessionId && !currentDraft.text && !hasNewFiles) {
          void clearChatDraft(sessionId, { hostAlreadyCleared: true })
        }
      }
      settleFocusAfterSend()
    }
    const restoreInputAfterFailure = () => {
      if (!cleared) return
      const currentDraft = currentDraftRef.current
      // A failed request cannot replace follow-up typing or another session's
      // draft. Restore only while its optimistic empty input is still current.
      if (currentDraft.sessionId !== sessionId || textInput.value) {
        if (recoverHandoff && sessionId) {
          useComposerIntentStore.getState().stage(sessionId, {
            candidateId: crypto.randomUUID(),
            prompt: restoreText(text),
            mode: "append",
            waitForEmpty: true,
            citations: pendingHandoff?.citations,
          })
          // These sources belong to the deferred text, not newer follow-up
          // typing. The intent consumer restores them with that text.
          for (const ref of pendingHandoff?.citations ?? [])
            useChatStore.getState().removeCitedRef(ref.id, sessionId)
        }
        return
      }
      textInput.setInput(text)
      setPastedBlocks(pasteMap)
      // The text comes back holding SHORT labels, so the label→URL map has to
      // come back with it. Without this a failed send left every folded link as
      // literal prose, and the retry shipped `··owner/repo` to the model.
      setFoldedLinks(linkMap)
      cleared = false
      // Attachments were never cleared, so there is nothing to restore — the
      // staged files are still live in the controller.
    }
    // Substitute on the CHIP RANGES, before the command pipeline: code stays
    // code because the chip pass already excluded it, and a `/command`'s
    // arguments stay untouched for `applyTemplate`'s own `$1` pass.
    const paramRendered = renderParamTokens(text, paramTokens, effectiveBinding)
    // Captured from the text as it reads RIGHT HERE — before substitution and
    // before the command pipeline rewrites anything — because that is the only
    // form in which the parameters are still visible as parameters. What goes
    // out has the values baked in and nothing marking which words they were.
    const templateRun = templateRunFromBinding(effectiveBinding, text)

    clearInputOptimistically()

    try {
      // Let any in-flight staging extraction land first, so the send reuses it
      // instead of re-parsing the same document. Resolves synchronously when
      // nothing is pending, which is the overwhelmingly common case.
      await staged.whenSettled()
      const precomputed = staged.precomputed
      const filesToSend: SubmittedFile[] = await Promise.all(
        snapshotAttachmentInputs.map(async (item) => {
          // A file whose extraction is cached never needs its bytes again —
          // skip the blob→data-URL round trip entirely.
          if (!props.session?.platformBinding) {
            if (precomputed.has(item.id)) return item
            // A video is sampled from its blob URL at staging time and only
            // ever sent as those samples: reading a 500 MB source into a data
            // URL here would buy nothing and could exhaust the webview.
            if (isVideoDescriptor({ name: item.filename ?? "", mediaType: item.mediaType ?? "" })) {
              return item
            }
          }
          if (item.url?.startsWith("blob:")) {
            const dataUrl = await blobUrlToDataUrl(item.url)
            return { ...item, url: dataUrl ?? item.url }
          }
          return item
        })
      )

      // Platform recall cannot depend on folded maps cleared during submission.
      // Keep template tokens editable while retaining full paste/link bodies.
      history.record(props.session?.platformBinding ? restoreText(text) : text)

      // A model prediction is literal text: direct acceptance must never execute
      // a generated slash command, shell line or memory action.
      if (literalPrediction) {
        const ok = await props.onSubmit(text, filesToSend, precomputed)
        if (ok === false) restoreInputAfterFailure()
        else finalizeSend()
        return ok !== false
      }

      if (props.session?.platformBinding) {
        const ok = await props.onSubmit(
          restoreText(paramRendered.text),
          filesToSend,
          precomputed,
          templateRun,
          platformSubmission
        )
        if (ok === false) restoreInputAfterFailure()
        else finalizeSend()
        return ok !== false
      }

      // ── `!shell` / `#memory` first-line modes ────────────────────────────
      // Decided from the ORIGINAL input, never from the post-command outgoing
      // text: `/clear\n!ls` must NOT shell out just because stripping `/clear`
      // left `!ls` behind. And the mode claims only its FIRST LINE — exactly
      // what `detectTrigger` and the popover have always previewed — so lines
      // 2+ continue through the normal command/prose pipeline below.
      // The mode is decided from the ORIGINAL first character, but sliced out
      // of the substituted text. Safe together: whenever `text[0]` is `!` or
      // `#` it is not the start of a `{{token}}`, so substitution cannot have
      // moved index 0.
      const modeChar = text[0]
      const submittedText = paramRendered.text
      let pipelineText = submittedText
      let modeRan = false
      if (modeChar === "!" || modeChar === "#") {
        const newline = submittedText.indexOf("\n")
        const modeLine = (newline === -1 ? submittedText : submittedText.slice(0, newline))
          .slice(1)
          .trim()
        pipelineText = newline === -1 ? "" : submittedText.slice(newline + 1)
        modeRan = true
        if (modeChar === "!") {
          await props.onSubmitShell(modeLine)
        } else if (!modeLine) {
          toast.error(tMemory("needsLine"))
        } else {
          // Bare `#note` + Enter repeats the last destination instead of
          // demanding a popover pick every single time. The availability guard
          // matters here as much as on the pick path: a file target chosen in a
          // local conversation can be replayed in the browser, or in one whose
          // turns run on a remote Host, where this window cannot reach the
          // instruction files they load.
          const remembered = parseMemoryTargetKey(
            useComposerCommandStore.getState().lastMemoryTargetKey
          )
          if (!remembered) toast.info(tMemory("pickScope"))
          else if (!isMemoryTargetAvailable(remembered, memoryFilesAccess)) {
            toast.error(tMemory(memoryFilesUnavailableKey(memoryFilesAccess) ?? "desktopOnly"))
          } else await props.onSubmitMemory(remembered, modeLine)
        }
      }

      // Multi-command: `segments` is the live memo over the whole input; when a
      // first-line mode consumed line 1 we re-parse just the remainder so the
      // consumed line can't also be sent as prose. When the message contains one
      // or more line-start `/commands`, run them in order: action handlers
      // execute via `props.onCommand` (context-rich), template commands expand
      // inline, and the leftover prose is what gets sent.
      // `segments` is memoised over the UNSUBSTITUTED text, so it is stale the
      // moment a parameter was replaced — re-parse then too, not just after a
      // first-line mode consumed a line.
      const pipelineSegments =
        modeRan || paramRendered.changed
          ? parseSegments(pipelineText, (name) => commandMap.has(name))
          : segments
      const hasCommand = pipelineSegments.some((s) => s.kind === "command")
      if (hasCommand) {
        // Remember every runnable command sent (covers typed-not-picked ones).
        // Skip disabled/coming-soon commands so they can't pollute Recent — the
        // pick path already guards them before noteCommandUsed.
        for (const seg of pipelineSegments) {
          if (seg.kind === "command" && !commandMap.get(seg.name)?.disabled) {
            noteCommandUsed(seg.name)
          }
        }
        // Files an action command took for itself (`/video`'s start frame). A
        // later command in the same batch sees only what is still staged.
        const consumed = new Set<string>()
        const commandFiles = snapshotFiles.flatMap((file) =>
          file.id && file.url
            ? [
                {
                  id: file.id,
                  url: file.url,
                  mediaType: file.mediaType ?? "",
                  ...(file.filename ? { filename: file.filename } : {}),
                },
              ]
            : []
        )
        const stagedForCommand = (): SlashStagedFiles => ({
          files: commandFiles.filter((file) => !consumed.has(file.id)),
          consume: (ids) => {
            for (const id of ids) consumed.add(id)
          },
        })
        const { outgoingText, overrides, ranAction, errors, cancelled } = await runSegments(
          pipelineSegments,
          {
            commandMap,
            runAction: async (command, args) => {
              return props.onCommand(command, args, stagedForCommand())
            },
            applyTemplate,
          }
        )
        const remainingFiles = filesToSend.filter((file) => !file.id || !consumed.has(file.id))
        if (cancelled) {
          restoreInputAfterFailure()
          return false
        }
        useChatStore.getState().setPendingCommandOverrides(overrides)
        // A failed command in a batch used to vanish: `runSegments` isolates the
        // throw into `errors` precisely so the rest of the batch still runs, but
        // nothing read the array. Report it once, aggregated — N toasts for a
        // three-command chain would be worse than one.
        setCommandErrors(errors)
        if (errors.length > 0) {
          toast.error(
            tCommands("batchFailed", {
              count: errors.length,
              names: errors.map((e) => `/${e.name}`).join(", "),
            })
          )
        }
        // Only send a turn when there is prose or attachments. An action-only
        // batch (e.g. `/clear`) mutates client state and sends nothing — mirroring
        // today's "action command clears the input, no turn" behavior.
        let sent = true
        if (outgoingText.length > 0 || remainingFiles.length > 0) {
          const outgoing = restoreText(outgoingText)
          sent = await props.onSubmit(
            outgoing,
            remainingFiles,
            precomputed,
            templateRun,
            undefined,
            routeOf(outgoing)
          )
        } else if (!ranAction && !modeRan) {
          // Defensive: no prose, no files, no action, no first-line mode —
          // nothing was dispatched, so restore the optimistically-cleared input
          // rather than lose it.
          restoreInputAfterFailure()
          return false
        }
        if (sent) finalizeSend()
        else {
          restoreInputAfterFailure()
          if (nativeMobile) void notify("error")
        }
        return sent
      }

      // A first-line mode that consumed the entire input has already done its
      // work — don't also send an empty turn.
      if (modeRan && pipelineText.trim().length === 0 && filesToSend.length === 0) {
        finalizeSend()
        return true
      }

      const outgoing = restoreText(pipelineText)
      const sent = await props.onSubmit(
        outgoing,
        filesToSend,
        precomputed,
        templateRun,
        undefined,
        routeOf(outgoing)
      )
      if (sent) finalizeSend()
      else {
        restoreInputAfterFailure()
        if (nativeMobile) void notify("error")
      }
      return sent
    } catch (err) {
      // A thrown send must not leave the user's text lost — restore the
      // optimistically-cleared input and surface the failure (don't rethrow
      // into the fire-and-forget click handler).
      restoreInputAfterFailure()
      if (nativeMobile) void notify("error")
      loggers.chat.error("composer send failed", err)
      return false
    } finally {
      // Always release the guard. On a successful send the store has already
      // flipped to "streaming" (so the button stays in stop state); on a
      // rejected/aborted send it returns to the idle send state so the user can
      // retry.
      if (lane === "followUp") {
        followUpInFlightRef.current = false
        setFollowUpInFlight(false)
      } else {
        turnInFlightRef.current = false
        setTurnInFlight(false)
      }
    }
  }, [
    textInput,
    sessionId,
    props,
    outboundBlocked,
    attachmentPrepareCountRef,
    attachments,
    paramIds,
    effectiveBinding,
    paramDeclarations,
    segments,
    nativeMobile,
    staged,
    pastedBlocks,
    foldedLinks,
    paramTokens,
    commandMap,
    tTemplateParams,
    setActiveParamId,
    setPastedBlocks,
    setFoldedLinks,
    tBestOfN,
    softKeyboard,
    clearAfterSendEnabled,
    history,
    routeOf,
    tMemory,
    memoryFilesAccess,
    noteCommandUsed,
    tCommands,
  ])

  // Accept the inline ghost-text suggestion: write the completed value back
  // into the textarea and park the caret at the end. Shared by the keyboard
  // (Tab) path below and the suggestion card's accept button, since touch
  // devices have no Tab key. Returns false when there was nothing to
  // accept so the Tab keystroke can fall through to its default behavior.
  const acceptGhost = useCallback((): boolean => {
    const next = ghost.accept()
    if (next === null) return false
    textInput.setInput(next)
    setCaret(next.length)
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (ta) {
        ta.setSelectionRange(next.length, next.length)
        ta.focus()
      }
    })
    return true
  }, [ghost, textInput])

  // Predictions belong to this input's session and never replace a user's work.
  // Wait for draft hydration so a late restore cannot overwrite an accepted prediction.
  const predictionEligible =
    !!props.session &&
    props.session.kind !== "subagent" &&
    !props.session.platformBinding &&
    !props.disabled &&
    !outboundBlocked &&
    props.status !== "streaming" &&
    !turnInFlight &&
    !followUpInFlight &&
    !isComposing &&
    textValue === "" &&
    attachments.files.length === 0 &&
    restoredAttachments.length === 0 &&
    (!persistDrafts || draftHydratedFor === props.session.id)
  const prediction = useFollowUpSuggestions(props.session, { enabled: predictionEligible })
  const acceptPrediction = useCallback(
    (text: string, sendImmediately = false): boolean => {
      if (
        !predictionEligible ||
        turnInFlightRef.current ||
        followUpInFlightRef.current ||
        textInput.value !== "" ||
        attachments.files.length > 0 ||
        attachmentPrepareCountRef.current > 0 ||
        isComposing
      )
        return false
      acceptedPredictionRef.current = { sessionId, text }
      textInput.setInput(text)
      setCaret(text.length)
      if (sendImmediately) {
        // Reuse this bound composer's validation, model routing and send protection.
        void submit()
      } else {
        const input = textareaRef.current
        requestAnimationFrame(() => {
          // A session change remounts/resets the input; never focus a new owner.
          if (input && input === textareaRef.current && input.value === text) {
            input.setSelectionRange(text.length, text.length)
            input.focus()
          }
        })
      }
      prediction.dismiss()
      return true
    },
    [
      predictionEligible,
      sessionId,
      textInput,
      attachments.files.length,
      attachmentPrepareCountRef,
      isComposing,
      prediction,
      submit,
    ]
  )

  // --- Textarea key handling --------------------------------------------
  /**
   * Move the caret to the parameter after (or before) the caret and open it.
   * Returns false when there is nowhere to go, so the caller can let the key
   * do its normal job.
   */
  const stepToParam = useCallback(
    (direction: 1 | -1): boolean => {
      const ta = textareaRef.current
      if (!ta || paramTokens.length === 0) return false
      const caretAt = ta.selectionStart ?? 0
      const ordered = direction === 1 ? paramTokens : [...paramTokens].reverse()
      const next =
        ordered.find((seg) => (direction === 1 ? seg.start > caretAt : seg.end < caretAt)) ??
        ordered[0]
      if (!next) return false
      ta.setSelectionRange(next.start, next.start)
      setCaret(next.start)
      setActiveParamId(next.paramId)
      return true
    },
    [paramTokens, setActiveParamId]
  )

  /**
   * Remove the whole `/command`, `@mention`, `{{parameter}}` or folded-link pill
   * the collapsed caret is hugging, and report whether it did. Only while no
   * completion popover is open, so mid-typing edits stay character by character.
   */
  const deletePillAtCaret = useCallback(
    (ta: HTMLTextAreaElement, direction: "backward" | "forward"): boolean => {
      if (completionTrigger || ta.selectionStart !== ta.selectionEnd) return false
      const range = pillDeleteRange(textInput.value, ta.selectionStart, overlaySegments, direction)
      if (!range) return false
      const cur = textInput.value
      textInput.setInput(cur.slice(0, range.start) + cur.slice(range.end))
      setCaret(range.start)
      requestAnimationFrame(() => {
        const ta2 = textareaRef.current
        if (ta2) {
          ta2.setSelectionRange(range.start, range.start)
          ta2.focus()
        }
      })
      return true
    },
    [completionTrigger, textInput, overlaySegments]
  )

  // The same atomic delete for keyboards that never send a usable keydown.
  // Android's soft keyboards (Gboard, the EMUI keyboard, every IME) report
  // Backspace as `key: "Unidentified"`, so on a phone the keydown branch never
  // fired and one Backspace turned the `/goal` pill into the plain text
  // `/goa`, which then went out as an ordinary message. What they do send is
  // a cancelable `beforeinput` naming the edit, so the pill is caught there.
  // Listened for on the document because the textarea mounts and remounts
  // with the composer's mode, and a capture listener outlives all of that.
  // A delete that is part of an IME composition is not cancelable and is left
  // to the keyboard.
  const deletePillFromInputEvent = useStableCallback((event: InputEvent) => {
    const ta = textareaRef.current
    if (!ta || event.target !== ta || !event.cancelable || event.isComposing) return
    const direction =
      event.inputType === "deleteContentBackward"
        ? "backward"
        : event.inputType === "deleteContentForward"
          ? "forward"
          : null
    if (!direction) return
    if (deletePillAtCaret(ta, direction)) event.preventDefault()
  })
  useEffect(() => {
    document.addEventListener("beforeinput", deletePillFromInputEvent, true)
    return () => document.removeEventListener("beforeinput", deletePillFromInputEvent, true)
  }, [deletePillFromInputEvent])

  // Local handles so the key handler depends on the specific props it reads,
  // not the whole `props` object (react-hooks/exhaustive-deps).
  const turnStatus = props.status
  const onStopTurn = props.onStop
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      // While an IME composes (Chinese, Japanese, Korean), every key belongs to
      // the candidate window: Enter picks a candidate, Esc cancels it, arrows
      // move through it. Nothing below may claim one. WebKit (Safari, the Tauri
      // macOS webview) reports the confirming key after compositionend, so the
      // shared check also reads keyCode 229.
      if (isComposing || isImeComposing(e)) return
      // `?` opens the shortcut cheatsheet — but ONLY on a completely empty
      // input, so it never swallows a question mark the user is typing.
      if (e.key === "?" && textInput.value.length === 0) {
        e.preventDefault()
        props.onOpenCheatsheet()
        return
      }
      // Shift+Tab cycles permission mode regardless of popover state.
      if (e.key === "Tab" && e.shiftKey) {
        e.preventDefault()
        const next = nextPermissionMode(permissionMode)
        setPermissionMode(next, props.session?.id ?? null)
        return
      }
      if (
        predictionEligible &&
        prediction.suggestions[0] &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey
      ) {
        if (e.key === "Tab" || e.key === "ArrowRight") {
          if (acceptPrediction(prediction.suggestions[0])) e.preventDefault()
          return
        }
        if (e.key === "Escape") {
          e.preventDefault()
          prediction.dismiss()
          return
        }
      }
      // Tab on an empty box accepts the typewriter hint like a ghost
      // completion — the whole hint lands in the input, caret at the end.
      if (
        e.key === "Tab" &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        textInput.value === "" &&
        activeHintRef.current !== ""
      ) {
        e.preventDefault()
        const hint = activeHintRef.current
        textInput.setInput(hint)
        setCaret(hint.length)
        // A controlled textarea restores the pre-edit caret (position 0)
        // once React commits the new value — park it at the end instead.
        const el = e.currentTarget
        requestAnimationFrame(() => {
          if (document.activeElement === el) {
            el.selectionStart = el.selectionEnd = el.value.length
          }
        })
        return
      }
      if (completionTrigger) {
        if (e.key === "Escape") {
          e.preventDefault()
          dismissPopover()
          return
        }
        if (e.key === "ArrowDown") {
          e.preventDefault()
          popoverRef.current?.navigate(1)
          return
        }
        if (e.key === "ArrowUp") {
          e.preventDefault()
          popoverRef.current?.navigate(-1)
          return
        }
        // Tab selects the highlighted item — in `!` mode as well, now that it
        // has a list to confirm.
        //
        // `!` is the only kind whose panel can legitimately be EMPTY (no Host
        // to ask, or nothing matched), and there Tab has to fall through to the
        // textarea as it always did. Every other kind has a list by
        // construction, so Tab stays unconditionally theirs — letting a
        // mid-search empty frame leak a literal tab into the message would be a
        // regression in the pickers this feature never touched.
        if (e.key === "Tab" && !e.shiftKey) {
          const confirmed = popoverRef.current?.confirm()
          if (confirmed || completionTrigger.kind !== "bash") {
            e.preventDefault()
            return
          }
        }
        if (e.key === "Enter" && !e.shiftKey) {
          // Bash mode: Enter runs the line, whatever the panel is showing.
          // Diagnostics are advisory — an underline must never be the reason a
          // command the checker was wrong about cannot be run.
          if (completionTrigger.kind === "bash") {
            e.preventDefault()
            markShellSubmitted()
            void submit()
            return
          }
          // ⌥↵ takes a row its second way when it has one — a prompt the
          // user sent before goes back into the draft as text instead of
          // becoming a chip. Rows without one are picked as usual.
          if (popoverRef.current?.confirm({ alternate: e.altKey })) {
            e.preventDefault()
            return
          }
        }
      }
      // Atomic pill delete: a Backspace/Delete next to an already-inserted
      // `/command` or `@mention` removes the WHOLE token in one keystroke, so a
      // picked chip deletes as a unit instead of nibbling `/rese`. Only a plain
      // key (let ⌥/⌘ word/line deletes through). A soft keyboard reports these
      // keys as "Unidentified"; `beforeinput` below covers it.
      if (
        (e.key === "Backspace" || e.key === "Delete") &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        deletePillAtCaret(e.currentTarget, e.key === "Backspace" ? "backward" : "forward")
      ) {
        e.preventDefault()
        return
      }
      // Inline ghost-text acceptance (only when no `/@!#` popover is open).
      // Tab walks the `{{parameter}}` chips. Only claimed when the text
      // actually HAS parameters — otherwise Tab keeps its normal job of moving
      // focus out of the composer, which is the only way a keyboard user
      // reaches the toolbar.
      if (
        e.key === "Tab" &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        // No open panel — with one showing, Tab belongs to its list.
        !completionTrigger &&
        !ghost.ghost &&
        paramTokens.length > 0
      ) {
        if (stepToParam(1)) {
          e.preventDefault()
          return
        }
      }
      // Escape closes the parameter editor before anything else claims it.
      if (e.key === "Escape" && activeParamId) {
        e.preventDefault()
        setActiveParamId(null)
        return
      }
      // Alt+\ asks the agent tier for a continuation. Deliberately OUTSIDE the
      // `ghost.ghost` guard below: its whole purpose is to produce a suggestion
      // when the free tiers had nothing to offer, so requiring one first would
      // make the key unreachable exactly when it is wanted. `requestManual` is
      // a no-op when the tier is unavailable, so the keystroke still falls
      // through on a shell that cannot carry a turn.
      // `turnStatus === "streaming"` mirrors the ghost's own suppression: while
      // a turn runs, every `feed` resets the engine, so a manual answer would
      // appear and be wiped on the next keystroke.
      if (
        !completionTrigger &&
        e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        // `e.code`, not `e.key`: on macOS Option+\ produces `«`, and an IME may
        // swallow or translate the key — the physical key is the stable signal.
        e.code === "Backslash" &&
        ghost.manualAvailable &&
        turnStatus !== "streaming"
      ) {
        e.preventDefault()
        ghost.requestManual()
        return
      }
      // Tab accepts the dim continuation; Esc dismisses it; Alt+]/Alt+[ walk
      // the ranked alternatives (the same bindings VS Code uses for cycling
      // inline suggestions). All fall through to existing behavior when there
      // is no ghost to act on — except Esc, which also cancels a thinking or
      // failed round (the card is open and the user wants it gone).
      if (!completionTrigger && (ghost.ghost || ghost.querying || ghost.completionError)) {
        if (e.key === "Tab" && !e.shiftKey && ghost.ghost) {
          if (acceptGhost()) {
            e.preventDefault()
            return
          }
        }
        // `e.code` (physical key), not `e.key`: on macOS Option+] produces `‘`
        // and an IME may emit `】`, so the character never matches. `!ctrlKey`
        // keeps AltGr (Ctrl+Alt on Windows/Linux layouts) typing a real bracket.
        if (e.altKey && !e.ctrlKey && !e.metaKey) {
          const forward = e.code === "BracketRight" || e.key === "]"
          const backward = e.code === "BracketLeft" || e.key === "["
          // Only meaningful with something to cycle to; otherwise let the
          // keystroke through so it still types a bracket.
          if ((forward || backward) && ghost.candidates.length > 1) {
            e.preventDefault()
            if (forward) ghost.cycleNext()
            else ghost.cyclePrev()
            return
          }
        }
        if (e.key === "Escape") {
          e.preventDefault()
          ghost.dismiss()
          return
        }
      }
      // Esc interrupts the running turn — the keystroke behind the run-status
      // bar's "Esc to interrupt" affordance — once no popover/ghost claimed it.
      if (e.key === "Escape" && turnStatus === "streaming") {
        e.preventDefault()
        void onStopTurn()
        return
      }
      // ↑/↓ recall of previously sent messages (only when no popover is open).
      // ↑ engages from the very start of the input; while
      // navigating, both arrows walk the history and ↓ past the newest restores
      // the stashed draft.
      if (inputHistoryRecall && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        const ta = e.currentTarget
        const caretAtStart = ta.selectionStart === 0 && ta.selectionEnd === 0
        const next = history.recall(e.key === "ArrowUp" ? "up" : "down", {
          value: textInput.value,
          caretAtStart,
        })
        if (next !== null) {
          e.preventDefault()
          textInput.setInput(next)
          setCaret(next.length)
          requestAnimationFrame(() => {
            const t = textareaRef.current
            if (t) {
              t.setSelectionRange(next.length, next.length)
              t.focus()
            }
          })
          return
        }
      }
      // Submit on Enter. Default: plain Enter sends, Shift+Enter is a newline.
      // When `sendOnEnter` is off: Enter inserts a newline and ⌘/Ctrl+Enter
      // sends instead (the non-submit cases fall through to the textarea).
      if (e.key === "Enter") {
        const wantsSubmit = sendOnEnter ? !e.shiftKey : e.metaKey || e.ctrlKey
        if (wantsSubmit) {
          e.preventDefault()
          void submit()
        }
      }
    },
    [
      isComposing,
      textInput,
      predictionEligible,
      prediction,
      completionTrigger,
      deletePillAtCaret,
      ghost,
      paramTokens,
      activeParamId,
      turnStatus,
      inputHistoryRecall,
      props,
      permissionMode,
      setPermissionMode,
      acceptPrediction,
      dismissPopover,
      markShellSubmitted,
      submit,
      stepToParam,
      setActiveParamId,
      acceptGhost,
      onStopTurn,
      history,
      sendOnEnter,
    ]
  )

  const onChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      acceptedPredictionRef.current = null
      textInput.setInput(e.target.value)
      setCaret(e.target.selectionStart ?? e.target.value.length)
      // A team room's members wait for the human to finish a sentence before
      // an auto round (ADR-0177 batch 3). The runner polls this at round
      // boundaries, so a keystroke here is the whole signal.
      if (props.session?.kind === "team" && props.session.teamId) {
        noteComposerTyping(props.session.id)
      }
      // Re-mirror the scroll onto the chip + ghost overlays. Shrinking the text
      // (or clearing it) can reset the textarea's scrollTop WITHOUT firing a
      // scroll event, which would otherwise strand the overlays at a stale
      // translateY from the last scroll.
      const offset = `translateY(${-e.target.scrollTop}px)`
      if (chipOverlayRef.current) chipOverlayRef.current.style.transform = offset
      if (ghostOverlayRef.current) ghostOverlayRef.current.style.transform = offset
      // Typing exits history-recall mode so the next ↑ starts from the newest.
      history.noteEdit()
      // Last submit's per-command failures describe text the user has now
      // changed — drop them rather than leave stale red pills on the queue bar.
      setCommandErrors((current) => (current.length > 0 ? [] : current))
      // Fold any URL the caret has moved past. Never the one being typed — the
      // caret rule inside `foldLinks` sees to that — and never mid-composition,
      // where rewriting the value would drop the IME's in-flight text.
      if (!isComposing) {
        linkFolding.fold(e.target.value, e.target.selectionStart ?? e.target.value.length)
      }
    },
    [textInput, history, isComposing, linkFolding, props.session]
  )

  // Leaving the box settles every remaining URL, including one just pasted with
  // the caret still sitting at its end.
  const onBlur = useCallback(() => {
    linkFolding.fold(textInput.value, -1)
  }, [linkFolding, textInput])

  const onSelect = useCallback(
    (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
      const ta = e.currentTarget
      const caretAt = ta.selectionStart ?? ta.value.length
      setCaret(caretAt)
      // Close the parameter editor once the caret leaves the token it belongs
      // to — including when the user breaks the token, which stops it being a
      // parameter at all. It never OPENS from here: `onSelect` also fires for
      // arrow keys, and a panel that appeared every time the caret drifted
      // through `{{module}}` would flash at someone reading back their own
      // sentence.
      if (activeParamId && paramTokenAt(caretAt)?.paramId !== activeParamId) {
        setActiveParamId(null)
      }
    },
    [activeParamId, paramTokenAt, setActiveParamId]
  )

  /**
   * Open the editor for the parameter the user just clicked in.
   *
   * Pointer release, not `onSelect`: clicking a chip is a deliberate "edit
   * this", where arrowing past one is not.
   */
  const onTextareaMouseUp = useCallback(
    (e: React.MouseEvent<HTMLTextAreaElement>) => {
      const ta = e.currentTarget
      const caretAt = ta.selectionStart ?? 0
      if (caretAt !== (ta.selectionEnd ?? caretAt)) return // a drag-selection, not a click
      // ⌘/Ctrl-click follows a link, the way it does everywhere else. The
      // overlay that paints the label captures no pointer events, so the click
      // lands in the textarea and the caret tells us which token it hit.
      if (e.metaKey || e.ctrlKey) {
        const link = linkFolding.spans.find((span) => caretAt >= span.start && caretAt <= span.end)
        if (link) {
          e.preventDefault()
          // The embedded browser pane takes it when one is open; otherwise the
          // OS browser does, which is what every other link in the app does.
          if (!requestBrowserUrl(link.url)) void openExternal(link.url)
          return
        }
      }
      setActiveParamId(paramTokenAt(caretAt)?.paramId ?? null)
    },
    [setActiveParamId, paramTokenAt, linkFolding.spans]
  )

  // ── Per-session draft persistence (Phase 3.2) ─────────────────────────
  useCameraRecovery(
    sessionId && (!persistDrafts || draftHydratedFor === sessionId)
      ? { kind: "chat", id: sessionId }
      : null,
    async (result, isCurrent) => {
      const files = await attachmentToFiles(
        result.kind === "photo"
          ? { kind: "photo", ...result.photo, mime: `image/${result.photo.format}` }
          : {
              kind: "photos",
              items: result.photos.map((photo) => ({
                uri: photo.uri,
                mime: `image/${photo.format}`,
              })),
            }
      )
      if (!isCurrent() || files.length === 0) return false
      const accepted = await acceptFiles(files, { isCurrent })
      return isCurrent() && accepted.length > 0
    }
  )
  // Subscribed (not just read at send) so the save effect below re-fires when
  // a chip is staged or removed — the chips are part of the draft now.
  const draftContextSelections = useComposerContextSelections(sessionId)
  const pendingComposerIntent = useComposerIntentStore((state) =>
    sessionId ? state.pendingBySession[sessionId] : undefined
  )
  const consumeComposerIntent = useComposerIntentStore((state) => state.consume)
  // See `restoredAttachments` above: only the ones we could not bring back.
  const tDraft = useTranslations("chat.composer.draftRestore")
  // The next-intl translator isn't a stable reference, so we read it through a
  // ref instead of listing it as an effect dependency — depending on it would
  // re-run the hydration effect every render and loop on its setState calls.
  const tDraftRef = useRef(tDraft)
  useEffect(() => {
    tDraftRef.current = tDraft
  }, [tDraft])

  // Tracks the session we last reset the box for. A ref (not state) so it can't
  // race the async draft load below.
  const clearedForSessionRef = useRef<string | null>(null)
  useEffect(() => {
    if (!persistDrafts) return
    if (!sessionId) return
    if (draftHydratedFor === sessionId) return
    // Reset the input SYNCHRONOUSLY, once per session change. The Composer is
    // not remounted per session (no `key`), so without this the previous
    // session's text + staged attachments bleed into this one and then get
    // persisted into its draft. The ref guard means a re-render during the
    // async load (e.g. the user typing in the gap) doesn't wipe their input a
    // second time.
    if (clearedForSessionRef.current !== sessionId) {
      clearedForSessionRef.current = sessionId
      textInput.setInput("")
      attachments.clear()
      // Folded-paste bodies are in-memory only (not persisted); drop them too.
      setPastedBlocks({})
      // Folded links belong to the draft they were pasted into; the restore
      // below brings this session's own map back.
      setFoldedLinks({})
      // Parameter values belong to the draft they were typed into.
      setTemplateBinding(undefined)
      setActiveParamId(null)
      setPendingLaunchSpec(null)
    }
    let cancelled = false
    getChatDraft(sessionId)
      .then((row) => {
        if (cancelled) return
        // The box was emptied synchronously above, so any text in it now was
        // typed during this async gap. That text wins: the stored draft used to
        // land on top of it the moment the read resolved, replacing what the
        // user was in the middle of writing. The stored text's companions —
        // parameter values, folded links — describe THAT text, so they stay
        // out with it; attachments and context chips below are additive and
        // still come back.
        const typedDuringLoad = textInput.value.length > 0
        if (!typedDuringLoad) {
          // Populate the saved draft only when the target actually has one.
          if (row?.text) textInput.setInput(row.text)
          // The tokens come back with the text; their values come back here.
          setTemplateBinding(row?.templateBinding)
          // Same for links: the text holds short labels, and this is what
          // turns them back into URLs on send. Without it a restored draft
          // would ship `svenstaro/genact` as prose.
          setFoldedLinks(row?.foldedLinks ?? {})
        }
        // Attachments whose binary survived are re-staged for real: the file
        // comes back, ready to send. Seed the store with its cached extraction
        // first so re-staging doesn't re-parse a document we already read.
        // Anything whose blob was evicted (quota) still degrades to a chip.
        const restored = row?.attachments ?? []
        const revivable = restored.filter((a) => a.bytes)
        if (revivable.length > 0) {
          staged.seedIncoming(
            revivable.map((a) => ({
              filename: a.name,
              sizeBytes: a.size,
              state: {
                status: "ready" as const,
                sizeBytes: a.size,
                bytes: a.bytes,
                restoredContent: a.extractedContent,
                remoteDocument: parseRemoteDocumentProvenance(a.remoteDocument) ?? undefined,
                ocrText: a.ocrText,
                includeOcr: a.includeOcr,
                ...(a.extractedText
                  ? {
                      extracted: {
                        kind: a.mediaType.startsWith("audio/")
                          ? ("audio" as const)
                          : ("document" as const),
                        block: { type: "text" as const, text: a.extractedText },
                        tokens: a.tokens ?? 0,
                        text: a.extractedText,
                        extractedContent: a.extractedContent,
                      },
                    }
                  : {}),
                // A video's frames are re-sampled with the settings it was saved
                // with; a row this build cannot read falls back to the default.
                ...(isVideoPreprocessSettings(a.videoSettings)
                  ? { video: { settings: a.videoSettings } }
                  : {}),
              },
            }))
          )
          const revived = revivable.map((a) => ({
            citation: a.citation,
            file: new File([a.bytes as BlobPart], a.name, { type: a.mediaType }),
          }))
          // A restored document cites what it cited before the switch. The
          // row may come from another build, so its citation is checked first.
          for (const { citation, file } of revived) {
            if (isContextRef(citation)) attachmentCitations.expect(file, citation)
          }
          attachments.add(revived.map(({ file }) => file))
        }
        // Reminder chips are now only for the ones we could NOT bring back.
        const reminders = restored.filter((a) => !a.bytes)
        setRestoredAttachments(reminders)
        if (reminders.length > 0) {
          toast.info(tDraftRef.current("toast", { count: reminders.length }))
        }
        // Context chips come back too — each ref carries its own snapshot and
        // fingerprint, so staging needs no re-read of the source. Rows can come
        // from another build, so each entry is shape-checked first and a
        // malformed one reads as absent. Freshness is then re-checked so a
        // record edited while the draft sat shows its `stale` flag rather than
        // presenting the old body as current.
        const storedSelections = (row?.contextSelections ?? []).filter(isContextSelectionRef)
        if (storedSelections.length > 0) {
          void refreshSelectionFreshness(storedSelections)
            .then(({ selections }) => {
              if (cancelled) return
              for (const selection of selections) {
                useChatStore.getState().addContextSelection(selection, sessionId)
              }
            })
            .catch(() => {
              if (cancelled) return
              for (const selection of storedSelections) {
                useChatStore.getState().addContextSelection(selection, sessionId)
              }
            })
        }
        setDraftHydratedFor(sessionId)
      })
      .catch(() => {
        if (cancelled) return

        setDraftHydratedFor(sessionId)
      })
    return () => {
      cancelled = true
    }
  }, [
    persistDrafts,
    sessionId,
    draftHydratedFor,
    setFoldedLinks,
    textInput,
    attachments,
    attachmentCitations,
    staged,
    setPastedBlocks,
    setTemplateBinding,
    setActiveParamId,
    setPendingLaunchSpec,
  ])

  const intentSessionRef = useRef("")
  const intentIdentity = `${sessionId ?? ""}:${props.externalSessionLink?.agentId ?? ""}:${props.externalSessionLink?.sessionId ?? ""}`
  useEffect(() => {
    intentSessionRef.current = intentIdentity
    return () => {
      intentSessionRef.current = ""
    }
  }, [intentIdentity])

  // A system-selection action arrives while the main window and target session
  // are being activated. Consume it only after the saved draft has finished
  // hydrating, otherwise the async draft read can overwrite the inserted stock
  // instruction. Ask has no stock prompt and only focuses the textarea.
  useEffect(() => {
    if (!sessionId || !pendingComposerIntent || isComposing) return
    if (persistDrafts && draftHydratedFor !== sessionId) return
    if (
      pendingComposerIntent.waitForEmpty &&
      (textValue || attachments.files.length || turnInFlight || followUpInFlight)
    )
      return
    const intent = consumeComposerIntent(sessionId, pendingComposerIntent.candidateId)
    if (!intent) return
    if (
      intent.externalSession &&
      (intent.externalSession.agentId !== props.externalSessionLink?.agentId ||
        intent.externalSession.sessionId !== props.externalSessionLink?.sessionId)
    )
      return
    if (intent.prompt !== null) {
      const merged = mergeComposerIntentPrompt(textInput.value, intent.prompt, intent.mode)
      textInput.setInput(merged)
      // Auto-send (tray quick panel) is armed here but fired by the effect
      // below, once the input state has actually flushed: `submit` builds the
      // turn from the committed input and its derived state (segments, param
      // tokens, folded pastes), none of which has caught up with this write
      // until the next commit.
      if (intent.autoSend) pendingAutoSendRef.current = { text: merged, sessionId }
    }
    for (const ref of intent.citations ?? []) useChatStore.getState().addCitedRef(ref, sessionId)
    if (intent.images?.length) {
      const identity = intentIdentity
      void attachmentToFiles({
        kind: "photos",
        items: intent.images.map((image) => ({
          uri: `data:${image.mimeType};base64,${image.data}`,
          mime: image.mimeType,
        })),
      })
        .then(async (files) => {
          const isCurrent = () => intentSessionRef.current === identity
          const accepted = await acceptFiles(files, { isCurrent })
          if (!isCurrent() && accepted.length === 0) {
            useComposerIntentStore.getState().stage(sessionId, {
              ...intent,
              candidateId: `${intent.candidateId}:attachments`,
              prompt: null,
              mode: "append",
            })
          }
        })
        .catch((error) => {
          loggers.chat.error("restoring queued attachments failed", error)
          toast.error(error instanceof Error ? error.message : tCommands("failed"))
        })
    }
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [
    acceptFiles,
    intentIdentity,
    tCommands,
    consumeComposerIntent,
    isComposing,
    props.externalSessionLink?.agentId,
    props.externalSessionLink?.sessionId,
    textInput,
    draftHydratedFor,
    pendingComposerIntent,
    persistDrafts,
    sessionId,
    textValue,
    attachments.files.length,
    turnInFlight,
    followUpInFlight,
  ])

  // Second half of the auto-send handshake: fire only once the committed input
  // matches the text we staged, so the send can never race the state write.
  useEffect(() => {
    const pending = pendingAutoSendRef.current
    if (pending === null) return
    if (sessionId !== pending.sessionId) {
      pendingAutoSendRef.current = null
      if (pending.recoverHandoff && pending.sessionId) {
        useComposerIntentStore.getState().stage(pending.sessionId, {
          candidateId: crypto.randomUUID(),
          prompt: pending.text,
          mode: "append",
          waitForEmpty: true,
          citations: pending.citations,
        })
        for (const ref of pending.citations ?? [])
          useChatStore.getState().removeCitedRef(ref.id, pending.sessionId)
      }
      pending.onSubmitted?.(false)
      return
    }
    if (textValue !== pending.text) return
    // Capture the addressed handoff before clearing the one-shot latch.
    const submission = submit()
    pendingAutoSendRef.current = null
    void submission.then((sent) => pending.onSubmitted?.(sent))
  }, [textValue, submit, sessionId])

  useEffect(() => {
    if (!persistDrafts) return
    if (!sessionId) return
    if (draftHydratedFor !== sessionId) return
    // Built here, not memoised during render. A chip's citation is bound by the
    // observe effect near the top of this component, which runs after render,
    // so rows computed in the render that added the chip would save it
    // uncited. Rebuilding is a map over a handful of files, and the blobs come
    // from `staged`, which already holds the bytes it fetched for extraction,
    // so a save still costs no extra reads.
    const draftAttachments = draftAttachmentsFromFiles(
      attachments.files,
      staged.byId,
      attachmentCitations.citationOf
    )
    try {
      // `undefined` keeps the default debounce. The binding is passed on every
      // save (never omitted) so clearing the last parameter actually clears the
      // stored value — omission means "preserve" in `setDraft`.
      setChatDraftDebounced(sessionId, textValue, draftAttachments, undefined, {
        templateBinding: effectiveBinding ?? null,
        // Passed on every save (never omitted) so removing the last link
        // actually clears the stored map — omission means "preserve".
        foldedLinks,
        // Same contract: every save carries the live chip list, so unstaging
        // the last chip clears the stored selections instead of leaving them
        // to resurrect on the next reload.
        contextSelections: draftContextSelections,
      })
    } catch {
      // Dexie unavailable (e.g., SSR / tests without fake-indexeddb) — drafts are best-effort.
    }
  }, [
    textValue,
    attachments.files,
    staged.byId,
    attachmentCitations,
    sessionId,
    draftHydratedFor,
    persistDrafts,
    effectiveBinding,
    foldedLinks,
    draftContextSelections,
  ])

  // Auto-resize textarea (JS fallback for browsers without field-sizing:content
  // support, e.g. older iOS/Android WebViews). field-sizing-content in the
  // className is the progressive-enhancement path; this effect only runs when
  // the CSS property is absent.
  //
  // Crucially, it must NOT touch the textarea mid-composition: mutating
  // `style.height` forces a synchronous reflow that aborts the active IME
  // composition buffer on Android/iOS WebViews, so on-device typing (esp. CJK
  // / predictive keyboards) appears to "swallow" characters. We defer the
  // resize until composition ends, where this effect re-runs (isComposing flips
  // back to false) and adjusts the height once for the committed text.
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    if (typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content")) return
    if (isComposing) return
    ta.style.height = "auto"
    ta.style.height = `${Math.min(ta.scrollHeight, COMPOSER_MAX_HEIGHT_PX)}px`
  }, [textValue, isComposing])

  // Imperative handle: insert `@name ` at the caret. Used by the desktop
  // shell's member list to mention a teammate without going through any
  // intermediate draft store.
  useImperativeHandle(
    props.handleRef,
    () => ({
      insertMention: (name: string) => {
        const ta = textareaRef.current
        const cur = textInput.value
        const pos = ta?.selectionStart ?? cur.length
        const needsLeadSpace = pos > 0 && !/\s$/.test(cur.slice(0, pos))
        const insertion = `${needsLeadSpace ? " " : ""}@${name} `
        const next = cur.slice(0, pos) + insertion + cur.slice(pos)
        textInput.setInput(next)
        const caret = pos + insertion.length
        requestAnimationFrame(() => {
          const ta2 = textareaRef.current
          if (ta2) {
            ta2.setSelectionRange(caret, caret)
            ta2.focus()
          }
        })
        setCaret(caret)
      },
      focus: () => {
        textareaRef.current?.focus()
      },
    }),
    [textInput]
  )

  const isStreaming = props.status === "streaming"
  // The primary button's whole state (send / stop / spinner / draft) in one
  // decision — see `send-button-mode.ts` for the combination table. While a
  // turn runs the button is Stop; a typed follow-up gets its own control
  // beside it rather than taking Stop away.
  //
  // A fresh turn's dispatch counts as "sending" only until the turn is live:
  // past that point the run's own state (Stop) is the truth, however long the
  // runtime keeps `onSubmit` pending.
  const isSending = followUpInFlight || (turnInFlight && !isStreaming)
  const sendButton = resolveSendButton({
    status: props.commandRunning
      ? "streaming"
      : props.session?.platformBinding
        ? "ready"
        : props.status,
    isSending: props.commandRunning ? false : isSending,
    isPreparingAttachments,
    hasContent:
      !props.commandRunning && (textValue.trim().length > 0 || attachments.files.length > 0),
    canResume: props.canResume,
    hasPendingDrafts: (props.pendingDraftCount ?? 0) > 0,
    composerDisabled: !!props.disabled,
    outboundBlocked,
  })
  // Cross-fade transition for the send/stop button icon swap (reduced-motion aware).
  const sendIconTransition = useReducedMotionTransition(mobileTransition("fast"))

  // Drive the inline ghost-text engine off the current draft. Suppress while a
  // `/@!#` trigger popover is open, the caret isn't at the end of the text, or
  // a turn is streaming / the composer is disabled — the controller debounces
  // and only the most recent feed is queried, so this always reflects state.
  const ghostFeed = ghost.feed
  useEffect(() => {
    const value = textValue
    const suppress = !!trigger || isStreaming || !!props.disabled || caret !== value.length
    ghostFeed(value, { suppress })
  }, [textValue, caret, trigger, isStreaming, props.disabled, ghostFeed])

  const ephemeralSkillIds = useComposerEphemeralSkillIds(props.session?.id ?? null)
  const toggleEphemeralSkill = useChatStore((s) => s.toggleEphemeralSkill)
  // Keyed by THIS pane's conversation, matching where `ephemeralSkillIds` are read
  // from — the bare action defaults to the focused pane, so × detached a skill
  // from the conversation beside it and left this chip standing.
  const composerSessionIdForSkills = props.session?.id ?? null
  const removeEphemeralSkill = useCallback(
    (skillId: string) => toggleEphemeralSkill(skillId, composerSessionIdForSkills),
    [toggleEphemeralSkill, composerSessionIdForSkills]
  )
  const dismissRestoredAttachments = useCallback(() => setRestoredAttachments([]), [])
  // A folded paste is large by definition — that is why it folded — and its
  // chip only shows a line count. Counted once per paste, not by splitting
  // every body again on every keystroke.
  const pastedLineCounts = useMemo(
    () =>
      Object.entries(pastedBlocks).map(
        ([placeholder, body]) => [placeholder, countLines(body)] as const
      ),
    [pastedBlocks]
  )

  return (
    // Every composer control below writes its draft state through actions that
    // otherwise default to "the focused conversation". In split view that made
    // the unfocused pane edit the pane beside it — including the permission
    // mode, which `resolveSendOptions` reads back, so the mistake reached the
    // model and not just the chrome.
    <ComposerSessionProvider value={props.session?.id ?? null}>
      <div
        ref={setContainerEl}
        style={
          composerNoticeVars(props.skin, compactLayout, {
            isMobile,
            nativeShell: nativeMobile,
          }) as CSSProperties
        }
      >
        {/* Every band stacked above the input card shares one scroll container
          with a height cap. Restored attachments, an active goal, an open loop
          and the plan-mode banner could otherwise push the input off the
          bottom of the screen. Each band still animates its own height inside
          it. (Staged attachments live INSIDE the card — `contextRow`.)
          The cap is a share of the VISIBLE height: with the soft keyboard up,
          `vh` still measures the whole layout viewport, so 40vh could fill most
          of what is left above the keyboard. `--visual-viewport-height` is set
          only while the keyboard is open (`lib/capacitor/keyboard-viewport.ts`)
          and the cap falls back to 40vh otherwise. */}
        <div
          role="region"
          aria-label={t("contextRegion")}
          className="max-h-[calc(var(--visual-viewport-height,100vh)*0.4)] overflow-y-auto overscroll-contain"
        >
          {pendingLaunchSpec ? (
            <TemplateLaunchDiffBar
              differences={launchDifferences}
              templateName={pendingLaunchSpec.templateName}
              labelFor={launchFieldLabel}
              onStartNewSession={() => void startSessionFromTemplate()}
              onDismiss={() => setPendingLaunchSpec(null)}
              className="mb-1"
            />
          ) : null}
          <Collapse>
            <MemoDraftRestoredAttachments
              items={restoredAttachments}
              onDismiss={dismissRestoredAttachments}
            />
          </Collapse>
          <MemoOcrResultBubble
            open={ocrBubbleOpen}
            onOpenChange={setOcrBubbleOpen}
            result={ocrBubbleResult}
            imageSrc={ocrBubbleImageSrc ?? undefined}
            onCopy={copyToClipboard}
            onCopyPage={copyPageToClipboard}
          />
          <PluginExtensionSlot point="chat.input.above" className="px-1 empty:hidden" />
          <Collapse>
            <MemoSkillChipRow
              ids={ephemeralSkillIds}
              onRemove={removeEphemeralSkill}
              disabledIds={props.session?.disabledSkillIds}
            />
          </Collapse>
          {/* Folded large-paste chips — only those whose placeholder is still in the
          text (manual deletion drops the chip too). */}
          <Collapse>
            {(() => {
              const chips = pastedLineCounts.filter(([ph]) => textValue.includes(ph))
              if (chips.length === 0) return null
              return (
                <div className="flex flex-wrap gap-1 px-1 pb-1" data-testid="composer-pasted-chips">
                  {chips.map(([ph, lineCount]) => (
                    <span
                      key={ph}
                      className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground"
                    >
                      <FileTextIcon className="size-3 shrink-0" aria-hidden />
                      {t("pastedChip", { count: lineCount })}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => removePastedBlock(ph)}
                        aria-label={t("removePastedChip")}
                        className="-mr-1 size-4 rounded-sm text-muted-foreground/60 hover:bg-transparent hover:text-foreground"
                      >
                        <XIcon className="size-3" aria-hidden />
                      </Button>
                    </span>
                  ))}
                </div>
              )
            })()}
          </Collapse>
          {/* Re-paste reminder: a restored draft can carry `[Pasted …]` placeholders
          whose bodies weren't persisted. Nudge the user to re-paste (the
          placeholder text stays visible so they see exactly where). */}
          <Collapse>
            {(() => {
              const orphans = findPastePlaceholders(textValue).filter((ph) => !(ph in pastedBlocks))
              if (orphans.length === 0) return null
              return (
                <div
                  className="px-1 pb-1 text-[11px] text-amber-600 dark:text-amber-500"
                  data-testid="composer-paste-reminder"
                >
                  {t("pasteReminder", { count: orphans.length })}
                </div>
              )
            })()}
          </Collapse>
          <ComposerStatusBands sessionId={sessionId} />
          {predictionEligible && (
            <FollowUpSuggestions
              suggestions={prediction.suggestions}
              onAccept={(text) => acceptPrediction(text, predictionAcceptance === "send")}
              onDismiss={prediction.dismiss}
              directSend={predictionAcceptance === "send"}
              status={prediction.status}
              onRetry={prediction.retry}
              onConfigure={() => props.onOpenSettings("conversation")}
            />
          )}
        </div>
        {props.runStatus ? (
          // Docked onto the card's top edge. The inset follows the corner the
          // card actually draws (`composerCardRadiusPx` — the phone card rounds
          // further than the classic skin's own radius) so the strip's sides
          // land where the card's top edge has turned straight; a pill skin
          // insets more, the square skin not at all. Its own top corners echo
          // the card's inner curve.
          <div
            data-slot="composer-run-status"
            className="empty:hidden"
            style={(() => {
              const radius = composerCardRadiusPx(props.skin, compactLayout)
              return {
                paddingInline: `${radius}px`,
                "--run-strip-radius": `${Math.round(radius * 0.6)}px`,
              } as CSSProperties
            })()}
          >
            {props.runStatus}
          </div>
        ) : null}
        <ComposerBox
          skin={props.skin}
          compactLayout={compactLayout}
          isMobile={isMobile}
          onReviewDrafts={props.onReviewDrafts}
          pendingDraftCount={props.pendingDraftCount}
          nativeShell={nativeMobile}
          touchInput={touchInput}
          disabled={props.disabled}
          permissionMode={permissionMode}
          placeholder={props.placeholder}
          disabledPlaceholder={props.disabledPlaceholder}
          placeholderHints={props.placeholderHints}
          onActiveHintChange={noteActiveHint}
          textInput={controller.textInput}
          textareaRef={textareaRef}
          chipOverlayRef={chipOverlayRef}
          shellDiagnosticOverlayRef={shellDiagnosticOverlayRef}
          shellDiagnostics={shellDiagnosticsForOverlay}
          shellDiagnosticsLabel={tShellUi("shell.diagnosticsLabel")}
          ghostOverlayRef={ghostOverlayRef}
          overlaySegments={overlaySegments}
          maxHeightRem={COMPOSER_MAX_HEIGHT_REM}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onSelect={onSelect}
          onMouseUp={onTextareaMouseUp}
          paramState={paramPillState}
          commandScope={commandScope}
          routeState={routeState}
          preview={preview}
          saveAsTemplate={textValue.trim().length > 0 ? () => setSaveTemplateOpen(true) : null}
          enhance={
            // Same gate as the bookmark beside it: a wand over an empty box has
            // nothing to rewrite, and `enhancePrompt` would only answer
            // "empty". Off entirely when the user disabled the feature.
            enhanceEnabled && textValue.trim().length > 0 ? (
              <EnhanceButton
                value={textValue}
                onApply={(next) => textInput.setInput(next)}
                session={props.session}
                disabled={props.disabled || props.status === "streaming"}
                className="size-6 text-muted-foreground/60 hover:bg-muted hover:text-foreground"
                onOpenProviderSettings={() => props.onOpenSettings("api-key")}
              />
            ) : null
          }
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          isComposing={isComposing}
          onBlur={onBlur}
          onCopy={linkFolding.onCopy}
          onCut={linkFolding.onCut}
          ghost={ghost}
          acceptGhost={acceptGhost}
          fileInputRef={fileInputRef}
          attachmentAccept={
            supportsQQOriginalFiles(props.session)
              ? "*/*"
              : props.session?.platformBinding
                ? ATTACHMENT_ACCEPT
                : MOTION_ATTACHMENT_ACCEPT
          }
          onFilePick={onFilePick}
          openFileDialog={openFileDialog}
          onPlusAttach={onPlusAttach}
          captureSmartSnapshot={captureSmartSnapshot}
          smartSnapshotPending={smartSnapshotPending}
          capabilityMenu={capabilityMenu}
          // The `+` menu's namespace entries (`@lark:`, `@issue:`, `/goal`)
          // work by TYPING: the composer's own trigger detection is what opens
          // each panel, so the menu puts the caret in front of it rather than
          // owning a second picker. Append, never replace — a half-written
          // message is not the menu's to discard.
          onInsertText={(text) => {
            const current = textInput.value
            const needsSpace = current.length > 0 && !/\s$/.test(current)
            textInput.setInput(`${current}${needsSpace ? " " : ""}${text}`)
            textareaRef.current?.focus()
          }}
          onOpenExternalServices={() => props.onOpenSettings("services")}
          isDragging={isDragging}
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          sendButton={sendButton}
          sendIconTransition={sendIconTransition}
          isPreparingAttachments={isPreparingAttachments}
          submit={() => void submit()}
          onStop={() => void props.onStop()}
          toolbar={props.toolbar}
          bridges={
            <>
              <VoiceTranscriptionBridge disabled={props.disabled} textInput={textInput} />
              <ComposerAppendBridge
                sessionId={props.session?.id}
                textInput={textInput}
                addFiles={addStagedFiles}
                requestSubmit={(text, onSubmitted) => {
                  pendingAutoSendRef.current?.onSubmitted?.(false)
                  pendingAutoSendRef.current = {
                    text,
                    sessionId,
                    onSubmitted,
                    recoverHandoff: true,
                    citations: selectComposerCitedRefs(useChatStore.getState(), sessionId),
                  }
                }}
              />
            </>
          }
          contextRow={
            // One row, and only for what has no form in the text: attachments,
            // @-references, artifacts — plus any command that FAILED. Commands
            // and links show up in the text itself. Rendered INSIDE the input
            // card so staged media reads as part of the message being written.
            <MemoContextChipBar
              videoRoute={props.videoRoute}
              imageInput={props.imageInput}
              onExtractImageText={handleExtractImageText}
              onRunOcr={handleRunOcrForPanel}
              ocrBusy={ocr.status === "running"}
              onExtractOcrToInput={handleExtractOcrToInput}
              onViewOcrDetail={ocrBubbleResult ? openOcrBubble : undefined}
              preparingImageCount={preparingImageCount}
              // The segments are read ONLY to name the commands that failed.
              // Passed on every keystroke they re-rendered the whole row —
              // attachments, references, artifacts — for a list that is empty
              // unless a command failed.
              segments={commandErrors.length > 0 ? segments : undefined}
              commandErrors={commandErrors}
              onRemoveCommand={removeCommandSegment}
            />
          }
          t={t}
          tAttach={tAttach}
        />

        <CommandHintBar trigger={completionTrigger} commandMap={commandMap} value={textValue} />

        {/* Reads scheduling intent out of what is being typed and offers the
            scheduler's create form pre-filled. Never intercepts the turn —
            Enter still sends. See `components/chat/composer/schedule-suggestion`.

            General direct chat ONLY, on the same `isCombinedMention` condition
            the entity sources use. This one component serves every composer in
            the app, and "turn this into a scheduled task?" is an offer to LEAVE
            for `/scheduler` — which in the workflow editor's chat tab means
            abandoning the graph being authored, and in a team or IM-draft
            composer means walking out of a conversation that is not the user's
            alone. A direct chat is the only place that detour is harmless. */}
        {isCombinedMention ? (
          <ScheduleSuggestion value={textValue} sessionId={props.session?.id} className="mx-1" />
        ) : null}

        <PluginExtensionSlot point="chat.input.below" className="px-1 pt-1 empty:hidden" />

        {/* Mounted only while open: it takes the draft as its body, so a
            closed dialog rendered again on every keystroke. */}
        {saveTemplateOpen ? (
          <SaveAsTemplateDialog
            open
            body={textValue}
            launchSpec={currentLaunchSpec}
            onOpenChange={setSaveTemplateOpen}
            onSave={saveCurrentAsTemplate}
          />
        ) : null}

        <TemplateParamPopover
          paramId={activeParamId}
          param={
            activeParamId
              ? (paramDeclarations.find((param) => param.id === activeParamId) ?? null)
              : null
          }
          searchResources={searchTemplateResources}
          value={activeParamId ? effectiveBinding?.params[activeParamId] : undefined}
          anchor={containerEl}
          position={
            activeParamId
              ? { index: paramIds.indexOf(activeParamId), total: paramIds.length }
              : undefined
          }
          onChange={(value) => activeParamId && setParamValue(activeParamId, value)}
          onClose={() => setActiveParamId(null)}
        />

        {/* One `@` panel on every surface. A phone's team room used to swap it
            for a members-only bottom sheet, which took `@` away from files,
            agents, skills and the rest of this panel there — the same room on
            desktop could reference a file and the phone could not — and floated
            that sheet by a measured height that left out the toolbar row, so it
            sat on top of the input it was completing. This panel already lists
            the room's members (with their roles) and sizes its rows for a
            finger. */}
        <ComposerPopover
          ref={popoverRef}
          trigger={completionTrigger}
          cwd={cwd}
          slashCommands={slashCommands}
          anchor={containerEl}
          routeOptions={routeOptionsForTrigger}
          chatAgents={chatAgents}
          teamMembers={teamMembers}
          teamMemberRoleById={teamMemberRoleById}
          chatSkills={chatSkills}
          chatPresets={chatPresets}
          entityContext={entityContext}
          chatTemplates={chatTemplates}
          workflowElements={props.workflowMention?.elements}
          onHighlightElement={props.workflowMention ? handleHighlightElement : undefined}
          recentCommands={recentCommands}
          pinnedCommands={pinnedCommands}
          onTogglePin={togglePinnedCommand}
          onPick={onPickPopoverItem}
          onDismiss={dismissPopover}
          shellCompletions={shell.completions}
          shellEmptyMessage={shellEmptyMessage}
          memoryFilesAccess={memoryFilesAccess}
        />

        <CommandParamForm
          command={paramForm?.command ?? null}
          onSubmit={handleParamFormSubmit}
          onCancel={handleParamFormCancel}
        />
      </div>
    </ComposerSessionProvider>
  )
}

/*
 * Memo boundaries for what renders around the input box.
 *
 * `ComposerInner` re-renders on every keystroke — the draft is its state — and
 * nothing it rendered was memoized, so every band above the box, the chip row
 * inside it and the OCR sheet re-rendered with it. Their props are stable
 * between keystrokes (the handlers above are callbacks, the data changes only
 * when its own source does), so a memo boundary is all it takes for typing to
 * stop reaching them.
 */
const MemoContextChipBar = memo(ContextChipBar)
const MemoSkillChipRow = memo(SkillChipRow)
const MemoDraftRestoredAttachments = memo(DraftRestoredAttachments)
const MemoOcrResultBubble = memo(OcrResultBubble)

/** Line count of a text block, without allocating the lines. */
function countLines(text: string): number {
  let lines = 1
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lines++
  return lines
}

/** The OCR sheet's copy actions. Module-level so they keep one identity. */
function copyToClipboard(text: string): void {
  void navigator.clipboard?.writeText(text)
}
function copyPageToClipboard(_page: number, text: string): void {
  void navigator.clipboard?.writeText(text)
}

/**
 * The self-hiding status bands under the attachments: the goal (ADR-0019), the
 * open `/loop`, and the plan-mode banner. Each reads its own store; the only
 * thing the composer tells them is which conversation they belong to.
 */
const ComposerStatusBands = memo(function ComposerStatusBands({
  sessionId,
}: {
  sessionId: string | null
}) {
  return (
    <>
      {/* ADR-0019 — active/paused goal status + controls; self-hides when none. */}
      <Collapse>
        <GoalStatusPill sessionId={sessionId} />
      </Collapse>
      {/* /loop status + controls; self-hides when no open loop. */}
      <Collapse>
        <LoopStatusPill sessionId={sessionId} />
      </Collapse>
      {/* Plan-mode state banner; self-hides outside plan mode. */}
      <Collapse>
        <PlanModeBanner />
      </Collapse>
    </>
  )
})

/**
 * Speech → text, appended to the draft.
 *
 * Takes the composer's stable text handle as a prop instead of reading the
 * prompt-input context: a context consumer re-renders on every keystroke, and
 * this one carries the whole voice cluster (dictation, live voice, the
 * settings popover) with it. Memoized with a stable handle, typing never
 * reaches it.
 */
const VoiceTranscriptionBridge = memo(function VoiceTranscriptionBridge({
  disabled,
  textInput,
}: {
  disabled?: boolean
  textInput: TextInputContext
}) {
  const onTranscription = useCallback(
    (text: string) => {
      if (!text.trim()) return
      const cur = textInput.value
      const sep = cur && !cur.endsWith(" ") ? " " : ""
      textInput.setInput(`${cur}${sep}${text}`)
    },
    [textInput]
  )
  return <VoiceControls disabled={disabled} onTranscription={onTranscription} />
})

export {
  COMPOSER_APPEND_EVENT,
  dispatchComposerAppend,
  type ComposerAppendDetail,
} from "@/lib/chat/composer-append"

/**
 * Lets components outside the PromptInput controller context (e.g. the OCR
 * result card in the message list, a sidechat handing a conclusion back, or a
 * stopped turn putting its queued follow-ups back) stage material in the
 * composer by dispatching `COMPOSER_APPEND_EVENT`. Text is appended; files are
 * staged as attachments; citations, reply target and carried envelopes go to
 * this conversation's composer state, where the send path reads them.
 */
const ComposerAppendBridge = memo(function ComposerAppendBridge({
  sessionId,
  textInput,
  addFiles,
  requestSubmit,
}: {
  sessionId?: string
  /** The composer's stable text handle — see `VoiceTranscriptionBridge`. */
  textInput: TextInputContext
  /** Stage files the way a drop or paste does. */
  addFiles: (files: File[]) => void
  requestSubmit: (text: string, onSubmitted?: (sent: boolean) => void) => void
}) {
  const t = useTranslations("chat.composer.putBack")
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  useEffect(() => {
    const onAppend = (e: Event) => {
      const detail = (e as CustomEvent<ComposerAppendDetail>).detail
      if (!composerAppendHasContent(detail) || detail.claimed) return
      // Addressed events go to exactly one composer. An un-addressed event is
      // legacy shorthand for "the active session", which keeps the single-pane
      // callers working without making every composer echo it.
      const target = detail.sessionId ?? activeSessionId
      if (target && target !== sessionId) return
      detail.claimed = true
      const text = detail.text
      let appended = textInput.value
      if (text && text.trim()) {
        const cur = textInput.value
        const sep = cur && !cur.endsWith(" ") ? " " : ""
        appended = `${cur}${sep}${text}`
        textInput.setInput(appended)
      }
      if (detail.files?.length) addFiles([...detail.files])
      const chat = useChatStore.getState()
      const slice = sessionId ?? null
      for (const ref of detail.citations ?? []) chat.addCitedRef(ref, slice)
      if (detail.submit) requestSubmit(appended, detail.onSubmitted)
      if (detail.carried?.length) chat.addCarriedPreambles([...detail.carried], slice)
      // A reply the user already picked here wins over the one coming back.
      if (detail.replyTo && !selectComposerReplyTo(chat, slice))
        chat.setReplyTo(detail.replyTo, slice)
      if (detail.missing?.length) {
        toast.warning(
          t("missing", { count: detail.missing.length, names: detail.missing.join(", ") })
        )
      }
    }
    window.addEventListener(COMPOSER_APPEND_EVENT, onAppend)
    return () => window.removeEventListener(COMPOSER_APPEND_EVENT, onAppend)
  }, [textInput, activeSessionId, sessionId, addFiles, requestSubmit, t])
  return null
})

function ComposerCapabilityMenu({
  session,
  status,
  disabled,
  onOpenSettings,
}: {
  session?: ChatSession | null
  status: PromptStatus
  disabled?: boolean
  onOpenSettings: (tab: SettingsTab) => void
}) {
  const isStreaming = status === "streaming"
  const controlsDisabled = disabled || isStreaming

  return (
    <>
      {/* The prompt-enhance wand used to live here. It rewrites what is in the
          box, so it belongs ON the box: it now sits beside the save-as-template
          bookmark in the input's corner, in the same icon-button style, where
          it is visible without opening a menu first. */}
      {/* Each capability is a CapabilityRow — a full-width menu row matching
          the menus' own entries, not a toolbar chip. */}
      <div data-testid="composer-capability-menu">
        <WebSearchToggle disabled={controlsDisabled} onOpenSettings={onOpenSettings} />
        <RoomTargetPicker session={session} disabled={controlsDisabled} />
        <SkillsMenuEntry session={session} disabled={controlsDisabled} />
      </div>
    </>
  )
}

// --- Outer component ------------------------------------------------------

const ComposerWithRef = forwardRef<ComposerHandle, Props>(function Composer(
  {
    session,
    status: paneStatus,
    onStartNewSession,
    onOpenSettings,
    onSend,
    onStop,
    disabled,
    placeholder,
    disabledPlaceholder,
    workflowMention,
    routing,
    placement = "docked",
    defaultSkin,
    placeholderHints,
    toolbar,
    runStatus,
  },
  ref
) {
  const runtimeRef = useRuntimeRefForSession(session?.id)
  const liveExternalLink = useExternalSessionLinkForSession(session?.id)
  const retainedLink = liveExternalLink ?? session?.externalAgentSession
  const externalSessionLink =
    runtimeRef.kind === "external" && retainedLink?.agentId === runtimeRef.agentId
      ? retainedLink
      : undefined
  const tCommands = useTranslations("chat.composer.commands")
  const tShell = useTranslations("chat.composer.shell")
  const shellJobCopy = useShellJobCopy()
  // The shell the `!` line will run under, and whether it can run at all. The
  // completion panel resolves the identical verdict in `ComposerInner`; both go
  // through `useShellContext` so a line can never be completed for one shell
  // and executed under another.
  const shell = useShellContext()
  const tMemory = useTranslations("chat.composer.memory")
  const tAttach = useTranslations("chat.composer.attachments")
  // ADR-0131 relay failures (no paired host / host predates the relay) are
  // reported here rather than thrown at the user as a stack trace.
  const tPlatform = useTranslations("chatPlatformComposer")
  const tPlatformName = useTranslations("inbox.platformBadge.names")
  const tWebSearch = useTranslations("webSearchToggle")
  const tDraftReview = useTranslations("chat.composer.draftReview")
  const tRoute = useTranslations("chat.composer.route")
  const tRouteRuntime = useTranslations("agentTeamsWorkspace.chat.runtime")
  // One prediction for the panel and the send: the controller still re-checks
  // the route the turn actually resolves.
  const { verdict: videoRoute } = useComposerVideoRoute(session)
  const imageInput = useComposerImageInput(session)
  // One per composer, like the attachment provider it follows: ids are minted
  // per provider, and a binding is only ever looked up by one of them.
  const [attachmentCitations] = useState(createAttachmentCitations)
  const composerBehavior = useSettingsStore((s) => s.settings?.composerBehavior)
  const stylePack = useSettingsStore((s) => s.settings?.stylePack)
  // Layout, not runtime: the skin's mobile floors (touch-sized send, the
  // stacked box) belong to every phone-shaped composer, including a 375px
  // browser rendering the same mobile shell — see `useCompactLayout`.
  const compactShell = useCompactLayout()
  const isMobileShell = usePlatform() === "mobile" || compactShell
  // Keyboard avoidance (soft-keyboard devices only): the docked composer glides
  // with the keyboard instead of jumping, the hero one scrolls its whole card
  // (toolbar row included) into view. See `use-composer-keyboard-avoidance.ts`.
  const softKeyboardDevice = useSoftKeyboardDevice()
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null)
  useComposerKeyboardAvoidance({ root: rootEl, placement, enabled: softKeyboardDevice })
  // One resolver owns pack default ← preset ← overrides ← mobile floors, so the
  // box never has to reason about any of it. `classic` (the default under the
  // Soft pack) resolves to today's exact geometry and emits no variables at
  // all. The pack only supplies the DEFAULT: an explicit skin choice still wins
  // (ADR-0148).
  const packSkin = resolveStylePack(stylePack).composerSkin
  const skin = useMemo(
    () =>
      resolveComposerSkin(
        { ...composerBehavior, skin: composerBehavior?.skin ?? defaultSkin },
        { isMobile: isMobileShell, packSkin }
      ),
    [composerBehavior, isMobileShell, packSkin, defaultSkin]
  )
  const compactLayout = skin.compactLayout
  // `compactLayout` (the legacy desktop setting) has always put the row inside
  // the box; a skin can now ask for the same thing without it. `expanded` is
  // NOT in-box despite not being `detached` — it needs the full pane width.
  const toolbarInBox = toolbarSitsInBox(skin.toolbarLayout) || compactLayout
  const focusedStatus = useChatStore((s) => s.status)
  const status = paneStatus ?? focusedStatus
  const tContinuation = useTranslations("chat.composer")
  const openGoal = useOpenGoal(session?.id)
  const canResume = useChatStore((state) => {
    if (!session || session.platformBinding || session.kind === "subagent" || openGoal) return false
    const slice =
      state.sessions[session.id] ?? (state.activeSessionId === session.id ? state : undefined)
    return (
      !!slice &&
      !slice.messagesLoading &&
      canContinueChat({
        status: paneStatus ?? slice.status,
        messages: selectVisibleMessages(slice.messages, slice.activeBranchByGroup),
        diagnostic: slice.errorDiagnostic,
        errorMessage: slice.errorMessage,
        queued: !!("queuedTurnMessageId" in slice && slice.queuedTurnMessageId),
      })
    )
  })
  const handleResume = useCallback(async () => {
    if (!session || disabled || !canResume) return
    const state = useChatStore.getState()
    const slice =
      state.sessions[session.id] ?? (state.activeSessionId === session.id ? state : undefined)
    if (
      !slice ||
      !canContinueChat({
        status: slice.status,
        messages: selectVisibleMessages(slice.messages, slice.activeBranchByGroup),
        diagnostic: slice.errorDiagnostic,
        errorMessage: slice.errorMessage,
        queued: !!("queuedTurnMessageId" in slice && slice.queuedTurnMessageId),
      })
    )
      return
    const user = lastUserMessage(selectVisibleMessages(slice.messages, slice.activeBranchByGroup))
    if (!user) return
    const route = readTurnRoute(user.metadata)
    const memberIds = (user.metadata as { targetMemberIds?: unknown } | undefined)?.targetMemberIds
    await onSend(tContinuation("resumePrompt"), [], null, {
      continuationOf: user.id,
      ...(route ? { route } : {}),
      ...(Array.isArray(memberIds) && memberIds.every((id) => typeof id === "string")
        ? { targetMemberIds: memberIds }
        : {}),
    })
  }, [canResume, disabled, onSend, session, tContinuation])
  const setPermissionMode = useChatStore((s) => s.setPermissionMode)
  // Keyed by THIS composer's session, not by focus: in split view the
  // unfocused pane echoed its slash-command results into the other pane's
  // transcript, and those echoes are persisted messages.
  const appendMessageToSession = useChatStore((s) => s.appendMessageToSession)
  const clearReferencedPaths = useChatStore((s) => s.clearReferencedPaths)
  const clearCitedRefs = useChatStore((s) => s.clearCitedRefs)
  const clearContextSelections = useChatStore((s) => s.clearContextSelections)

  // Same effective-cwd chain the send path uses — a selected workspace must
  // let `!` shell commands and memory appends run without a per-session dir.
  const cwd = useEffectiveCwd(session)

  // ── Platform connector mode ─────────────────────────────────────────────
  const conversationKey = session?.platformBinding?.conversationKey
  const pendingDrafts = useLiveQuery(
    () => (conversationKey ? listPendingDrafts(conversationKey) : Promise.resolve([])),
    [conversationKey],
    []
  )
  const [draftDialogOpen, setDraftDialogOpen] = useState(false)
  const openDraftReview = useCallback(() => setDraftDialogOpen(true), [])
  // Oversize attachment confirmation: handleSubmit parks a resolver here while
  // the dialog below collects the user's choice (send anyway / cancel).
  const [oversizeConfirm, setOversizeConfirm] = useState<{
    tokens: number
    resolve: (ok: boolean) => void
  } | null>(null)
  // Shortcut cheatsheet. Owned here (not in `ComposerInner`) because the
  // onboarding chip row that links to it lives at this level, while the `?`
  // shortcut that opens it lives in the inner key handler.
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false)

  const pushSystemMessage = useCallback(
    (payload: string | SystemMessageBlock | SlashCommandResultBlock) => {
      // With no conversation yet (the home composer), an appended message
      // lands in the pre-session projection, which the empty state never
      // renders, so a command's answer (`/template-list`, a plugin's reply)
      // vanished. Say it where the user is looking instead.
      if (!session?.id && typeof payload === "string") {
        toast.message(<div className="max-h-48 overflow-y-auto whitespace-pre-line">{payload}</div>)
        return
      }
      // Strings render as markdown text; any structured block (diagnostics card
      // or slash-result chip) rides the same data part and is dispatched by the
      // message renderer on its `kind`.
      const parts =
        typeof payload === "string"
          ? [{ type: "text", text: payload }]
          : [{ type: DIAGNOSTICS_PART_TYPE, data: payload }]
      appendMessageToSession(session?.id ?? null, {
        id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: "system",
        parts: parts as UIMessage["parts"],
      })
    },
    [appendMessageToSession, session?.id]
  )

  const {
    progress: commandProgress,
    run: runPluginCommand,
    cancel: cancelPluginCommand,
  } = usePluginSlashCommandExecution(session?.id ?? null)

  useSidechatShortcut(session?.id, session?.kind === "resource-workbench")

  const tBestOfN = useTranslations("bestOfNEntry")
  const [bestOfNChoice, setBestOfNChoice] = useState<{ sessionId: string; n: 2 | 3 | 4 } | null>(
    null
  )
  const bestOfNCount =
    bestOfNChoice && bestOfNChoice.sessionId === session?.id ? bestOfNChoice.n : null
  // A stable object and callback, so the memoized toolbar is not re-rendered
  // by a Composer render that changed neither.
  const bestOfNSessionId =
    session?.kind === "direct" && !session.platformBinding ? session.id : null
  const bestOfNControl = useMemo(
    () =>
      bestOfNSessionId
        ? {
            value: bestOfNCount,
            disabled,
            onChange: (n: 2 | 3 | 4 | null) =>
              setBestOfNChoice(n ? { sessionId: bestOfNSessionId, n } : null),
          }
        : undefined,
    [bestOfNSessionId, bestOfNCount, disabled]
  )
  const openProviderSettings = useCallback(() => onOpenSettings("api-key"), [onOpenSettings])
  const [bestOfNStart, setBestOfNStart] = useState<{
    prepared: PreparedBestOfN
    resolve(value: boolean): void
  } | null>(null)
  const bestOfNStartRef = useRef(false)
  const requestBestOfN = useCallback(
    async (prompt: string, n: 2 | 3 | 4, agents?: string[]): Promise<boolean> => {
      if (!session?.id || bestOfNStartRef.current) return false
      if (["streaming", "awaiting_approval"].includes(status)) {
        toast.error(tBestOfN("busy"))
        return false
      }
      bestOfNStartRef.current = true
      try {
        const { prepareBestOfNChat } = await import("@/lib/best-of-n/entry")
        const prepared = await prepareBestOfNChat(session.id, prompt, n, agents)
        return await new Promise<boolean>((resolve) => setBestOfNStart({ prepared, resolve }))
      } catch (error) {
        toast.error(
          tBestOfN("failed", { error: error instanceof Error ? error.message : String(error) })
        )
        return false
      } finally {
        bestOfNStartRef.current = false
      }
    },
    [session, status, tBestOfN]
  )
  useEffect(
    () => () => {
      bestOfNStart?.resolve(false)
    },
    [bestOfNStart]
  )

  const handleSlashCommand = useCallback(
    async (cmd: SlashCommand, args: string, staged?: SlashStagedFiles): Promise<boolean> => {
      if (cmd.handler) {
        if (cmd.name === "best-of-n" && staged?.files.length) {
          toast.error(tBestOfN("textOnly"))
          return false
        }
        let bestOfNAccepted = true
        const ctx: SlashContext = {
          args,
          startBestOfN: async (prompt, n, agents) => {
            bestOfNAccepted = await requestBestOfN(prompt, n, agents)
            return bestOfNAccepted
          },
          isAside: session?.kind === "resource-workbench",
          // The compact shell has no dock, so `/btw` reports desktop-only there too.
          isMobile: isMobileShell,
          activeSessionId: session?.id ?? null,
          chatStatus: status,
          // Read AND written against this composer's conversation. The mode
          // cycle (`lib/slash-commands/builtin.ts`) reads this value and hands
          // it straight back, so a focused-projection read here made an
          // unfocused pane silently cycle the pane beside it — and that mode
          // reaches the model through `resolveSendOptions`.
          currentPermissionMode: selectComposerPermissionMode(
            useChatStore.getState(),
            session?.id ?? null
          ),
          startNewSession: onStartNewSession,
          openSettings: onOpenSettings,
          setPermissionMode: (mode) => setPermissionMode(mode, session?.id ?? null),
          pushSystemMessage,
          ...(staged ? { stagedFiles: staged.files, consumeStagedFiles: staged.consume } : {}),
        }
        try {
          if (cmd.scope === "plugin") {
            if (!(await runPluginCommand(cmd, ctx))) return false
          } else {
            await cmd.handler(ctx)
            if (!bestOfNAccepted) return false
          }
          // Registered command names only — never the argument string, which
          // is free user text.
          void trackEvent("app.command.executed", {
            command: cmd.name,
            kind: "action",
            outcome: "succeeded",
          })
        } catch (err) {
          loggers.chat.error("slash command failed", err, {
            command: cmd.name,
            sessionId: session?.id,
          })
          void trackEvent("app.command.executed", {
            command: cmd.name,
            kind: "action",
            outcome: "failed",
          })
          // The action already explained the refusal. Retain its question.
          if (err instanceof SideChatDispatchError) return false
          toast.error(err instanceof Error ? err.message : tCommands("failed"))
        }
        return true
      }
      if (cmd.template) {
        void trackEvent("app.command.executed", {
          command: cmd.name,
          kind: "template",
          outcome: "succeeded",
        })
        return true
      }
      return false
    },
    [
      session,
      status,
      onStartNewSession,
      onOpenSettings,
      setPermissionMode,
      pushSystemMessage,
      tCommands,
      runPluginCommand,
      requestBestOfN,
      tBestOfN,
      isMobileShell,
    ]
  )

  const handleBashSubmit = useCallback(
    async (rawCmd: string): Promise<boolean> => {
      const cmd = rawCmd.trim()
      if (!cmd) return false
      if (!cwd) {
        toast.error(tShell("needsCwd"))
        return false
      }
      // An interactive command (ssh, a REPL, a login flow, `git rebase -i`, …)
      // needs a TTY the capture path lacks — it would hang or read EOF. Route it
      // to the real integrated terminal instead.
      //
      // Gated on the DOCK being reachable, not on `isTauri()`. The old gate was
      // safe only because `executeShell` threw "desktop app only" underneath it;
      // `runShellLine` runs anywhere a Host is, so an `isTauri()` gate would
      // send `!ssh host` from a paired browser down the capture path to block
      // until the capture timeout.
      //
      // …and gated on a Host being reachable as well, because `terminalAvailable()`
      // alone is NOT the predicate `useShellContext` answers with. It reports
      // whether a terminal transport could be picked — true for any Capacitor
      // shell and any browser with a companion target configured, paired or
      // not — while `availability` is the negotiated verdict, which additionally
      // requires the Host to advertise `terminal_exec` and grant it. An
      // unpaired phone satisfies the first and fails the second, so `!ssh host`
      // used to be handed to a dock with nothing behind it instead of getting
      // the one message that names the fix. Reading the run verdict here is what
      // actually makes the two branches unable to disagree: below, anything
      // short of `full` refuses immediately and by name, and now so does this
      // one. `full`, and not merely "not static-only", because
      // `shell-unavailable` is a reachable Host too, one that does not have the
      // configured shell. Routing that to the dock hands it a shell it cannot
      // spawn, which is the same silent nothing this gate exists to stop, while
      // the capture path refuses with `shell-unavailable` and names the shell.
      const hostReachable = shell.availability === "full"
      if (hostReachable && terminalAvailable() && detectInteractiveCommand(cmd).interactive) {
        try {
          await runInTerminalDock(cmd, cwd, session?.id ?? "")
          pushSystemMessage(tShell("interactiveRoutedToTerminal", { cmd }))
        } catch (err) {
          loggers.chat.error("interactive shell routing failed", err, { cmd, cwd })
          pushSystemMessage(
            tShell("failed", {
              cmd,
              error: err instanceof Error ? err.message : String(err),
            })
          )
        }
        return true
      }
      const reportRefusal = (refusal: { reason: string; detail: string }) => {
        loggers.chat.error("shell command failed", refusal.detail, {
          cmd,
          cwd,
          reason: refusal.reason,
          shell: shell.shell.path,
        })
        if (refusal.reason === "no-host") {
          pushSystemMessage(tShell("noHost", { cmd }))
        } else if (refusal.reason === "consent-required") {
          // The host wants a human to approve remote execution. Telling the user
          // that names an action; the generic "failed" sentence names none.
          pushSystemMessage(tShell("consentRequired", { cmd }))
        } else if (refusal.reason === "shell-unavailable") {
          pushSystemMessage(tShell("shellUnavailable", { cmd, shell: shell.shell.path }))
        } else if (refusal.reason === "unsupported-shell") {
          pushSystemMessage(tShell("unsupportedShell", { cmd, shell: shell.shell.path }))
        } else {
          pushSystemMessage(tShell("failed", { cmd, error: refusal.detail }))
        }
      }

      // As a supervised job owned by this conversation: output streams into a
      // live card, nothing kills it at a timeout, and it can be moved to the
      // Job Center or stopped. See `lib/shell-intelligence/shell-job.ts`.
      // Needs a conversation to own the job; the home composer has none yet.
      const sessionId = session?.id
      if (sessionId) {
        const started = await startShellJob({
          sessionId,
          line: cmd,
          cwd,
          shell: shell.shell,
          availability: shell.availability,
          label: tShell("job.label"),
        })
        if (started.ok) {
          const block = {
            kind: "shell-job" as const,
            jobId: started.job.id,
            sessionId,
            command: cmd,
            cwd,
          }
          // The card goes in before the run starts: every later write from
          // the run rewrites this row, and a fast `ls` must not settle first.
          try {
            await shellJobTranscript.upsert(sessionId, buildShellJobCardMessage(block))
          } catch (err) {
            loggers.chat.error("posting a shell job card failed", err, { jobId: block.jobId })
          }
          startShellJobRun(block, { transcript: shellJobTranscript, copy: shellJobCopy })
          return true
        }
        // A Host without the job command still runs the line, the old way.
        if (started.reason !== "job-unavailable") {
          reportRefusal(started)
          return true
        }
      }

      pushSystemMessage(tShell("runningHint", { cmd, cwd }))
      // Through the routed `terminal_exec`, under the user's configured shell —
      // so a `!` line works from a paired browser or phone, and `fish` users
      // stop silently getting `sh`. See `lib/shell-intelligence/execute.ts`.
      const outcome = await runShellLine({
        line: cmd,
        cwd,
        shell: shell.shell,
        availability: shell.availability,
      })
      if (outcome.ok) {
        pushSystemMessage(formatShellResult(cmd, outcome))
        return true
      }
      reportRefusal(outcome)
      return true
    },
    [cwd, pushSystemMessage, tShell, shellJobCopy, session, shell.shell, shell.availability]
  )

  const handleMemorySubmit = useCallback(
    async (target: ComposerMemoryTarget, text: string): Promise<boolean> => {
      const noteUsed = () =>
        useComposerCommandStore.getState().noteMemoryTargetUsed(memoryTargetKey(target))
      if (target.target === "store") {
        // ADR-0069 long-term memory — the SAME write path `/remember` uses, so
        // the PII gate and the consolidator can't be bypassed here.
        const { rememberFact } = await import("@/lib/memory/write/remember-fact")
        const result = await rememberFact({
          text,
          scope: target.scope,
          sessionId: session?.id ?? null,
        })
        if (result.ok) {
          noteUsed()
          toast.success(tMemory("storedInMemory", { scope: tMemory(`scope.${target.scope}`) }))
          return true
        }
        loggers.chat.warn("memory store write refused", { reason: result.reason })
        toast.error(tMemory(`storeError.${result.reason}`))
        return false
      }
      try {
        // The instruction file this conversation's next turn loads, found by
        // the send path's own discovery over the same roots and settings.
        const [{ appendInstructionMemory }, { resolveCharacterById }] = await Promise.all([
          import("@/lib/agents/instructions/append-memory"),
          import("@/lib/db/characters"),
        ])
        const { projects, activeProjectId } = useProjectStore.getState()
        const workspace = resolveSessionWorkspace(session, projects, activeProjectId)
        const character = session?.characterId
          ? await resolveCharacterById(session.characterId)
          : undefined
        const path = await appendInstructionMemory({
          scope: target.scope,
          text,
          cwd,
          roots: workspace ? allRootPaths(workspace) : cwd ? [cwd] : [],
          config:
            character?.instructionsOverride ?? useSettingsStore.getState().settings?.instructions,
        })
        noteUsed()
        toast.success(tMemory("appended", { path }))
        return true
      } catch (err) {
        loggers.chat.error("memory append failed", err, { scope: target.scope, cwd })
        const { InstructionMemoryError } = await import("@/lib/agents/instructions/append-memory")
        toast.error(
          err instanceof InstructionMemoryError
            ? tMemory(`fileError.${err.reason}`)
            : err instanceof Error
              ? err.message
              : tMemory("failed")
        )
        return false
      }
    },
    [cwd, tMemory, session]
  )

  const handleSubmit = useCallback(
    async (
      text: string,
      files: SubmittedFile[],
      precomputed?: ReadonlyMap<string, ExtractedAttachment>,
      templateRun?: ChatTemplateRun | null,
      submission?: { replyTo: MessageReplyTo | null },
      route?: TurnRoute | null
    ) => {
      const trimmed = text.trim()
      if (bestOfNCount) {
        if (files.length || route) {
          toast.error(tBestOfN("textOnly"))
          return false
        }
        const started = await requestBestOfN(trimmed, bestOfNCount)
        if (started) setBestOfNChoice(null)
        return started
      }
      // NOTE: `!shell` / `#memory` are NOT detected here any more. They are
      // first-line modes decided from the ORIGINAL input inside `ComposerInner`
      // (see `onSubmitShell` / `onSubmitMemory`); sniffing the prefix off this
      // post-command text meant `/clear\n!ls` executed a shell command.

      if (session?.platformBinding) {
        if (!trimmed && files.length === 0) return false
        const replyTo = submission?.replyTo ?? null
        try {
          await sendManualMessageToConversation({
            session,
            text: trimmed,
            files,
            replyTo,
            templateRun,
          })
          const chatState = useChatStore.getState()
          if (replyTo && selectComposerReplyTo(chatState, session.id) === replyTo) {
            chatState.setReplyTo(null, session.id)
          }
          return true
        } catch (error) {
          toast.error(
            error instanceof UnsupportedPlatformAttachmentsError
              ? tPlatform("attachmentsUnsupported", {
                  platform: tPlatformName.has(error.platform)
                    ? tPlatformName(error.platform)
                    : error.platform,
                })
              : tPlatform("sendFailed")
          )
          return false
        }
      }

      // ── Addressed turn: `@claude` / `@codex` / `@<Squad member>` ─────
      // Checked before anything below consumes a toggle, a chip or a receipt,
      // so a refused route leaves the draft AND everything staged with it in
      // place. The controller re-checks at commit (a lane can change between
      // here and there); this is the check that can still say why, offer the
      // way to fix it, and keep the text in the box.
      if (route) {
        // A live follow-up can only reach the runtime already answering, and
        // queued follow-ups merge into one payload — neither can move a turn.
        // Same verdict the controller's steer gate reaches.
        if (session?.id) {
          const current = sessionStatusOf(session.id)
          if (
            current === "streaming" ||
            current === "awaiting_approval" ||
            isChatTurnQueued(session.id)
          ) {
            toast.error(tRoute("busy", { handle: route.handle }))
            return false
          }
        }
        // `@codex` alone addresses a runtime with nothing to ask it. The token
        // is stripped before the runtime sees the turn, so this would send an
        // empty prompt — or, since stripping refuses to empty a message, the
        // bare handle as the question.
        const afterHandle = trimmed.slice(route.handle.length + 1).trim()
        if (!afterHandle && files.length === 0) {
          toast.error(tRoute("emptyPrompt", { handle: route.handle }))
          return false
        }
        const snapshot = await snapshotRouteContext(session?.id ?? null, {
          providerId:
            session?.providerOverride ??
            useSettingsStore.getState().settings?.defaultProvider ??
            "anthropic",
          session: session ?? null,
        })
        const lane = resolveRouteLane(route.target, snapshot)
        if (!lane.ok) {
          toast.error(tRoute("unavailable", { handle: route.handle }), {
            description: routeFailureText(
              lane,
              { handle: route.handle, name: route.label },
              tRoute,
              tRouteRuntime
            ),
            action: {
              label: tRoute("openSettings"),
              // A missing member is fixed in the Squad; everything else is an
              // external agent to add, enable or repair.
              onClick: () => onOpenSettings(lane.reason === "member-missing" ? "squads" : "agents"),
            },
          })
          return false
        }
      }

      // ── Web search prefetch ─────────────────────────────────────────
      // If the user toggled web search for this turn, run the query through
      // the configured provider before forwarding to the SDK and prepend the
      // formatted results as a system block. We don't fail the send on
      // search errors — fall back to the original message instead.
      // The three things that can ride in front of the typed text. Each is built
      // as its own section and assembled once by `composeTurnText`, which wraps
      // them in the envelope every "what did the user type" reader strips.
      let webSearchSection = ""
      let webSearchContext: SendOptions["webSearchContext"]
      // THIS composer's conversation, matching where `WebSearchToggle` writes
      // it. The bare projection is the focused pane, so an unfocused pane's
      // armed toggle was never consumed (and never cleared, so it stayed lit)
      // while a send from the focused pane ran the search it had armed.
      const webOn = selectComposerWebSearchOn(useChatStore.getState(), session?.id ?? null)
      // The SAME verdict `WebSearchToggle` disables itself on — not a private
      // re-derivation of half of it. `preSearch` also covers the `webTools`
      // kill switch and "is a provider actually configured", so a toggle armed
      // before the user turned web tools off cannot still reach the network.
      const searchSettings = useSettingsStore.getState().settings
      const proactiveSearchEnabled = resolveWebAccess({
        ...(searchSettings?.webTools ? { webTools: searchSettings.webTools } : {}),
        nativeAvailable: false,
        ...(searchSettings?.searchProviders
          ? { searchProviders: searchSettings.searchProviders }
          : {}),
        ...(searchSettings?.defaultSearchProvider
          ? { defaultSearchProvider: searchSettings.defaultSearchProvider }
          : {}),
        ...(searchSettings?.searchEnabled !== undefined
          ? { searchEnabled: searchSettings.searchEnabled }
          : {}),
      }).preSearch
      if (webOn && proactiveSearchEnabled && trimmed) {
        try {
          const resp = await searchWithAppSettings(trimmed)
          webSearchSection = wrapUntrustedContent(formatSearchResultsForLLM(resp))
          webSearchContext = {
            provider: resp.provider,
            results: resp.results.map(({ title, url, content, score }) => ({
              title,
              url,
              content,
              score,
            })),
          }
          pushSystemMessage(
            `🔎 ${tWebSearch("searchedVia", {
              provider: resp.provider,
              count: resp.results.length,
            })}`
          )
        } catch (err) {
          loggers.chat.error("web search failed", err, { query: trimmed })
          toast.error(
            tWebSearch("searchFailed", {
              message: err instanceof Error ? err.message : String(err),
            })
          )
        }
      }
      if (webOn) useChatStore.getState().setWebSearchOnForNextSend(false, session?.id ?? null)

      // ── Context selections ──────────────────────────────────────────
      // Prepend the selected material + comment as context, and record the
      // edit target so the assistant reply routes into a per-hunk review
      // proposal against the targeted artifact. The first selection wins; the
      // rest contribute context only. That is now stated in the UI — the lead
      // chip carries an "edit target" badge and the others promote on click
      // (`artifact-selection-chips.tsx`) — where it used to be a `debug` log
      // nobody would ever see.
      // This pane's staged material, matching the chips that display it and the
      // `clearContextSelections(session?.id)` below. Reading the focused
      // projection here sent the OTHER conversation's file and artifact
      // excerpts in this turn — and cleared selections that were never used.
      const stagedSelections = selectComposerContextSelections(
        useChatStore.getState(),
        session?.id ?? null
      )
      // Last look before the snapshots leave. The chip bar re-checks on focus,
      // but a record edited in the seconds between that and Enter would
      // otherwise be sent as current. The bodies are NOT refreshed — the user
      // approved these — only the divergence is recorded, so
      // `formatContextSelectionsForLLM` can say the copy is behind.
      const contextSelections = (await refreshSelectionFreshness(stagedSelections)).selections
      // Formatted whether or not a conversation exists yet. The block used to be
      // gated on `session?.id`, and the new-chat composer has none — so the chips
      // of a first message were silently dropped and then cleared, which is the
      // main way a conversation gets started FROM a reference.
      const referencesSection = formatContextSelectionsForLLM(contextSelections, {
        sessionId: session?.id ?? null,
      })
      if (contextSelections.length > 0 && session?.id) {
        // The first *artifact*, not the first selection. A file, comment or web
        // reference has nothing for a revision proposal to diff against, so
        // reading index 0 blindly would let a staged workspace file silently
        // disarm the whole review round trip — the AI's reply would then
        // auto-create a duplicate artifact instead of proposing hunks against
        // the one the user was actually working on.
        const primary = contextSelections.find((sel) => sel.kind === "artifact")
        if (primary) {
          useChatStore.getState().setPendingArtifactEditTarget(session.id, {
            artifactId: primary.artifactId,
            requestId: crypto.randomUUID(),
          })
        }
      }

      // ── Review outcomes ─────────────────────────────────────────────
      // Close the revision round trip the block above opens. Rejecting a
      // proposal (or keeping 2 of its 5 hunks) used to be invisible to the
      // assistant, which could then re-propose exactly what the user had just
      // turned down. Read here but consumed only once the send commits, below —
      // the same lifetime as a staged selection — so a receipt rides exactly
      // one message and survives a send that bails before `onSend`.
      const sentReceipts = session?.id
        ? useArtifactStore.getState().peekReviewReceipts(session.id)
        : []
      // Envelopes carried over from a put-back message: what it referenced
      // when it was first sent, re-sent verbatim beside this turn's own.
      const carriedPreambles = selectComposerCarriedPreambles(
        useChatStore.getState(),
        session?.id ?? null
      )
      const turn = composeTurnText(text, [
        {
          kind: "reviewReceipts",
          text: sentReceipts.length > 0 ? formatReviewReceiptsForLLM(sentReceipts) : "",
        },
        { kind: "references", text: referencesSection },
        ...carriedPreambleSections(carriedPreambles),
        { kind: "webSearch", text: webSearchSection },
      ])
      const preambleSummary = turn.preamble
        ? mergeCarriedPreambleSummary(
            {
              sections: turn.sections,
              references: contextSelections.map(summarizeSelectionForPreamble),
            },
            carriedPreambles
          )
        : null
      const augmented = turn.text

      const linkContext = await buildLinkContextBlocks(text)
      // `precomputed` makes this a map lookup for anything already extracted at
      // staging time; files it doesn't cover still extract inline here.
      const attachmentResult = await buildSendContent(augmented, files, {
        precomputed,
        allowNativeVideo: videoRoute.available,
      })
      const content = mergeContextBlocks(attachmentResult.content, linkContext.blocks)
      const rejected = attachmentResult.rejected
      // The envelope counts too. The ceiling used to see attachments and links
      // only, so twenty staged references went out with no confirmation at all.
      const tokens =
        attachmentResult.tokens + linkContext.tokens + estimateFallbackTokens(turn.preamble)
      const isEmpty =
        (typeof content === "string" && !content.trim()) ||
        (Array.isArray(content) && content.length === 0)
      if (rejected.length > 0) {
        toast.error(tAttach("processing.rejected", { count: rejected.length }))
        return false
      }
      if (isEmpty) return true
      if (linkContext.rejected.length > 0) {
        toast.warning(tAttach("linkSkipped", { count: linkContext.rejected.length }))
      }
      // Oversize guard: above the inline-token ceiling we ask the user to
      // confirm before sending — never silently truncate. The promise resolves
      // when they pick an option in the dialog rendered below.
      if (tokens > INLINE_TOKEN_CEILING) {
        const ok = await new Promise<boolean>((resolve) => {
          setOversizeConfirm({ tokens, resolve })
        })
        setOversizeConfirm(null)
        if (!ok) return false
      }
      // The reply target rides this exact turn (ADR-0177 batch 2). Read from
      // THIS pane's conversation and cleared after the send, like the cited
      // refs, so the chip is gone the moment the quoted turn is in the list.
      const replyTo = selectComposerReplyTo(useChatStore.getState(), session?.id ?? null)
      // The standing member pick (ADR-0177 batch 3) rides every send in a
      // team room until the user clears it, so it is read, not consumed.
      const targetMemberIds =
        session?.kind === "team" && session.teamId ? roomTargetsOf(session.id) : []
      // Read from THIS composer's slice, like the chips, and handed over with
      // the turn: the destination conversation of a first message does not
      // exist yet, so the send path cannot find these by looking it up.
      // A picked remote document leaves no token and no chip-bar selection: its
      // citation is bound to the attachment it staged, so it is read off the
      // files this turn actually submits. A chip removed before sending, or an
      // extraction that was rejected, therefore cites nothing.
      const citations = mergeContextRefs(
        [
          ...citationsForSelections(contextSelections),
          ...attachmentCitations.citationsFor(files, precomputed),
        ],
        selectComposerCitedRefs(useChatStore.getState(), session?.id ?? null)
      )
      const turnMetadata: ComposerTurnMetadata = {
        ...(webSearchContext ? { webSearchContext } : {}),
        ...(replyTo ? { replyTo } : {}),
        ...(targetMemberIds.length > 0 ? { targetMemberIds } : {}),
        ...(preambleSummary ? { promptPreamble: preambleSummary } : {}),
        ...(citations.length > 0 ? { citations } : {}),
        ...(route ? { route } : {}),
      }
      const outcome =
        Object.keys(turnMetadata).length > 0
          ? await onSend(content, attachmentResult.manifest, templateRun, turnMetadata)
          : await onSend(content, attachmentResult.manifest, templateRun)
      if (outcome === false) return false
      if (citations.length > 0) {
        // `kinds` is a sorted set joined with `+` — an enum-shaped string like
        // `entity+file`, never a title or anything the user typed.
        const kinds = [...new Set(citations.map((ref) => ref.kind))].sort().join("+")
        void trackEvent("chat.reference.sent", {
          kinds,
          staleCount: contextSelections.filter((sel) => sel.kind === "entity" && sel.stale).length,
        })
      }
      if (replyTo) useChatStore.getState().setReplyTo(null, session?.id ?? null)
      if (session?.kind === "team" && session.teamId) clearComposerTyping(session.id)
      clearReferencedPaths(session?.id ?? null)
      clearContextSelections(session?.id ?? null)
      useChatStore.getState().clearCarriedPreambles(session?.id ?? null)
      // Same lifetime as the chips they describe: the citations rode exactly
      // this message. Cleared AFTER `onSend` so the controller has already read
      // them into `metadata.mentions`.
      clearCitedRefs(session?.id ?? null)
      useArtifactStore.getState().consumeReviewReceipts(sentReceipts)
      return true
    },
    [
      onSend,
      bestOfNCount,
      requestBestOfN,
      tBestOfN,
      clearReferencedPaths,
      clearCitedRefs,
      clearContextSelections,
      pushSystemMessage,
      tAttach,
      tPlatform,
      tPlatformName,
      tWebSearch,
      session,
      videoRoute.available,
      attachmentCitations,
      tRoute,
      tRouteRuntime,
      onOpenSettings,
    ]
  )

  const promptStatus: PromptStatus =
    commandProgress || status === "streaming" || status === "awaiting_approval"
      ? "streaming"
      : status === "error"
        ? "error"
        : "ready"

  return (
    <div
      ref={setRootEl}
      // The anchor the composer's popovers resolve their collision boundary
      // from (`COMPOSER_ROOT_ATTRIBUTE` in `composer/composer-popover-boundary.ts`).
      data-composer-root=""
      data-composer-session={session?.id}
      data-placement={placement}
      // `composer-scrim` (app/globals.css §4d) owns the fade from the message
      // list into the input box. It replaces a Tailwind gradient +
      // `data-tonality="glass"` pair that could not compose: the tonality rules
      // swap `background-color`, and the gradient is a `background-image`, so
      // the opaque slab won and the composer stopped matching the message area
      // as soon as a wallpaper was active.
      className={cn(
        "@container/composer shrink-0",
        // Docked: the scrim fades the message list into the box, and the top
        // padding separates them. Kept tight (8px, 12px from `sm`): the list
        // already ends on its own small gap, and the run strip docks straight
        // onto the box, so list → strip → input reads as one unit rather than
        // three bands with air between them. In the hero there is no list
        // above — the scrim would paint a gradient across the middle of an
        // empty page, and the dock padding would push the box off the
        // vertical centre.
        placement === "docked" && "composer-scrim pb-3 pt-2 sm:pb-4 sm:pt-3"
      )}
    >
      {/* Padding lives INSIDE the max-width cap so the composer box and the
          message text share one content edge. With the padding on the bar
          instead, the cap measured the padded box and the composer ran 20px
          wider per side than the messages above it on any pane past ~872px
          (see `message-list.tsx`'s reading column, which caps then pads). */}
      <div className={chatDockColumnClass} data-slot="composer-reading-column">
        {/* Scope the shared hover delay to the composer: every tooltip on the
            box, its toolbar, and the detached toolbar row waits 500ms before
            opening, so a pointer sweeping the strip no longer fires a wall of
            instant popovers. The app-level provider stays at its default. */}
        <TooltipProvider delayDuration={500}>
          <PromptInputProvider>
            {/* Owns per-attachment extraction / order / OCR opt-in. Must sit INSIDE
              the prompt-input provider: it derives everything from that
              provider's file list. */}
            <StagedAttachmentsProvider
              motion={!session?.platformBinding}
              originalFiles={supportsQQOriginalFiles(session)}
            >
              {session?.platformBinding && (
                <div className="mb-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                  <PlatformBadge platform={session.platformBinding.platform} />
                  <span className="min-w-0 flex-1 truncate">
                    {tPlatform("destination", {
                      platform: tPlatformName.has(session.platformBinding.platform)
                        ? tPlatformName(session.platformBinding.platform)
                        : session.platformBinding.platform,
                      destination: session.title ?? session.platformBinding.conversationKey,
                    })}
                  </span>
                  <PlatformReplyAssistance key={session.id} session={session} disabled={disabled} />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setDraftDialogOpen(true)}
                  >
                    {tPlatform("reviewDrafts", { count: pendingDrafts.length })}
                  </Button>
                  <CannedResponsePicker
                    conversationKey={session.platformBinding.conversationKey}
                    context={{
                      conversation: {
                        title: session.title,
                        platform: session.platformBinding.platform,
                      },
                      contact: { platform: session.platformBinding.platform },
                    }}
                  />
                  <InboxComposerActionsHost
                    conversationKey={session.platformBinding.conversationKey}
                    adapterId={session.platformBinding.adapterId}
                    platform={session.platformBinding.platform}
                    sessionId={session.id}
                    className="flex shrink-0 items-center gap-1 empty:hidden"
                  />
                </div>
              )}
              {commandProgress && (
                <div className="flex items-center gap-3 px-3 py-2 text-sm">
                  <div role="status" className="min-w-0 flex-1" aria-live="polite">
                    <span className="block truncate">
                      {commandProgress.message ||
                        tCommands("running", { command: commandProgress.command })}
                    </span>
                    {commandProgress.value !== undefined && (
                      <Progress
                        className="h-1 w-full"
                        aria-label={tCommands("progress", { command: commandProgress.command })}
                        value={commandProgress.value * 100}
                      />
                    )}
                  </div>
                  <Button type="button" size="sm" variant="ghost" onClick={cancelPluginCommand}>
                    {tCommands("cancel")}
                  </Button>
                </div>
              )}
              <ExternalAgentExtensionUi chatSessionId={session?.id} link={externalSessionLink}>
                <ComposerInner
                  externalSessionLink={externalSessionLink}
                  session={session}
                  videoRoute={videoRoute}
                  imageInput={imageInput}
                  status={promptStatus}
                  canResume={canResume}
                  onResume={handleResume}
                  disabled={disabled}
                  onSubmit={handleSubmit}
                  attachmentCitations={attachmentCitations}
                  onStop={commandProgress ? cancelPluginCommand : onStop}
                  commandRunning={!!commandProgress}
                  onCommand={handleSlashCommand}
                  onSubmitMemory={handleMemorySubmit}
                  onSubmitShell={handleBashSubmit}
                  onOpenCheatsheet={() => setCheatsheetOpen(true)}
                  onOpenSettings={onOpenSettings}
                  pendingDraftCount={session?.platformBinding ? pendingDrafts.length : 0}
                  onReviewDrafts={openDraftReview}
                  handleRef={ref}
                  placeholder={
                    session?.platformBinding
                      ? tPlatform("destination", {
                          platform: tPlatformName.has(session.platformBinding.platform)
                            ? tPlatformName(session.platformBinding.platform)
                            : session.platformBinding.platform,
                          destination: session.title ?? session.platformBinding.conversationKey,
                        })
                      : placeholder
                  }
                  disabledPlaceholder={disabledPlaceholder}
                  workflowMention={workflowMention}
                  routing={routing}
                  placeholderHints={placeholderHints}
                  compactLayout={compactLayout}
                  skin={skin}
                  runStatus={runStatus}
                  toolbar={
                    // The skin decides WHERE the status row sits. `detached` keeps
                    // it below the box (today's desktop default); every other
                    // arrangement puts it inside, and the toolbar itself decides
                    // how much of the roster is spelled out vs. folded. A host
                    // `toolbar` always renders inside the box, ahead of it.
                    toolbar || toolbarInBox ? (
                      <>
                        {toolbar}
                        {toolbarInBox ? (
                          <BottomToolbar
                            bestOfN={bestOfNControl}
                            session={session ?? null}
                            status={status}
                            variant={
                              skin.toolbarLayout === "detached" ? "embedded" : skin.toolbarLayout
                            }
                            onOpenProviderSettings={openProviderSettings}
                          />
                        ) : null}
                      </>
                    ) : null
                  }
                />
              </ExternalAgentExtensionUi>
              {toolbarInBox ? null : (
                <BottomToolbar
                  bestOfN={bestOfNControl}
                  session={session ?? null}
                  status={status}
                  onOpenProviderSettings={openProviderSettings}
                />
              )}
              <HelperHints onOpenCheatsheet={() => setCheatsheetOpen(true)} />
            </StagedAttachmentsProvider>
          </PromptInputProvider>
        </TooltipProvider>
      </div>

      {bestOfNStart && (
        <BestOfNStartDialog
          key={bestOfNStart.prepared.requestId}
          prepared={bestOfNStart.prepared}
          onCancel={() => {
            bestOfNStart.resolve(false)
            setBestOfNStart(null)
          }}
          onConfirm={async (target, agents) => {
            const { startPreparedBestOfN } = await import("@/lib/best-of-n/entry")
            await startPreparedBestOfN(bestOfNStart.prepared, target, agents)
            setBestOfNChoice(null)
            bestOfNStart.resolve(true)
            setBestOfNStart(null)
          }}
        />
      )}
      <ComposerCheatsheet open={cheatsheetOpen} onOpenChange={setCheatsheetOpen} />

      {/* Draft review dialog — shown when the session has pending connector drafts */}
      <Dialog open={draftDialogOpen} onOpenChange={setDraftDialogOpen}>
        <DialogContent className="max-w-lg sm:max-w-lg max-w-[calc(100vw-2rem)]">
          <DialogHeader>
            <DialogTitle>{tDraftReview("title")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {pendingDrafts.length === 0 ? (
              <p className="text-sm text-muted-foreground">{tDraftReview("noPendingDrafts")}</p>
            ) : (
              pendingDrafts.map((draft) => (
                <DraftEditor
                  key={draft.id}
                  draft={draft}
                  onClose={() => setDraftDialogOpen(false)}
                />
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Oversize attachment confirmation — large inlined documents (decision:
          warn + confirm, never silently truncate). */}
      <AlertDialog
        open={oversizeConfirm !== null}
        onOpenChange={(next) => {
          if (!next) oversizeConfirm?.resolve(false)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tAttach("oversizeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {tAttach("oversizeBody", {
                tokens: Math.round((oversizeConfirm?.tokens ?? 0) / 1000),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => oversizeConfirm?.resolve(false)}>
              {tAttach("oversizeCancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => oversizeConfirm?.resolve(true)}>
              {tAttach("oversizeConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
})

/**
 * Memoized: a chat pane re-renders on streamed tokens and run status, and the
 * Composer re-rendered with it — `ComposerInner`'s ~3,000 lines and the
 * toolbar's layout reads — though nothing it was given had changed. Its own
 * state and store subscriptions still update it.
 */
export const Composer = memo(ComposerWithRef)
