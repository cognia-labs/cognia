/**
 * @jest-environment jsdom
 */
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { useFilesTransferStore } from "@/stores/files-library"
import { FilesTransferTray } from "./files-transfer-tray"

beforeEach(() => {
  act(() => {
    useFilesTransferStore.getState().reset()
  })
})

it("stays hidden when empty and supports cancelling, retrying, and clearing finished transfers (G03)", async () => {
  const user = userEvent.setup()
  render(<FilesTransferTray />)
  expect(screen.queryByTestId("files-transfer-tray")).toBeNull()

  const controller = new AbortController()
  let id = ""
  const retryFn = jest.fn(async () => {
    useFilesTransferStore.getState().markCompleted(id)
  })
  act(() => {
    id = useFilesTransferStore.getState().enqueueTask({
      kind: "upload",
      name: "spec.pdf",
      totalBytes: 2_048,
      status: "running",
      abortController: controller,
      retryFn,
    })
    useFilesTransferStore.getState().updateProgress(id, 1_024)
  })

  expect(screen.getByTestId("files-transfer-tray")).toBeInTheDocument()
  expect(screen.getByText("spec.pdf")).toBeInTheDocument()
  expect(screen.getByText("1.0 KB / 2.0 KB")).toBeInTheDocument()

  await user.click(screen.getByTestId(`files-transfer-cancel-${id}`))
  expect(controller.signal.aborted).toBe(true)

  await user.click(screen.getByTestId(`files-transfer-retry-${id}`))
  expect(retryFn).toHaveBeenCalledTimes(1)

  await user.click(screen.getByTestId("files-transfer-clear-finished"))
  expect(screen.queryByTestId("files-transfer-tray")).toBeNull()
})
