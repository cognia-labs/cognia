/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("@/components/artifacts/artifact-preview", () => ({
  ArtifactPreview: ({ artifact }: { artifact: { id: string } }) => (
    <div data-testid={`artifact-preview-${artifact.id}`} />
  ),
}))
jest.mock("@/components/artifacts/panel-version-history", () => ({
  PanelVersionHistory: ({ artifact }: { artifact: { id: string } }) => (
    <div data-testid={`artifact-version-history-${artifact.id}`} />
  ),
}))
jest.mock("@/components/canvas/version-history-panel", () => ({
  VersionHistoryPanel: ({
    documentId,
    trigger,
  }: {
    documentId: string
    trigger?: React.ReactNode
  }) => <div data-testid={`canvas-version-history-${documentId}`}>{trigger}</div>,
}))
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))
jest.mock("@/components/chat/message-parts/file-part-preview", () => ({
  FilePartPreview: ({ url, filename }: { url: string; filename: string }) => (
    <div data-testid="file-part-preview" data-url={url} data-filename={filename} />
  ),
}))
jest.mock("./files-image-thumb", () => ({
  FilesImageThumb: ({ hash, full }: { hash: string; full?: boolean }) => (
    <div data-testid={`thumb-${hash}-${full ? "full" : "thumb"}`} />
  ),
}))
jest.mock("@/hooks/data/use-client-live-query", () => ({
  useClientLiveQuery: () => [{ id: "s1", title: "Design chat" }],
}))
jest.mock("@/lib/files-library/download", () => ({ downloadPayloadFor: jest.fn() }))
jest.mock("@/lib/files-library/open", () => ({ goToSession: jest.fn(async () => {}) }))

import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import { downloadPayloadFor } from "@/lib/files-library/download"
import { goToSession } from "@/lib/files-library/open"
import type { FilesEntry } from "@/lib/files-library/types"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { FilesBackendProvider, type FilesBackend } from "@/hooks/files-library/files-backend"
import type { FilesOps } from "@/lib/files-library/ops"
import { FilesRemoteError } from "@/lib/files-library/remote/client"
import { PAIRED_FILES_CAPABILITIES } from "@/lib/files-library/remote/remote-ops"
import { FilesPreviewPane } from "./files-preview-pane"

const payload = downloadPayloadFor as jest.Mock

function entry(overrides: Partial<FilesEntry>): FilesEntry {
  return {
    key: "upload:u1",
    kind: "upload",
    sourceId: "u1",
    title: "notes.md",
    sourceTitle: "notes.md",
    mediaType: "text/markdown",
    byteSize: 12,
    projectIds: [],
    sessionIds: ["s1"],
    originAlive: true,
    createdAt: 1,
    updatedAt: 2,
    ownedByFiles: true,
    hidden: false,
    sharedWithMe: false,
    creator: "user",
    searchText: "",
    ...overrides,
  }
}

function actions() {
  return {
    open: jest.fn(async () => {}),
    useInChat: jest.fn(async () => {}),
    download: jest.fn(async () => {}),
    toggleFavorite: jest.fn(async () => {}),
  } as unknown as jest.Mocked<FilesActions>
}

beforeAll(() => {
  URL.createObjectURL = jest.fn(() => "blob:preview")
  URL.revokeObjectURL = jest.fn()
})
beforeEach(() => payload.mockReset())

it("previews an upload through the chat file preview and lists details and conversations", async () => {
  payload.mockResolvedValue({
    blob: new Blob(["# n"], { type: "text/markdown" }),
    filename: "notes.md",
  })
  const a = actions()
  const e = entry({})
  const onClose = jest.fn()
  const user = userEvent.setup()
  render(<FilesPreviewPane entry={e} actions={a} onClose={onClose} />)
  expect(screen.getByTestId("files-preview-loading")).toBeInTheDocument()
  expect(await screen.findByTestId("file-part-preview")).toHaveAttribute(
    "data-filename",
    "notes.md"
  )
  expect(screen.getByText("text/markdown")).toBeInTheDocument()
  expect(screen.getByText("12 B")).toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: "Design chat" }))
  expect(goToSession).toHaveBeenCalledWith("s1", expect.anything())
  await user.click(screen.getByRole("button", { name: "Open" }))
  await user.click(screen.getByRole("button", { name: "Use in chat" }))
  await user.click(screen.getByRole("button", { name: "Download" }))
  await user.click(screen.getByRole("button", { name: "Add to favorites" }))
  expect(a.open).toHaveBeenCalledWith(e)
  expect(a.useInChat).toHaveBeenCalledWith(e)
  expect(a.download).toHaveBeenCalledWith(e)
  expect(a.toggleFavorite).toHaveBeenCalledWith(e)
  await user.click(screen.getByRole("button", { name: "Close preview" }))
  expect(onClose).toHaveBeenCalled()
})

