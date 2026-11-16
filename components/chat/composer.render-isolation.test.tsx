jest.mock("@/hooks/chat/use-follow-up-suggestions", () => ({
  useFollowUpSuggestions: jest.fn(() => ({
    suggestions: [],
    loading: false,
    dismiss: jest.fn(),
    status: "ineligible",
    retry: jest.fn(),
  })),
}))
jest.mock("@/hooks/chat/use-remote-doc-staging", () => ({
  ...jest.requireActual("@/hooks/chat/use-remote-doc-staging"),
  useRemoteDocStaging: jest.fn(
    jest.requireActual("@/hooks/chat/use-remote-doc-staging").useRemoteDocStaging
  ),
}))
jest.mock("@/lib/i18n/runtime-translator", () => ({
  getRuntimeTranslator: async () => (key: string) => key,
}))
jest.mock("@/lib/context-workbench/resource-session", () => ({
  ...jest.requireActual("@/lib/context-workbench/resource-session"),
  ensureResourceWorkbenchSession: jest.fn(),
}))
jest.mock("@/lib/best-of-n/entry", () => ({
  prepareBestOfNChat: jest.fn(async (_sessionId: string, prompt: string, n: number) => ({
    session: {
      id: _sessionId,
      kind: "direct",
      title: "Composer Test Chat",
      createdAt: 0,
      updatedAt: 0,
    },
    requestId: "bon-request",
    prompt,
    n,
    baseSha: "abc",
    dirty: true,
    targetRef: "best-of-n/bon-request",
    branches: ["main"],
    agents: Array.from({ length: n }, () => "session"),
    agentOptions: [{ value: "session", kind: "session", label: "session" }],
  })),
  startPreparedBestOfN: jest.fn(async () => ({ groupId: "bon-group" })),
}))

// Coverage for the data-hooks integration point in composer — the inner
// component now reads `useUpdateSession()` from the adapter and uses it to
// persist permissionMode changes back to the session row. This test mounts
// the full <Composer> with a stub adapter, then drives a permissionMode
// change through the chat-store and asserts the adapter mutation is called.

