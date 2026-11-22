// Replay current counterexamples with the repo's existing mounted DB fixtures.
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const editorProbe = `
it.each([1, 2])("audit: switching workspaces with B at rev %i", async (bRevision) => {
  useProjectStore.setState({ projects: [
    { id: "ws-1", name: "Workspace A", roots: [] },
    { id: "ws-2", name: "Workspace B", roots: [] },
  ] } as never)
  const workspaceA = { scope: "workspace" as const, targetId: "ws-1" }
  const workspaceB = { scope: "workspace" as const, targetId: "ws-2" }
  const def = BRIEF_MODE_PROMPT
  await publishPromptBody({ def, target: workspaceA, expectedRev: 0, body: "Workspace A wording." })
  await publishPromptBody({
    def, target: workspaceB, expectedRev: 0, body: "Workspace B wording.", origin: "import",
  })
  if (bRevision === 2) {
    await publishPromptBody({ def, target: workspaceB, expectedRev: 1, body: "Workspace B wording." })
  }
  await renderDetail(def)
  fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "workspace" } })
  fireEvent.change(screen.getAllByRole("combobox")[1], { target: { value: "ws-1" } })
  await waitFor(() => expect(editor().value).toBe("Workspace A wording."))

  fireEvent.change(screen.getAllByRole("combobox")[1], { target: { value: "ws-2" } })
  // Verify the destination's history really arrived before inspecting the text.
  await userEvent.click(screen.getByRole("tab", { name: /history/i }))
  await screen.findByText(/imported$/i)
  await userEvent.click(screen.getByRole("tab", { name: "Edit" }))
  const observed = bRevision === 1 ? "Workspace A wording." : "Workspace B wording."
  expect(editor().value).toBe(observed)

  await userEvent.click(screen.getByRole("button", { name: "Publish" }))
  await waitFor(async () => {
    const slot = await readPromptSlot(def.id, workspaceB)
    expect(slot.binding?.rev).toBe(bRevision + 1)
    expect(slot.active?.body).toBe(observed)
  })
})
`

const importProbe = `
it.each([false, true])("audit: profile mapping change with fresh preview: %s", async (waitForPreview) => {
  const text = await profileText()
  const oldTarget = { scope: "workspace" as const, targetId: "ws-src" }
  const newTarget = { scope: "workspace" as const, targetId: "ws-other" }
  const def = BRIEF_MODE_PROMPT
  await publishPromptBody({ def, target: newTarget, expectedRev: 0, body: "Existing destination." })
  await openImport(text)
  const preview = await screen.findByTestId("prompt-import-preview")
  const mapping = await mappingFor("ws-src")
  await waitFor(() => expect(within(preview).getAllByText("New")).toHaveLength(2))
  fireEvent.change(mapping, { target: { value: "ws-other" } })
  expect(mapping.value).toBe("ws-other")
  if (waitForPreview) await within(preview).findByText(/replace/i)
  fireEvent.click(screen.getByRole("button", { name: "Publish 2 overrides" }))
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Published 2 overrides."))
  expect((await readPromptSlot(def.id, oldTarget)).active?.body).toBe(
    waitForPreview ? undefined : "Workspace brevity."
  )
  expect((await readPromptSlot(def.id, newTarget)).active?.body).toBe(
    waitForPreview ? "Workspace brevity." : "Existing destination."
  )
})
`

const directory = "components/settings/prompts"
const reservation = mkdtempSync(join(directory, "prompt-doubt-"))
const files = [
  [`${reservation}-editor.test.tsx`, "code-prompt-detail.test.tsx", editorProbe],
  [`${reservation}-import.test.tsx`, "prompt-profile-dialog.test.tsx", importProbe],
]
try {
  for (const [target, fixture, probe] of files) {
    writeFileSync(target, readFileSync(join(directory, fixture), "utf8") + "\n" + probe, {
      flag: "wx",
    })
  }
  execFileSync(
    "pnpm",
    ["test", "--runInBand", "--runTestsByPath", ...files.map(([file]) => file), "-t", "audit:"],
    {
      stdio: "inherit",
      timeout: 60_000,
    }
  )
} finally {
  for (const [target] of files) rmSync(target, { force: true })
  rmSync(reservation, { recursive: true })
}