it("says so when the bytes are gone, and when the conversation was deleted", async () => {
  payload.mockResolvedValue(null)
  render(
    <FilesPreviewPane
      entry={entry({ originAlive: false, favoritedAt: 3 })}
      actions={actions()}
      onClose={jest.fn()}
    />
  )
  expect(await screen.findByTestId("files-preview-unavailable")).toBeInTheDocument()
  expect(screen.getByTestId("files-preview-source-deleted")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Remove from favorites" })).toHaveAttribute(
    "aria-pressed",
    "true"
  )
})

it("leaves the loading state when reading preview bytes fails", async () => {
  payload.mockRejectedValueOnce(new Error("storage read failed"))
  render(<FilesPreviewPane entry={entry({})} actions={actions()} onClose={jest.fn()} />)
  expect(await screen.findByTestId("files-preview-unavailable")).toBeInTheDocument()
  expect(screen.queryByTestId("files-preview-loading")).not.toBeInTheDocument()
})

it("renders images full size and artifacts through the artifact preview", () => {
  useArtifactStore.setState({
    artifacts: {
      a1: {
        id: "a1",
        sessionId: "s1",
        messageId: "m",
        type: "code",
        title: "A",
        content: "x",
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    } as never,
  })
  const { rerender } = render(
    <FilesPreviewPane
      entry={entry({ key: "image:h", kind: "image", sourceId: "h", title: "" })}
      actions={actions()}
      onClose={jest.fn()}
    />
  )
  expect(screen.getByTestId("thumb-h-full")).toBeInTheDocument()
  expect(screen.getByRole("heading", { name: "Untitled image" })).toBeInTheDocument()
  rerender(
    <FilesPreviewPane
      entry={entry({ key: "artifact:a1", kind: "artifact", sourceId: "a1", title: "A" })}
      actions={actions()}
      onClose={jest.fn()}
    />
  )
  expect(screen.getByTestId("artifact-preview-a1")).toBeInTheDocument()
  rerender(
    <FilesPreviewPane
      entry={entry({ key: "artifact:gone", kind: "artifact", sourceId: "gone", title: "G" })}
      actions={actions()}
      onClose={jest.fn()}
    />
  )
  expect(screen.getAllByTestId("files-preview-unavailable").length).toBeGreaterThanOrEqual(1)
})

it("previews a canvas document from its content", async () => {
  useArtifactStore.setState({
    canvasDocuments: {
      c1: {
        id: "c1",
        sessionId: "standalone",
        title: "Doc",
        content: "# d",
        language: "markdown",
        type: "text",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    } as never,
  })
  payload.mockResolvedValue({ blob: new Blob(["# d"]), filename: "Doc.md" })
  render(
    <FilesPreviewPane
      entry={entry({
        key: "canvas:c1",
        kind: "canvas",
        sourceId: "c1",
        title: "Doc",
        mediaType: undefined,
      })}
      actions={actions()}
      onClose={jest.fn()}
    />
  )
  await waitFor(() =>
    expect(screen.getByTestId("file-part-preview")).toHaveAttribute("data-filename", "Doc.md")
  )
})

it("labels a generated video and lists what its job recorded", async () => {
  payload.mockResolvedValue({
    blob: new Blob(["v"], { type: "video/mp4" }),
    filename: "A paper boat.mp4",
  })
  render(
    <FilesPreviewPane
      entry={entry({
        key: "session-upload:v1",
        kind: "session-upload",
        sourceId: "v1",
        title: "A paper boat.mp4",
        mediaType: "video/mp4",
        ownedByFiles: false,
        generated: {
          jobId: "vjob_1",
          prompt: "A paper boat on a rainy street",
          providerId: "doubao",
          modelId: "seedance-1-5-pro",
          durationSec: 5.04,
          width: 1280,
          height: 720,
        },
      })}
      actions={actions()}
      onClose={jest.fn()}
    />
  )
  expect(await screen.findByTestId("file-part-preview")).toBeInTheDocument()
  expect(screen.getByText("Video")).toBeInTheDocument()
  expect(screen.getByTestId("files-preview-prompt")).toHaveTextContent(
    "A paper boat on a rainy street"
  )
  expect(screen.getByText(/· seedance-1-5-pro$/)).toBeInTheDocument()
  expect(screen.getByText("5 s")).toBeInTheDocument()
  expect(screen.getByText("1280 × 720")).toBeInTheDocument()
})

it("lists no generation details for an ordinary upload", async () => {
  payload.mockResolvedValue({ blob: new Blob(["x"]), filename: "notes.md" })
  render(<FilesPreviewPane entry={entry({})} actions={actions()} onClose={jest.fn()} />)
  expect(await screen.findByTestId("file-part-preview")).toBeInTheDocument()
  expect(screen.queryByTestId("files-preview-prompt")).not.toBeInTheDocument()
  expect(screen.getByText("File")).toBeInTheDocument()
})

it("allows long metadata to wrap within a narrow details column", () => {
  const language = "language".repeat(50)
  render(
    <FilesPreviewPane
      entry={entry({ kind: "artifact", language })}
      actions={actions()}
      onClose={jest.fn()}
    />
  )
  expect(screen.getByText(language).closest("dl")).toHaveClass("grid-cols-[auto_minmax(0,1fr)]")
  expect(screen.getByText(language)).toHaveClass("[overflow-wrap:anywhere]")
})

it("offers only Restore and Delete forever for an item in the Trash", async () => {
  payload.mockResolvedValue({ blob: new Blob(["x"], { type: "text/markdown" }), filename: "n.md" })
  const { useFilesLibraryStore } = await import("@/stores/files-library")
  useFilesLibraryStore.setState({ deleteForeverTarget: null })
  const restore = jest.fn(async () => {})
  const a = { ...actions(), restore } as unknown as jest.Mocked<FilesActions>
  const trashedAt = Date.UTC(2026, 8, 1)
  render(<FilesPreviewPane entry={entry({ trashedAt })} actions={a} onClose={jest.fn()} />)
  const footer = screen.getByTestId("files-preview-trash")
  expect(footer).toHaveTextContent("Moved to the Trash on 2026-09-01")
  expect(footer).toHaveTextContent("deleted for good on 2026-10-01")
  expect(screen.queryByTestId("files-preview-open")).toBeNull()
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Restore" }))
  expect(restore).toHaveBeenCalledWith([expect.objectContaining({ key: "upload:u1" })])
  await user.click(screen.getByRole("button", { name: "Delete forever" }))
  expect(useFilesLibraryStore.getState().deleteForeverTarget).toEqual(["upload:u1"])
})

it("draws an image upload's picture from its bytes", () => {
  render(
    <FilesPreviewPane
      entry={entry({ kind: "image", key: "image:h", sourceId: "h", mediaType: "image/png" })}
      actions={actions()}
      onClose={jest.fn()}
    />
  )
  expect(screen.getByTestId("thumb-h-full")).toBeInTheDocument()
})

it("grows its buttons to touch targets in the phone's drawer", async () => {
  payload.mockResolvedValue(null)
  const { rerender } = render(
    <FilesPreviewPane entry={entry({})} actions={actions()} onClose={jest.fn()} touch />
  )
  await screen.findByTestId("files-preview-unavailable")
  expect(screen.getByTestId("files-preview-footer").className).toContain("[&_button]:h-11")
  expect(screen.getByRole("button", { name: "Close preview" })).toHaveClass("size-11")
  rerender(
    <FilesPreviewPane
      entry={entry({ trashedAt: 5 })}
      actions={actions()}
      onClose={jest.fn()}
      touch
    />
  )
  expect(screen.getByTestId("files-preview-trash").className).toContain("[&_button]:h-11")
})

it("keeps the desktop pane's compact buttons", async () => {
  payload.mockResolvedValue(null)
  render(<FilesPreviewPane entry={entry({})} actions={actions()} onClose={jest.fn()} />)
  await screen.findByTestId("files-preview-unavailable")
  expect(screen.getByTestId("files-preview-footer").className).not.toContain("h-11")
  expect(screen.getByRole("button", { name: "Close preview" })).toHaveClass("size-7")
})

describe("on a paired device (ADR-0223 §9)", () => {
  function remote(over: Partial<FilesOps> = {}) {
    const ops = {
      mode: "remote",
      capabilities: PAIRED_FILES_CAPABILITIES,
      payloadFor: jest.fn(async () => ({
        blob: new Blob(["# host"], { type: "text/markdown" }),
        filename: "notes.md",
      })),
      artifactFor: jest.fn(async () => ({ id: "host-art" })),
      ...over,
    } as unknown as FilesOps
    const backend = {
      source: { entries: [], imagesTruncated: false, loadMoreImages: () => {}, folders: [] },
      ops,
    } as unknown as FilesBackend
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <FilesBackendProvider backend={backend}>{children}</FilesBackendProvider>
    )
    return { ops, wrapper }
  }

  it("reads the host's bytes, says it is read-only, and leads to the conversation instead of Open", async () => {
    const { ops, wrapper } = remote()
    const a = actions()
    a.goToConversation = jest.fn<Promise<void>, [string]>(async () => {})
    const user = userEvent.setup()
    render(
      <FilesPreviewPane entry={entry({ originSessionId: "s1" })} actions={a} onClose={jest.fn()} />,
      { wrapper }
    )
    expect(await screen.findByTestId("file-part-preview")).toBeInTheDocument()
    expect(ops.payloadFor).toHaveBeenCalled()
    expect(payload).not.toHaveBeenCalled()
    expect(screen.getByTestId("files-preview-read-only")).toHaveTextContent(
      "Read-only here. Edit it on the desktop."
    )
    expect(screen.queryByTestId("files-preview-open")).toBeNull()
    await user.click(screen.getByTestId("files-preview-open-conversation"))
    expect(a.goToConversation).toHaveBeenCalledWith("s1")
  })

  it("previews the host's artifact from its text", async () => {
    const { ops, wrapper } = remote()
    render(
      <FilesPreviewPane
        entry={entry({ key: "artifact:a", kind: "artifact", sourceId: "a" })}
        actions={actions()}
        onClose={jest.fn()}
      />,
      { wrapper }
    )
    expect(await screen.findByTestId("artifact-preview-host-art")).toBeInTheDocument()
    expect(ops.artifactFor).toHaveBeenCalledWith(expect.objectContaining({ key: "artifact:a" }))
  })

  it("says to open an item over the ceiling on the desktop, without reading it", () => {
    const { ops, wrapper } = remote()
    render(
      <FilesPreviewPane
        entry={entry({ byteSize: 10 * 1024 * 1024 + 1 })}
        actions={actions()}
        onClose={jest.fn()}
      />,
      { wrapper }
    )
    expect(screen.getByTestId("files-preview-too-large")).toHaveTextContent(
      "Too large to open here. Open it on the desktop."
    )
    expect(ops.payloadFor).not.toHaveBeenCalled()
  })

  it("offers no way on for an item whose conversation is gone", () => {
    const { wrapper } = remote()
    render(
      <FilesPreviewPane
        entry={entry({ originSessionId: "s1", originAlive: false })}
        actions={actions()}
        onClose={jest.fn()}
      />,
      { wrapper }
    )
    expect(screen.queryByTestId("files-preview-open-conversation")).toBeNull()
    expect(screen.queryByTestId("files-preview-open")).toBeNull()
  })

  it("explains truncated or oversized remote documents instead of calling them missing (F01)", async () => {
    const truncated = remote({
      artifactFor: jest.fn(async () =>
        Promise.reject(new FilesRemoteError("files_remote_text_truncated"))
      ),
    })
    const { unmount } = render(
      <FilesPreviewPane
        entry={entry({
          key: "artifact:big",
          kind: "artifact",
          sourceId: "big",
          byteSize: undefined,
        })}
        actions={actions()}
        onClose={jest.fn()}
      />,
      { wrapper: truncated.wrapper }
    )
    expect(await screen.findByTestId("files-preview-truncated")).toHaveTextContent(
      "truncated on transfer"
    )
    unmount()

    const tooLarge = remote({
      payloadFor: jest.fn(async () =>
        Promise.reject(new FilesRemoteError("files_remote_too_large"))
      ),
    })
    render(
      <FilesPreviewPane
        entry={entry({ key: "canvas:huge", kind: "canvas", sourceId: "huge", byteSize: undefined })}
        actions={actions()}
        onClose={jest.fn()}
      />,
      { wrapper: tooLarge.wrapper }
    )
    expect(await screen.findByTestId("files-preview-too-large")).toHaveTextContent(
      "Too large to open here."
    )
  })
})

it("previews a workspace file's bytes and says where it is and what the agent did (ADR-0223 §8)", async () => {
  payload.mockResolvedValue({
    blob: new Blob(["# plan"], { type: "text/markdown" }),
    filename: "plan.md",
  })
  const e = entry({
    key: "workspace-file:w1",
    kind: "workspace-file",
    sourceId: "w1",
    title: "plan.md",
    sourceTitle: "plan.md",
    ownedByFiles: false,
    creator: "ai",
    workspace: {
      sessionId: "s1",
      workspaceRoot: "/repo",
      executionRoot: "/repo",
      relPath: "docs/plan.md",
      change: "created",
    },
  })
  render(<FilesPreviewPane entry={e} actions={actions()} onClose={jest.fn()} />)
  expect(await screen.findByTestId("file-part-preview")).toHaveAttribute("data-filename", "plan.md")
  expect(payload).toHaveBeenCalledWith(e)
  expect(screen.getByText("Workspace file")).toBeInTheDocument()
  expect(screen.getByTestId("files-preview-workspace-path")).toHaveTextContent("docs/plan.md")
  expect(screen.getByTestId("files-preview-workspace-change")).toHaveTextContent(
    "Created by an agent"
  )
  // Not known whether it was applied (a turn row): no status is claimed.
  expect(screen.queryByTestId("files-preview-workspace-adoption")).toBeNull()
})

it("says when a workspace file is not applied yet, and when it is", async () => {
  payload.mockResolvedValue({ blob: new Blob(["x"], { type: "text/plain" }), filename: "a.txt" })
  const e = (adoption: "applied" | "pending") =>
    entry({
      key: "workspace-file:w2",
      kind: "workspace-file",
      sourceId: "w2",
      title: "a.txt",
      sourceTitle: "a.txt",
      creator: "ai",
      workspace: {
        sessionId: "s1",
        workspaceRoot: "/repo",
        executionRoot: "/exec/run-1",
        relPath: "a.txt",
        change: "modified",
        adoption,
      },
    })
  const { rerender } = render(
    <FilesPreviewPane entry={e("pending")} actions={actions()} onClose={jest.fn()} />
  )
  expect(await screen.findByTestId("files-preview-workspace-adoption")).toHaveTextContent(
    "Not applied yet: the agent's version, not in your workspace"
  )
  rerender(<FilesPreviewPane entry={e("applied")} actions={actions()} onClose={jest.fn()} />)
  expect(screen.getByTestId("files-preview-workspace-adoption")).toHaveTextContent(
    "Applied to the workspace"
  )
})

it("surfaces Version History for local artifacts and canvas documents, and a desktop hint on paired devices (G07)", async () => {
  const user = userEvent.setup()
  useArtifactStore.setState({
    artifacts: {
      a1: {
        id: "a1",
        sessionId: "s1",
        messageId: "m1",
        type: "code",
        title: "Spec",
        content: "v2",
        version: 2,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    } as never,
    artifactVersions: {
      a1: [{ id: "ver-1", version: 1, content: "v1", createdAt: new Date() }],
    } as never,
    canvasDocuments: {
      c1: {
        id: "c1",
        sessionId: "standalone",
        title: "Canvas Doc",
        content: "# Doc",
        language: "markdown",
        type: "text",
        versions: [{ id: "cv-1" }, { id: "cv-2" }],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    } as never,
  })
  payload.mockResolvedValue({ blob: new Blob(["# Doc"]), filename: "Canvas Doc.md" })

  const { rerender } = render(
    <FilesPreviewPane
      entry={entry({ key: "artifact:a1", kind: "artifact", sourceId: "a1", title: "Spec" })}
      actions={actions()}
      onClose={jest.fn()}
    />
  )
  expect(screen.getByTestId("files-preview-versions-section")).toHaveTextContent("1 saved")
  await user.click(screen.getByTestId("files-preview-version-trigger"))
  expect(await screen.findByTestId("artifact-version-history-a1")).toBeInTheDocument()

  rerender(
    <FilesPreviewPane
      entry={entry({ key: "canvas:c1", kind: "canvas", sourceId: "c1", title: "Canvas Doc" })}
      actions={actions()}
      onClose={jest.fn()}
    />
  )
  expect(screen.getByTestId("canvas-version-history-c1")).toBeInTheDocument()
  expect(screen.getByTestId("files-preview-versions-section")).toHaveTextContent("2 saved")

  const pairedBackend: FilesBackend = {
    source: { entries: [], imagesTruncated: false, loadMoreImages: jest.fn(), folders: [] },
    ops: {
      mode: "remote",
      capabilities: PAIRED_FILES_CAPABILITIES,
      artifactFor: async () => null,
      payloadFor: async () => ({ blob: new Blob(["# Doc"]), filename: "Canvas Doc.md" }),
    } as unknown as FilesOps,
  }
  rerender(
    <FilesBackendProvider backend={pairedBackend}>
      <FilesPreviewPane
        entry={entry({ key: "canvas:c1", kind: "canvas", sourceId: "c1", title: "Canvas Doc" })}
        actions={actions()}
        onClose={jest.fn()}
      />
    </FilesBackendProvider>
  )
  expect(screen.getByTestId("files-preview-versions-desktop-hint")).toHaveTextContent(
    "Version history and restore are available on the desktop app."
  )
})

it("lists active snapshot shares and live FileSpace grants and revokes shares on desktop (G08)", async () => {
  const user = userEvent.setup()
  payload.mockResolvedValue({ blob: new Blob(["body"]), filename: "notes.md" })
  const revokeSharedLink = jest.fn(async () => undefined)
  let revoked = false
  const accessFor = jest.fn(async () => ({
    sharedLinks: revoked
      ? []
      : [
          {
            code: "sh_live",
            title: "Shared Notes",
            kind: "file-bundle",
            createdAt: 1_000,
            expiresAt: 99_000,
            url: "https://share.example/share/view?c=sh_live",
          },
        ],
    liveGrants: [
      {
        id: "lg_sftp",
        sessionId: "s1",
        label: "Partner SFTP",
        audienceKind: "credentials" as const,
        protocols: ["sftp" as const],
        permissions: ["read" as const, "download" as const],
        status: "active" as const,
        expiresAt: 88_000,
        matchedPaths: ["/uploads/notes.md"],
      },
    ],
  }))
  revokeSharedLink.mockImplementation(async () => {
    revoked = true
  })

  const backend: FilesBackend = {
    source: { entries: [], imagesTruncated: false, loadMoreImages: jest.fn(), folders: [] },
    ops: {
      mode: "local",
      capabilities: { createDocuments: true, share: true, open: "navigate", workspaceFiles: true },
      payloadFor: payload,
      accessFor,
      revokeSharedLink,
    } as unknown as FilesOps,
  }

  render(
    <FilesBackendProvider backend={backend}>
      <FilesPreviewPane entry={entry({})} actions={actions()} onClose={jest.fn()} />
    </FilesBackendProvider>
  )

  expect(await screen.findByTestId("files-preview-share-link-sh_live")).toHaveTextContent(
    "Shared Notes"
  )
  expect(screen.getByTestId("files-preview-live-grant-lg_sftp")).toHaveTextContent("Partner SFTP")
  expect(screen.getByTestId("files-preview-live-grant-lg_sftp")).toHaveTextContent(
    "/uploads/notes.md"
  )

  await user.click(screen.getByTestId("files-preview-revoke-share-sh_live"))
  expect(revokeSharedLink).toHaveBeenCalledWith("sh_live")
  await waitFor(() =>
    expect(screen.queryByTestId("files-preview-share-link-sh_live")).not.toBeInTheDocument()
  )
})
