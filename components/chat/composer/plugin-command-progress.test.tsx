import { fireEvent, render, screen } from "@testing-library/react"

import { PluginCommandProgress } from "./plugin-command-progress"

it("shows the command's own message and its progress, and cancels", () => {
  const onCancel = jest.fn()
  render(
    <PluginCommandProgress
      progress={{ command: "lint", value: 0.5, message: "Linting 3 files" }}
      onCancel={onCancel}
    />
  )

  expect(screen.getByRole("status")).toHaveTextContent("Linting 3 files")
  expect(screen.getByRole("progressbar")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button"))
  expect(onCancel).toHaveBeenCalled()
})

it("falls back to the command's name and shows no bar without a value", () => {
  render(<PluginCommandProgress progress={{ command: "lint" }} onCancel={jest.fn()} />)

  expect(screen.getByRole("status")).toHaveTextContent("lint")
  expect(screen.queryByRole("progressbar")).toBeNull()
})
