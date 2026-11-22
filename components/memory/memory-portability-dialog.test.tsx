/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { Memory } from "@/types/memory/memory"
import { MemoryPortabilityDialog } from "./memory-portability-dialog"

function makeMemory(overrides: Partial<Memory> & { id: string; text: string }): Memory {
  return {
    scope: "global",
    type: "semantic",
    tags: ["setup"],
    importance: 7,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    lastAccessedAt: 1_700_000_000_000,
    accessCount: 0,
    version: 1,
    status: "active",
    pinned: false,
    provenance: "user",
    ...overrides,
  }
}

describe("MemoryPortabilityDialog", () => {
  it("exports current filtered memories and copies the bundle", () => {
    const onCopyText = jest.fn()
    const row = makeMemory({ id: "m1", text: "User prefers pnpm workspaces." })

    render(
      <MemoryPortabilityDialog
        open
        onOpenChange={jest.fn()}
        allMemories={[row]}
        filteredRows={[row]}
        projectNames={{ "p-1": "Cognia" }}
        onCreate={jest.fn(async () => true)}
        onRunCommand={jest.fn(async () => true)}
        onCopyText={onCopyText}
      />
    )

    expect(screen.getByTestId("memory-export-count")).toHaveTextContent("1 memory ready to export")
    const preview = screen.getByTestId("memory-export-preview") as HTMLTextAreaElement
    expect(preview.value).toContain("cognia-memory-export-v1")
    expect(preview.value).toContain("User prefers pnpm workspaces.")

    fireEvent.click(screen.getByTestId("memory-export-copy"))
    expect(onCopyText).toHaveBeenCalledWith(preview.value)
  })

  it("previews duplicates, PII blocks, and quarantined sensitive items before importing", async () => {
    const user = userEvent.setup()
    const onCreate = jest.fn(async () => true)
    const onOpenChange = jest.fn()
    const existing = [makeMemory({ id: "m-existing", text: "User lives in Shanghai." })]

    render(
      <MemoryPortabilityDialog
        open
        onOpenChange={onOpenChange}
        allMemories={existing}
        filteredRows={existing}
        projectNames={{ "p-1": "Cognia" }}
        onCreate={onCreate}
        onRunCommand={jest.fn(async () => true)}
        onCopyText={jest.fn()}
      />
    )

    await user.click(screen.getByTestId("memory-portability-tab-import"))

    const textarea = screen.getByTestId("memory-import-textarea")
    fireEvent.change(textarea, {
      target: {
        value: [
          "- User lives in Shanghai.",
          "- Reach me at secret@example.com",
          "- [procedural] Prefer concise bullet points.",
          "- User was diagnosed with asthma.",
        ].join("\n"),
      },
    })

    const preview = screen.getByTestId("memory-import-preview")
    expect(preview).toHaveTextContent("2 new")
    expect(preview).toHaveTextContent("1 duplicates skipped")
    expect(preview).toHaveTextContent("1 blocked (PII)")
    expect(preview).toHaveTextContent("1 sensitive (quarantined)")

    await user.click(screen.getByTestId("memory-import-confirm"))

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(2))
    expect(onCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: "procedural",
        text: "Prefer concise bullet points.",
        reviewStatus: "pending_instruction",
        trustState: "quarantined",
      })
    )
    expect(onCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "semantic",
        text: "User was diagnosed with asthma.",
        sensitivity: "sensitive",
        trustState: "quarantined",
        reviewStatus: "unreviewed",
      })
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
