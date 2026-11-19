/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

import { NewFolderNameDialog } from "./new-folder-name-dialog"

function renderDialog(count = 2) {
  const onConfirm = jest.fn()
  const onCancel = jest.fn()
  const view = render(
    <NewFolderNameDialog
      count={count}
      defaultName="New folder"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
  return { onConfirm, onCancel, ...view }
}

it("renders nothing while closed", () => {
  renderDialog(0)
  expect(screen.queryByTestId("new-folder-name-dialog")).toBeNull()
})

it("starts from the placeholder name, selected, and says how many it files", () => {
  renderDialog(3)
  const input = screen.getByTestId("new-folder-name-input")
  expect(input).toHaveValue("New folder")
  expect(input).toHaveFocus()
  expect(screen.getByText('description:{"count":3}')).toBeInTheDocument()
})

it("confirms the trimmed name, by button and by Enter", async () => {
  const user = userEvent.setup()
  const { onConfirm } = renderDialog()
  const input = screen.getByTestId("new-folder-name-input")
  await user.clear(input)
  await user.type(input, "  Launch  ")
  await user.click(screen.getByTestId("new-folder-name-confirm"))
  expect(onConfirm).toHaveBeenLastCalledWith("Launch")
  await user.type(input, "{Enter}")
  expect(onConfirm).toHaveBeenCalledTimes(2)
})

it("refuses an empty name", async () => {
  const user = userEvent.setup()
  const { onConfirm } = renderDialog()
  await user.clear(screen.getByTestId("new-folder-name-input"))
  expect(screen.getByTestId("new-folder-name-confirm")).toBeDisabled()
  await user.type(screen.getByTestId("new-folder-name-input"), "   {Enter}")
  expect(onConfirm).not.toHaveBeenCalled()
})

it("cancels from the button and from Escape", async () => {
  const user = userEvent.setup()
  const { onCancel } = renderDialog()
  await user.click(screen.getByRole("button", { name: "cancel" }))
  expect(onCancel).toHaveBeenCalledTimes(1)
  await user.keyboard("{Escape}")
  expect(onCancel).toHaveBeenCalledTimes(2)
})
