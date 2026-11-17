"use client"
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
  selectComposerReplyTo,
  useChatStore,
  useComposerEphemeralSkillIds,
  useComposerPermissionMode,
  type ChatStatus as StoreChatStatus,
} from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import type { ContextRef } from "@/lib/chat/mentions/types"
import {
  COMPOSER_APPEND_EVENT,
  composerAppendHasContent,
  type ComposerAppendDetail,
} from "@/lib/chat/composer-append"
import type { SendContent, ChatSession, MessageReplyTo } from "@cognia/agent-config-types"
import {
  type AttachmentManifestEntry,
  type ExtractedAttachment,
  type SubmittedFile,
} from "@/lib/chat/attachments/dispatch"
import type { NativeVideoVerdict } from "@/lib/chat/attachments/video/delivery-gate"
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
import { cn } from "@/lib/utils"
import { findPastePlaceholders } from "@/lib/paste-collapse"
import { usePlatform } from "@/hooks/use-platform"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"
import { useSoftKeyboardDevice } from "@/hooks/ui/use-keyboard-insets"
import { useComposerKeyboardAvoidance } from "./composer/use-composer-keyboard-avoidance"
import { useCoarsePointer } from "@/hooks/ui/use-pointer"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { TooltipProvider } from "@/components/ui/tooltip"
import { type ComposerWorkflowMention } from "./composer-trigger"
import {
  createAttachmentCitations,
  type AttachmentCitations,
} from "@/lib/chat/mentions/attachment-citations"
import { ComposerPopover, type ComposerPopoverHandle } from "./composer-popover"
import { usePluginSlashCommandExecution } from "@/hooks/chat/use-plugin-slash-commands"
import { useEffectiveCwd } from "@/hooks/chat/use-effective-cwd"
import { parseLeadingRoute } from "@/lib/chat/turn-route/parse"
import { type TurnRoute } from "@/lib/chat/turn-route/types"
import { ContextChipBar } from "./composer/context-chip-bar"
import { CommandHintBar } from "./composer/command-hint-bar"
import { ScheduleSuggestion } from "./composer/schedule-suggestion"
import { resolveSendButton } from "./composer/send-button-mode"
import { canContinueChat, lastUserMessage } from "@/lib/chat/continuation"
import { selectVisibleMessages } from "@/stores/chat"
import { readTurnRoute } from "@/lib/chat/turn-route/types"
import { useOpenGoal } from "@/components/goal/use-active-goal"
import { ComposerCheatsheet } from "./composer/composer-cheatsheet"
import { canEnqueueInboxWrite, useInboxWriteReadiness } from "@/lib/connectors/inbox-writes"
import { listPendingForConversation as listPendingDrafts } from "@/lib/db/connector-drafts"
import { DraftEditor } from "@/components/inbox/draft-editor"
import { PlatformReplyAssistance } from "./composer/platform-reply-assistance"
import { PlatformBadge } from "@/components/inbox/platform-badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  type SettingsTab,
  type SlashCommand,
  type SlashStagedFiles,
} from "@/lib/slash-commands/builtin"
import {
  DIAGNOSTICS_PART_TYPE,
  type SystemMessageBlock,
  type SlashCommandResultBlock,
} from "@/lib/slash-commands/system-blocks"
import { type ChatTemplateRun } from "@/lib/chat/template/run"
import { TemplateParamPopover } from "./composer/template-param-popover"
import { SaveAsTemplateDialog } from "./composer/save-as-template-dialog"
import { TemplateLaunchDiffBar } from "./template-launch-diff-bar"
import { type CommandError } from "@/lib/slash-commands/run-segments"
import { type ComposerMemoryTarget } from "@/lib/chat/memory-target"
import { useComposerCommandStore } from "@/stores/chat/composer-command-store"
import { useComposerGhostText } from "@/hooks/chat/use-composer-ghost-text"
import { FollowUpSuggestions } from "./follow-up-suggestions"
import type { InlineCommandInfo } from "@/lib/chat/completion/inline/types"
import { useLatestTextInput } from "./composer/hooks/use-latest-text-input"
import { useInputHistory } from "./composer/hooks/use-input-history"
import { CommandParamForm } from "./composer/command-param-form"
import { useShellContext } from "@/hooks/chat/use-shell-intelligence"
import { useShellJobCopy } from "./shell-job/use-shell-job-copy"
// `rememberFact` is imported lazily at its call site, not here: it pulls in the
// Dexie session schema and the redaction package, which every composer test
// otherwise has to mock just to render the box.
import { useUpdateSession } from "@/lib/data-hooks/context"
import { loggers } from "@cognia/logging"
import { type DraftAttachmentMeta } from "@/lib/db/chat-drafts"
import {
  useExternalSessionLinkForSession,
  useRuntimeRefForSession,
} from "@/stores/agent/agent-runtime-store"
import { ExternalAgentExtensionUi } from "@/components/agent/external/extension-ui"
import { useSidechatShortcut } from "@/hooks/chat/use-sidechat-shortcut"
import { DraftRestoredAttachments } from "./composer/draft-restored-attachments"
import { OcrResultBubble } from "./composer/ocr-result-bubble"