// Heavy file-system / shell / memory / slash-command modules pull in Tauri
// IPC and disk reads that have no place in a logic-level component test.
jest.mock("@/lib/slash-commands/custom", () => ({
  loadCustomSlashCommands: jest.fn(async () => []),
}))
jest.mock("@/lib/search/search-service", () => ({
  search: jest.fn(),
  formatSearchResultsForLLM: jest.fn(),
}))
jest.mock("@/lib/shell/exec", () => ({
  executeShell: jest.fn(),
  formatShellResult: jest.fn(),
}))
// `!` lines run through the transport-routed one-shot exec now, under the
// user's configured shell — not `shell_exec`'s hard-coded `sh -c` (ADR-0039).
jest.mock("@/lib/terminal/remote-api", () => ({
  ...jest.requireActual("@/lib/terminal/remote-api"),
  execTerminalCommand: jest.fn(async () => ({
    stdout: "ok",
    stderr: "",
    exitCode: 0,
    timedOut: false,
  })),
}))
// A Host has to be reachable for a `!` line to run at all; these cases are
// about WHERE it runs, so the transport is present throughout.
jest.mock("@/lib/terminal/pick-transport", () => ({
  ...jest.requireActual("@/lib/terminal/pick-transport"),
  terminalAvailable: jest.fn(() => true),
}))
// Interactive `!command` routing: control the desktop gate and stub the dock
// spawn so a routed command doesn't hit the real terminal orchestrator.
//
// Mocked at `@/lib/platform/detect`, which is where `isTauri` is DEFINED —
// `@/lib/tauri` only re-exports it, and so does everything else that asks. A
// mock on the re-export left `useShellContext` (which imports the definition)
// answering "no host" in the very cases these tests set up as a desktop, so
// every `!` line refused before it could reach the exec. One process, one
// answer.
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: jest.fn(() => false),
}))
jest.mock("@/lib/terminal/run-in-dock", () => ({
  runInTerminalDock: jest.fn(async () => undefined),
  runInDockTab: jest.fn(async () => ({ kind: "ok" })),
}))
// Desktop-only SDK context-usage hook: with isTauri() flipped on it would fire
// a Tauri IPC that doesn't exist in jsdom. Stub it — it's a display leaf,
// irrelevant to composer logic.
// Counting stub: `GenericBottomToolbar` is its only caller under the Composer,
// so its call count is the toolbar's own render count.
const mockRenders = { toolbar: 0, popoverHooks: 0, composerBox: 0, saveTemplate: 0 }
jest.mock("@/hooks/chat/use-sdk-context-usage", () => ({
  useSdkContextUsage: () => {
    mockRenders.toolbar += 1
    return { snapshot: null, refresh: () => undefined }
  },
}))
// Pass-through counters. The popover's mention search runs once per render of
// the popover's hook-holding body; `ComposerBox` renders once per render of
// `ComposerInner` (its parent, not memoized); the dialog once per render of
// the dialog element.
jest.mock("@/hooks/chat/use-entity-mention-search", () => {
  const actual = jest.requireActual("@/hooks/chat/use-entity-mention-search")
  return {
    ...actual,
    useEntityMentionSearch: (...args: Parameters<typeof actual.useEntityMentionSearch>) => {
      mockRenders.popoverHooks += 1
      return actual.useEntityMentionSearch(...args)
    },
  }
})
jest.mock("./composer/composer-box", () => {
  const actual = jest.requireActual("./composer/composer-box")
  const Counting = (props: Parameters<typeof actual.ComposerBox>[0]) => {
    mockRenders.composerBox += 1
    return actual.ComposerBox(props)
  }
  return { ...actual, ComposerBox: Counting }
})
jest.mock("./composer/save-as-template-dialog", () => {
  const actual = jest.requireActual("./composer/save-as-template-dialog")
  const Counting = (props: Parameters<typeof actual.SaveAsTemplateDialog>[0]) => {
    mockRenders.saveTemplate += 1
    return actual.SaveAsTemplateDialog(props)
  }
  return { ...actual, SaveAsTemplateDialog: Counting }
})
// With isTauri() flipped on, the composer's plugin-quick-actions-menu mounts
// desktop tray hooks that hit Tauri event/subscription IPC absent in jsdom.
// Stub them to static values — they're status leaves, irrelevant here.
jest.mock("@/lib/tray/state-snapshot", () => ({
  useTrayStateSnapshot: () => jest.requireActual("@/lib/tray/sync").defaultSnapshot(),
}))
jest.mock("@/lib/tray/usage", () => ({
  useTrayUsage: () => null,
}))
jest.mock("@tauri-apps/api/event", () => ({
  listen: jest.fn(async () => () => undefined),
  once: jest.fn(async () => () => undefined),
  emit: jest.fn(async () => undefined),
}))
jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(async () => null),
}))
// The attachment dispatch pipeline (token counting / PII / oversize) pulls in
// heavy deps irrelevant to composer logic tests. Stub it so a send reaches the
// `onSend` prop cleanly.
jest.mock("@/lib/chat/attachments/dispatch", () => ({
  buildSendContent: jest.fn(async (text: string) => ({
    content: text,
    rejected: [],
    tokens: 1,
    manifest: [],
  })),
  INLINE_TOKEN_CEILING: 1_000_000,
}))
// Chat-draft persistence hits IndexedDB; stub it so clear-after-send and draft
// hydration are no-ops in the logic test.
jest.mock("@/lib/db/chat-drafts", () => ({
  clearDraft: jest.fn(async () => undefined),
  getDraft: jest.fn(async () => undefined),
  setDraftDebounced: jest.fn(() => undefined),
}))
const trackEventMock = jest.fn()
jest.mock("@/lib/telemetry/events/track-event", () => ({
  trackEvent: (...a: unknown[]) => trackEventMock(...a),
}))
jest.mock("./composer/voice-controls", () => ({
  VoiceControls: () => null,
}))
jest.mock("@/components/inbox/canned-response-picker", () => ({
  CannedResponsePicker: () => <button type="button" data-testid="canned-response-trigger" />,
}))
jest.mock("@/components/inbox/inbox-composer-actions-host", () => ({
  InboxComposerActionsHost: () => null,
}))
// Platform is the gate for the mobile (Capacitor) Claude-style layout. Default
// to "web" so the existing tests keep the desktop/web responsive layout.
jest.mock("@/hooks/use-platform", () => ({ usePlatform: jest.fn(() => "web") }))
jest.mock("@/lib/agents/instructions/append-memory", () => ({
  ...jest.requireActual("@/lib/agents/instructions/append-memory"),
  appendInstructionMemory: jest.fn(async () => "/repo/AGENTS.md"),
}))
// Pass-through spy: the composer's half of soft-keyboard avoidance.
jest.mock("./composer/use-composer-keyboard-avoidance", () => {
  const actual = jest.requireActual("./composer/use-composer-keyboard-avoidance")
  return { useComposerKeyboardAvoidance: jest.fn(actual.useComposerKeyboardAvoidance) }
})
// Layout and pointer are separate questions from the platform (see
// `hooks/ui/use-compact-layout.ts`); each test sets the combination it means.
jest.mock("@/hooks/ui/use-compact-layout", () => ({ useCompactLayout: jest.fn(() => false) }))
jest.mock("@/hooks/ui/use-pointer", () => ({
  ...jest.requireActual("@/hooks/ui/use-pointer"),
  useCoarsePointer: jest.fn(() => false),
}))
// Capacitor wrappers consumed by the mobile send path (haptic on send,
// keyboard dismiss after send). Mocked so the mobile tests can assert calls.
jest.mock("@/lib/capacitor/haptics", () => ({
  __esModule: true,
  impact: jest.fn(),
  notify: jest.fn(),
  selectionFeedback: jest.fn(),
}))
jest.mock("@/lib/capacitor/keyboard", () => ({
  __esModule: true,
  hideKeyboard: jest.fn(async () => undefined),
  showKeyboard: jest.fn(async () => undefined),
}))
jest.mock("@/hooks/use-camera-recovery", () => ({ useCameraRecovery: jest.fn() }))
jest.mock("@/components/mobile/chat/composer-attachment", () => {
  const actual = jest.requireActual("@/components/mobile/chat/composer-attachment")
  return { ...actual, attachmentToFiles: jest.fn(actual.attachmentToFiles) }
})
jest.mock("@/lib/chat/attachments/prepare", () => {
  const actual = jest.requireActual("@/lib/chat/attachments/prepare")
  return { ...actual, prepareComposerAttachments: jest.fn(actual.prepareComposerAttachments) }
})

