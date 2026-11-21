/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react"

import { FilesRemoteNotice } from "./files-remote-notice"

it("says nothing while the library reads fine, or where it is this device's own", () => {
  const { container, rerender } = render(
    <FilesRemoteNotice error={undefined} refresh={jest.fn()} />
  )
  expect(container).toBeEmptyDOMElement()
  rerender(<FilesRemoteNotice error="files_remote_busy" refresh={undefined} />)
  expect(container).toBeEmptyDOMElement()
})

it("names why the host's library may be stale and retries on demand", async () => {
  let finish!: () => void
  const refresh = jest.fn(() => new Promise<void>((resolve) => (finish = resolve)))
  render(<FilesRemoteNotice error="files_remote_unreachable" refresh={refresh} touch />)
  expect(screen.getByRole("alert")).toHaveTextContent("Couldn’t read the desktop’s library")
  expect(screen.getByText("Couldn’t reach the desktop.")).toBeInTheDocument()
  const retry = screen.getByRole("button")
  expect(retry).toHaveAccessibleName("Retry")
  fireEvent.click(retry)
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(retry).toBeDisabled()
  await act(async () => finish())
  expect(retry).not.toBeDisabled()
})

it("reads an unknown code as the generic failure", () => {
  render(<FilesRemoteNotice error="something_new" refresh={jest.fn(async () => {})} />)
  expect(screen.getByText("Something went wrong. Try again.")).toBeInTheDocument()
})

it("surfaces failed body search with Retry, and truncated or bounded search scope notices (F06, G01)", () => {
  const retrySearch = jest.fn()
  const { rerender } = render(
    <FilesRemoteNotice
      error={undefined}
      refresh={undefined}
      searchError="files_remote_unreachable"
      retrySearch={retrySearch}
      searchBounded
    />
  )
  expect(screen.getByTestId("files-search-error-notice")).toHaveTextContent(
    "Couldn’t search file contents on the desktop"
  )
  fireEvent.click(screen.getByTestId("files-search-retry"))
  expect(retrySearch).toHaveBeenCalledTimes(1)
  expect(screen.getByTestId("files-search-bounded-notice")).toHaveTextContent("20,000 characters")

  rerender(<FilesRemoteNotice error={undefined} refresh={undefined} searchTruncated />)
  expect(screen.getByTestId("files-search-truncated-notice")).toHaveTextContent(
    "first 200 content matches"
  )
})