import { mobileTransition, useReducedMotionTransition } from "@/lib/ui/motion"
import { BestOfNStartDialog } from "./composer/best-of-n-start-dialog"
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
import { noteComposerTyping } from "@/stores/chat/composer-typing-store"
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
import { useComposerOcr } from "./composer/hooks/use-composer-ocr"
import { useComposerMentionSources } from "./composer/hooks/use-composer-mention-sources"
import { useComposerCustomCommands } from "./composer/hooks/use-composer-custom-commands"
import { useComposerSlashCommands } from "./composer/hooks/use-composer-slash-commands"
import { useComposerTemplates } from "./composer/hooks/use-composer-templates"
import { useComposerShellMode } from "./composer/hooks/use-composer-shell-mode"
import { useComposerSegments } from "./composer/hooks/use-composer-segments"
import { useComposerTrigger } from "./composer/hooks/use-composer-trigger"
import { useComposerPopoverActions } from "./composer/hooks/use-composer-popover-actions"
import { runComposerSubmit } from "./composer/composer-submit"
import { handleComposerKeyDown } from "./composer/composer-keydown"
import { useComposerDraftLifecycle } from "./composer/hooks/use-composer-draft-lifecycle"
import {
  runComposerSlashCommand,
  runComposerShellSubmit,
  runComposerMemorySubmit,
  runComposerTurn,
} from "./composer/composer-turn-handlers"
import { useComposerBestOfN } from "./composer/hooks/use-composer-best-of-n"
import { useComposerSuggestions } from "./composer/hooks/use-composer-suggestions"
import { useComposerPillEditing } from "./composer/hooks/use-composer-pill-editing"

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

// --- Inner box with full state wiring --------------------------------------