import { fireEvent, render, screen } from "@testing-library/react"
import { act, useCallback, useState } from "react"
import type { ReactNode } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Composer } from "./composer"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { useProjectStore } from "@/stores/project/project-store"
import { setRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"
import type { ChatSession } from "@cognia/agent-config-types"

/**
 * Render isolation (chat-surface overhaul step 4.7). The draft is
 * `ComposerInner`'s state, so a keystroke must re-render it and the box that
 * shows the text — and nothing that does not depend on the text. A parent
 * re-render that passes the same props (a chat pane re-rendering on a
 * streamed token) must not reach the Composer at all.
 */

const adapter: DataAdapter = {
  useCharacters: () => undefined,
  useCharacter: () => undefined,
  useSkillsByIds: () => undefined,
  usePresets: () => undefined,
  clearMessages: jest.fn(async () => undefined),
  updateSession: jest.fn(async () => undefined),
  recordPresetUsage: jest.fn(async () => undefined),
  trustWorkspace: jest.fn(async () => undefined),
}

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <DataAdapterProvider adapter={adapter}>
      <TooltipProvider>{children}</TooltipProvider>
    </DataAdapterProvider>
  )
}

const session: ChatSession = {
  id: "ses_render",
  title: "Render isolation",
  kind: "direct",
  createdAt: 0,
  updatedAt: 0,
}

