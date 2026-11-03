/**
 * @jest-environment jsdom
 */

import type { SkillValidationError } from "@cognia/agent-config-types"
import type { SkillResourceDraft } from "@/lib/db/skill-resources"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: () => false,
}))

// The host-skills predicates, not `isTauri()`, decide whether the native-sync
// control is live: the commands behind it are remote-reachable, so a browser or
// phone driving a paired Host can use it.
const hostSkillsRef = { read: false, write: false }
jest.mock("@/lib/skills/sync", () => ({
  canReadHostSkills: () => hostSkillsRef.read,
  canWriteHostSkills: () => hostSkillsRef.write,
}))

const checkAllMock = jest.fn(async () => 0)
jest.mock("@/hooks/skills", () => ({
  useSkillSync: () => ({ busy: false, push: jest.fn(), pull: jest.fn(), pushOne: jest.fn() }),
  useSkillUpdate: () => ({
    statuses: {},
    checkAll: checkAllMock,
    updateOne: jest.fn(),
    checking: false,
    updatingId: null,
    hasUpdate: () => false,
  }),
}))

jest.mock("@/lib/db/skills", () => ({
  listSkills: jest.fn(async () => []),
}))

jest.mock("@/lib/files/file-bridge", () => ({
  pickAndReadFiles: jest.fn(async () => []),
  pickAndReadBinaryFiles: jest.fn(async () => []),
  pickDirectory: jest.fn(async () => null),
}))

jest.mock("@/lib/skills/bundle/loader", () => ({
  loadBundle: jest.fn(),
}))

jest.mock("@/lib/claude/skills-io", () => ({
  parseSkillMarkdown: jest.fn(),
  nameFromFilename: (s: string) => s,
}))

jest.mock("@/lib/claude/ipc", () => ({
  scanClaudeSkills: jest.fn(async () => []),
}))

jest.mock("@/lib/skills/export-toast", () => ({
  exportSkillsToDirWithFeedback: jest.fn(),
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}))

import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"
import { useSkillsStore } from "@/stores/skills"
import { pickAndReadBinaryFiles } from "@/lib/files/file-bridge"
import { loadBundle } from "@/lib/skills/bundle/loader"
import {
  __resetRecorderAvailabilityForTesting,
  setRecorderAvailability,
} from "@/lib/skills/recording/recorder-availability"
import { useRecorderStore } from "@/stores/skills/recorder-store"
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useSkillPanelToolbar } from "./skill-panel-toolbar"

/** The hook only means something inside the header that draws it. */
function ToolbarInHeader() {
  const toolbar = useSkillPanelToolbar()
  return (
    <FeaturePageHeader
      title="skills"
      actions={toolbar.importMenu}
      secondaryActions={toolbar.secondaryActions}
      overflowActions={toolbar.overflowActions}
      primaryAction={toolbar.primaryAction}
    />
  )
}

function SkillPanelToolbar() {
  return (
    <TooltipProvider>
      <ToolbarInHeader />
    </TooltipProvider>
  )
}

const mockPickAndReadBinaryFiles = pickAndReadBinaryFiles as jest.MockedFunction<
  typeof pickAndReadBinaryFiles
>
const mockLoadBundle = loadBundle as jest.MockedFunction<typeof loadBundle>

beforeEach(() => {
  jest.clearAllMocks()
  useSkillsStore.setState({ importStaging: null })
  hostSkillsRef.read = false
  hostSkillsRef.write = false
})