/** What `ComposerInner` receives from the `Composer` wrapper (its hooks read these fields). */
export interface ComposerInnerProps {
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

function ComposerInner(props: ComposerInnerProps) {
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
  const submit = useCallback(
    async (): Promise<boolean> =>
      runComposerSubmit({
        props,
        tCommands,
        tMemory,
        tTemplateParams,
        nativeMobile,
        softKeyboard,
        outboundBlocked,
        clearAfterSendEnabled,
        textInput,
        attachments,
        staged,
        textareaRef,
        setTurnInFlight,
        setFollowUpInFlight,
        turnInFlightRef,
        followUpInFlightRef,
        setCaret,
        setRestoredAttachments,
        attachmentPrepareCountRef,
        setPastedBlocks,
        pastedBlocks,
        setCommandErrors,
        sessionId,
        currentDraftRef,
        memoryFilesAccess,
        tBestOfN,
        commandMap,
        foldedLinks,
        setFoldedLinks,
        segments,
        setActiveParamId,
        paramIds,
        effectiveBinding,
        paramDeclarations,
        paramTokens,
        noteCommandUsed,
        history,
        routeOf,
        localActionInFlightRef,
        acceptedPredictionRef,
        pendingAutoSendRef,
      }),
    [
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
    ]
  )
  const { acceptGhost, predictionEligible, prediction, acceptPrediction } = useComposerSuggestions({
    outboundBlocked,
    persistDrafts,
    textValue,
    textInput,
    attachments,
    textareaRef,
    turnInFlight,
    followUpInFlight,
    turnInFlightRef,
    followUpInFlightRef,
    setCaret,
    isComposing,
    draftHydratedFor,
    restoredAttachments,
    attachmentPrepareCountRef,
    sessionId,
    ghost,
    acceptedPredictionRef,
    submit,
    props,
  })
  const { stepToParam, deletePillAtCaret } = useComposerPillEditing({
    textInput,
    textareaRef,
    setCaret,
    overlaySegments,
    setActiveParamId,
    paramTokens,
    completionTrigger,
  })

  // Local handles so the key handler depends on the specific props it reads,
  // not the whole `props` object (react-hooks/exhaustive-deps).
  const turnStatus = props.status
  const onStopTurn = props.onStop
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) =>
      handleComposerKeyDown(
        {
          props,
          sendOnEnter,
          inputHistoryRecall,
          textInput,
          textareaRef,
          activeHintRef,
          popoverRef,
          setCaret,
          isComposing,
          setPermissionMode,
          permissionMode,
          setActiveParamId,
          paramTokens,
          activeParamId,
          history,
          ghost,
          completionTrigger,
          markShellSubmitted,
          dismissPopover,
          submit,
          acceptGhost,
          predictionEligible,
          prediction,
          acceptPrediction,
          stepToParam,
          deletePillAtCaret,
          turnStatus,
          onStopTurn,
        },
        e
      ),
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
  useComposerDraftLifecycle({
    tCommands,
    persistDrafts,
    textValue,
    textInput,
    attachments,
    staged,
    attachmentCitations,
    textareaRef,
    turnInFlight,
    followUpInFlight,
    isComposing,
    draftHydratedFor,
    setDraftHydratedFor,
    setRestoredAttachments,
    setPastedBlocks,
    acceptFiles,
    sessionId,
    foldedLinks,
    setFoldedLinks,
    setTemplateBinding,
    setPendingLaunchSpec,
    setActiveParamId,
    effectiveBinding,
    pendingAutoSendRef,
    submit,
    props,
  })

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
  const {
    requestBestOfN,
    setBestOfNChoice,
    bestOfNCount,
    bestOfNControl,
    bestOfNStart,
    setBestOfNStart,
  } = useComposerBestOfN({ session, disabled, status, tBestOfN })
  const openProviderSettings = useCallback(() => onOpenSettings("api-key"), [onOpenSettings])

  const handleSlashCommand = useCallback(
    async (cmd: SlashCommand, args: string, staged?: SlashStagedFiles): Promise<boolean> =>
      runComposerSlashCommand(
        {
          session,
          onStartNewSession,
          onOpenSettings,
          tCommands,
          isMobileShell,
          status,
          setPermissionMode,
          pushSystemMessage,
          runPluginCommand,
          tBestOfN,
          requestBestOfN,
        },
        cmd,
        args,
        staged
      ),
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
    async (rawCmd: string): Promise<boolean> =>
      runComposerShellSubmit(
        {
          session,
          tShell,
          shellJobCopy,
          shell: { availability: shell.availability, shell: shell.shell },
          cwd,
          pushSystemMessage,
        },
        rawCmd
      ),
    [cwd, pushSystemMessage, tShell, shellJobCopy, session, shell.shell, shell.availability]
  )

  const handleMemorySubmit = useCallback(
    async (target: ComposerMemoryTarget, text: string): Promise<boolean> =>
      runComposerMemorySubmit({ session, tMemory, cwd }, target, text),
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
    ) =>
      runComposerTurn(
        {
          session,
          onOpenSettings,
          onSend,
          tAttach,
          tPlatform,
          tPlatformName,
          tWebSearch,
          tRoute,
          tRouteRuntime,
          videoRoute: { available: videoRoute.available },
          attachmentCitations,
          clearReferencedPaths,
          clearCitedRefs,
          clearContextSelections,
          setOversizeConfirm,
          pushSystemMessage,
          tBestOfN,
          setBestOfNChoice,
          bestOfNCount,
          requestBestOfN,
        },
        text,
        files,
        precomputed,
        templateRun,
        submission,
        route
      ),
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
      setBestOfNChoice,
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