function reset() {
  for (const key of Object.keys(mockRenders) as Array<keyof typeof mockRenders>)
    mockRenders[key] = 0
}

beforeEach(() => {
  useChatStore.getState().clear()
  useSettingsStore.setState({ settings: undefined as never })
  useProjectStore.setState({ projects: [], activeProjectId: null, loaded: false })
  setRuntimeSnapshot({ target: null, vaultState: "unavailable", connectionState: "offline" })
})

/** A chat pane: re-renders on its own state, with stable handlers. */
function Pane({ onTick }: { onTick: (tick: () => void) => void }) {
  const [, setTick] = useState(0)
  onTick(() => setTick((value) => value + 1))
  const onOpenSettings = useCallback(() => undefined, [])
  const onStartNewSession = useCallback(async () => undefined, [])
  const onSend = useCallback(async () => undefined, [])
  const onStop = useCallback(() => undefined, [])
  return (
    <Composer
      session={session}
      onStartNewSession={onStartNewSession}
      onOpenSettings={onOpenSettings}
      onSend={onSend}
      onStop={onStop}
    />
  )
}

function mount() {
  let tick!: () => void
  render(
    <Wrapper>
      <Pane onTick={(next) => (tick = next)} />
    </Wrapper>
  )
  return { textarea: screen.getByRole("textbox") as HTMLTextAreaElement, tick: () => tick() }
}

describe("Composer render isolation", () => {
  it("re-renders only the input box on a keystroke", async () => {
    const { textarea } = mount()
    await act(async () => {})
    reset()
    for (const text of ["h", "he", "hel", "hell", "hello", "hello ", "hello w", "hello wo"]) {
      fireEvent.change(textarea, { target: { value: text } })
    }
    await act(async () => {})
    // The measured figures, for the plan's Results table.
    console.info("[composer-renders] keystroke x8", JSON.stringify(mockRenders))
    expect(mockRenders.composerBox).toBeGreaterThanOrEqual(8)
    expect(mockRenders.toolbar).toBe(0)
    expect(mockRenders.popoverHooks).toBe(0)
    expect(mockRenders.saveTemplate).toBe(0)
  })

  it("is not reached by a parent re-render that passes the same props", async () => {
    const { tick } = mount()
    await act(async () => {})
    reset()
    for (let index = 0; index < 10; index++) act(() => tick())
    await act(async () => {})
    // The measured figures, for the plan's Results table.
    console.info("[composer-renders] parent x10", JSON.stringify(mockRenders))
    expect(mockRenders).toEqual({ toolbar: 0, popoverHooks: 0, composerBox: 0, saveTemplate: 0 })
  })

  it("mounts the popover's search hooks once a trigger opens", async () => {
    const { textarea } = mount()
    await act(async () => {})
    reset()
    fireEvent.change(textarea, { target: { value: "@" } })
    await act(async () => {})
    expect(mockRenders.popoverHooks).toBeGreaterThan(0)
  })

  // With the soft keyboard up, `vh` still measures the layout viewport; the
  // band stack is capped by the visible height the keyboard store publishes.
  it("caps the band stack by the visible viewport height", () => {
    mount()
    const region = screen.getByRole("region", { name: "Composer context and notices" })
    expect(region.className).toContain("max-h-[calc(var(--visual-viewport-height,100vh)*0.4)]")
    expect(region.className).not.toContain("max-h-[40vh]")
  })
})