describe("useSkillPanelToolbar", () => {
  it("renders the 'New' and 'Import' triggers with localized labels", () => {
    render(<SkillPanelToolbar />)
    expect(screen.getByText("new")).toBeInTheDocument()
    expect(screen.getByText("import")).toBeInTheDocument()
  })

  it("makes New the header's primary button, drawn last", async () => {
    const user = userEvent.setup()
    render(<SkillPanelToolbar />)
    const strip = screen.getByTestId("feature-header-actions")
    expect(strip.lastElementChild).toHaveAttribute("data-testid", "skill-panel-toolbar-new")
    await user.click(screen.getByTestId("skill-panel-toolbar-new"))
    expect(useSkillsStore.getState().editorTarget).toEqual({ mode: "create" })
    useSkillsStore.setState({ editorTarget: null })
  })

  it("offers native push and pull to a client whose host serves its skills directory", async () => {
    hostSkillsRef.read = true
    hostSkillsRef.write = true
    const user = userEvent.setup()
    render(<SkillPanelToolbar />)
    await user.click(screen.getByLabelText("moreActions"))

    expect(await screen.findByTestId("skill-panel-toolbar-sync-push")).not.toHaveAttribute(
      "data-disabled"
    )
    expect(screen.getByTestId("skill-panel-toolbar-sync-pull")).not.toHaveAttribute("data-disabled")
  })

  it("greys out push and pull when the host cannot serve skills", async () => {
    // The reason is spelled out in the preferences popover's sync note
    // (`SkillSyncTargets`), next to the mirror targets.
    const user = userEvent.setup()
    render(<SkillPanelToolbar />)
    await user.click(screen.getByLabelText("moreActions"))

    expect(await screen.findByTestId("skill-panel-toolbar-sync-push")).toHaveAttribute(
      "data-disabled"
    )
    expect(screen.getByTestId("skill-panel-toolbar-sync-pull")).toHaveAttribute("data-disabled")
    expect(screen.queryByTestId("skill-panel-toolbar-mirror-claude")).not.toBeInTheDocument()
  })

  it("keeps the occasional actions in the header's overflow menu at every width", async () => {
    const user = userEvent.setup()
    render(<SkillPanelToolbar />)
    // Nothing but New and Import (and the recorder, when present) stays inline.
    expect(screen.queryByTestId("skill-panel-toolbar-export-all")).not.toBeInTheDocument()
    const more = screen.getByLabelText("moreActions")
    expect(more).not.toHaveClass("md:hidden")
    await user.click(more)
    expect(await screen.findByTestId("skill-panel-toolbar-export-all")).toBeInTheDocument()
    expect(screen.getByTestId("skill-panel-toolbar-check-updates")).toBeInTheDocument()
    expect(screen.getByTestId("skill-panel-toolbar-empty-trash")).toBeInTheDocument()
    // Outside Tauri there is no trash to empty.
    expect(screen.getByTestId("skill-panel-toolbar-empty-trash")).toHaveAttribute("data-disabled")
  })

  async function checkUpdates() {
    const user = userEvent.setup()
    render(<SkillPanelToolbar />)
    await user.click(screen.getByLabelText("moreActions"))
    await user.click(await screen.findByTestId("skill-panel-toolbar-check-updates"))
  }

  it("'Check for updates' runs the scan and reports the up-to-date toast", async () => {
    checkAllMock.mockResolvedValueOnce(0)
    await checkUpdates()
    await waitFor(() => expect(checkAllMock).toHaveBeenCalled())
    expect(toast.info).toHaveBeenCalledWith("updatesNone")
  })

  it("'Check for updates' reports the found-count toast when updates exist", async () => {
    checkAllMock.mockResolvedValueOnce(3)
    await checkUpdates()
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('updatesFound:{"count":3}'))
  })

  it("'Check for updates' surfaces scan failures as an error toast", async () => {
    checkAllMock.mockRejectedValueOnce(new Error("offline"))
    await checkUpdates()
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('updatesError:{"error":"offline"}')
    )
  })

  it("exposes the Install-from-URL entry inside the Import menu", async () => {
    const user = userEvent.setup()
    render(<SkillPanelToolbar />)
    await user.click(screen.getByText("import"))
    const item = await screen.findByTestId("skill-panel-toolbar-install-from-url")
    await user.click(item)
    expect(useSkillsStore.getState().urlInstallOpen).toBe(true)
    useSkillsStore.setState({ urlInstallOpen: false })
  })

  it("stages every portable bundle field when importing a zip", async () => {
    const user = userEvent.setup()
    const bytes = new Uint8Array([1, 2, 3])
    const resources: Array<Omit<SkillResourceDraft, "skillId">> = [
      {
        name: "run.sh",
        path: "scripts/run.sh",
        content: "echo ok",
        encoding: "utf-8",
        kind: "script",
      },
    ]
    const validationErrors: SkillValidationError[] = [
      {
        severity: "portability",
        code: "unknown",
        message: "Review compatibility",
      },
    ]
    mockPickAndReadBinaryFiles.mockResolvedValueOnce([{ name: "portable.zip", path: "", bytes }])
    mockLoadBundle.mockResolvedValueOnce({
      draft: {
        name: "Portable Skill",
        slug: "portable-skill",
        description: "Portable description",
        compatibility: "Requires git",
        metadata: { owner: "Cognia" },
        invocationPolicy: "explicit",
        frontmatterExtensions: { custom: { enabled: true } },
        codexOpenAiYaml: "interface:\n  display_name: Portable Skill\n",
        content: "# Portable Skill",
        tags: ["portable"],
        allowedTools: ["Read"],
        category: "productivity",
      },
      resources,
      flavor: "codex",
      nonFatalValidationErrors: validationErrors,
      warnings: [],
    })

    render(<SkillPanelToolbar />)
    await user.click(screen.getByText("import"))
    await user.click(await screen.findByTestId("skill-panel-toolbar-import-bundle-zip"))

    await waitFor(() => expect(useSkillsStore.getState().importStaging).not.toBeNull())
    expect(mockLoadBundle).toHaveBeenCalledWith({
      kind: "zip-blob",
      bytes,
      fallbackName: "portable",
    })
    expect(useSkillsStore.getState().importStaging).toEqual({
      drafts: [
        {
          name: "Portable Skill",
          slug: "portable-skill",
          description: "Portable description",
          compatibility: "Requires git",
          metadata: { owner: "Cognia" },
          invocationPolicy: "explicit",
          frontmatterExtensions: { custom: { enabled: true } },
          codexOpenAiYaml: "interface:\n  display_name: Portable Skill\n",
          content: "# Portable Skill",
          tags: ["portable"],
          allowedTools: ["Read"],
          category: "productivity",
          canonicalId: "bundle:zip:portable-skill",
          resources,
          validationErrors,
        },
      ],
      sourceLabel: "portable.zip",
      parseErrors: [],
      flavor: "codex",
    })
  })
})

describe("the Record Skill entry", () => {
  beforeEach(() => {
    __resetRecorderAvailabilityForTesting()
    useRecorderStore.getState().reset()
  })

  it("is absent until the owning plugin publishes", () => {
    // Gated on the plugin, not on `isTauri()`: the plugin holds the native
    // grants, so disabling it must take every entry point with it.
    render(<SkillPanelToolbar />)
    expect(screen.queryByText("entry.toolbarButton")).not.toBeInTheDocument()
  })

  it("appears once the plugin publishes, and opens the global recorder", async () => {
    setRecorderAvailability({ available: true, pluginId: "cognia-skill-recorder" })
    render(<SkillPanelToolbar />)
    await userEvent.click(screen.getByText("entry.toolbarButton"))
    expect(useRecorderStore.getState().sheetOpen).toBe(true)
    expect(useRecorderStore.getState().phase).toBe("setup")
  })

  it("disappears again when the plugin is turned off", async () => {
    setRecorderAvailability({ available: true, pluginId: "cognia-skill-recorder" })
    render(<SkillPanelToolbar />)
    await act(async () => {
      setRecorderAvailability({ available: false, pluginId: null })
    })
    expect(screen.queryByText("entry.toolbarButton")).not.toBeInTheDocument()
  })
})
