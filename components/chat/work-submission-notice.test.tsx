// ADR-0123 — the notice explains a turn the system accepted but has not
// answered. Each state exists because the right user response differs.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { WorkSubmissionStatus } from "@/hooks/work-submission/use-work-submission-status"
import type { WorkSubmissionRow } from "@/lib/db/work-submissions"

import { WorkSubmissionNotice } from "./work-submission-notice"

let status: WorkSubmissionStatus = { state: "idle" }

jest.mock("@/hooks/work-submission/use-work-submission-status", () => ({
  useWorkSubmissionStatus: () => status,
}))

beforeEach(() => {
  status = { state: "idle" }
})

describe("WorkSubmissionNotice", () => {
  it("renders nothing while a turn is streaming normally", () => {
    // The streaming UI already reports this; a second indicator is noise.
    const { container } = render(<WorkSubmissionNotice sessionId="session-1" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("explains a queued turn", () => {
    status = { state: "queued" }
    render(<WorkSubmissionNotice sessionId="session-1" />)
    expect(screen.getByTestId("work-submission-queued")).toBeInTheDocument()
  })

  it("distinguishes waiting-to-reconnect from waiting-to-start", () => {
    // Before durable submission these were indistinguishable from a hang.
    status = { state: "blocked" }
    render(<WorkSubmissionNotice sessionId="session-1" />)
    expect(screen.getByTestId("work-submission-blocked")).toBeInTheDocument()
    expect(screen.queryByTestId("work-submission-queued")).not.toBeInTheDocument()
  })

  it("raises a recovery-required turn as destructive, because only a person can clear it", () => {
    status = { state: "recoveryRequired" }
    render(<WorkSubmissionNotice sessionId="session-1" />)
    const alert = screen.getByTestId("work-submission-recovery")
    expect(alert).toBeInTheDocument()
    expect(alert).toHaveAttribute("data-slot", "alert")
  })

  it("renders exactly one notice at a time", () => {
    status = { state: "recoveryRequired" }
    render(<WorkSubmissionNotice sessionId="session-1" />)
    expect(screen.getAllByRole("alert")).toHaveLength(1)
  })

  it("renders nothing when there is no session", () => {
    const { container } = render(<WorkSubmissionNotice sessionId={undefined} />)
    expect(container).toBeEmptyDOMElement()
  })

  it.each([
    ["observed-tool-activity", "This turn stopped after it had already started using tools"],
    ["unconfirmed-attempt", "nothing shows whether it had already started working"],
    ["ambiguous-side-effects", "could not confirm whether earlier tool operations finished"],
    ["corrupt-canonical-log", "saved conversation log is damaged"],
    ["unreadable-journal", "could not read the saved execution log"],
    ["no-candidates", "No usable conversation history was found"],
    ["forked-history", "Saved versions of this conversation conflict"],
    ["no-dominant", "could not choose a complete, consistent conversation history"],
    ["missing_frozen_input", "saved message input is missing"],
    ["missing_frozen_context", "saved execution context is incomplete"],
    ["missing_frozen_send_options", "saved execution context is incomplete"],
    ["invalid_frozen_input", "saved message input is invalid"],
    ["frozen_payload_unreadable", "could not open the saved message or execution context"],
    [
      "frozen_input_digest_mismatch",
      "saved message or execution context failed its integrity check",
    ],
    [
      "frozen_context_digest_mismatch",
      "saved message or execution context failed its integrity check",
    ],
    ["takeover_abort_failed", "could not confirm that the previous runtime stopped"],
    ["frozen_transcript_host_unverified", "could not verify the execution host"],
    [
      "transcript_authoritative_host_required",
      "must be recovered on the host that owns its history",
    ],
    [
      "frozen_transcript_session_missing",
      "saved conversation could not be found on the execution host",
    ],
    [
      "frozen_transcript_generation_mismatch",
      "conversation history changed since this turn was saved",
    ],
    ["future-recovery-code", "could not safely restore this turn"],
    [undefined, "could not safely restore this turn"],
  ])("explains the persisted recovery reason %s", (errorCode, expected) => {
    status = {
      state: "recoveryRequired",
      submission: { errorCode } as WorkSubmissionRow,
    }
    render(<WorkSubmissionNotice sessionId="session-1" />)
    expect(screen.getByRole("alert")).toHaveTextContent(expected!)
    if (errorCode !== "observed-tool-activity") {
      expect(screen.getByRole("alert")).not.toHaveTextContent(
        "after it had already started using tools"
      )
    }
  })

  describe("continuing a parked chat turn", () => {
    const parked = (errorCode: string, sourceKind = "chat") => {
      status = {
        state: "recoveryRequired",
        submission: { errorCode, sourceKind } as WorkSubmissionRow,
      }
    }

    it("continues at once when the reason says nothing about effects", async () => {
      parked("corrupt-canonical-log")
      const onResume = jest.fn(async () => {})
      render(<WorkSubmissionNotice sessionId="session-1" onResume={onResume} />)
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Continue from where it stopped" }))
      })
      expect(onResume).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    })

    it.each(["observed-tool-activity", "ambiguous-side-effects", "unconfirmed-attempt"])(
      "asks first when the turn was parked for %s, and only continues on Continue",
      async (errorCode) => {
        parked(errorCode)
        const onResume = jest.fn(async () => {})
        render(<WorkSubmissionNotice sessionId="session-1" onResume={onResume} />)
        fireEvent.click(screen.getByRole("button", { name: "Continue from where it stopped" }))
        const dialog = await screen.findByRole("alertdialog")
        expect(dialog).toHaveTextContent("Continuing can repeat their effects")
        expect(onResume).not.toHaveBeenCalled()

        fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
        await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
        expect(onResume).not.toHaveBeenCalled()

        fireEvent.click(screen.getByRole("button", { name: "Continue from where it stopped" }))
        await screen.findByRole("alertdialog")
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: "Continue" }))
        })
        expect(onResume).toHaveBeenCalledTimes(1)
      }
    )

    it("offers nothing where the host cannot continue, or for work that is not a chat turn", () => {
      parked("unconfirmed-attempt")
      const { unmount } = render(<WorkSubmissionNotice sessionId="session-1" />)
      expect(screen.queryByRole("button")).not.toBeInTheDocument()
      unmount()
      parked("unconfirmed-attempt", "schedule")
      render(<WorkSubmissionNotice sessionId="session-1" onResume={jest.fn()} />)
      expect(screen.queryByRole("button")).not.toBeInTheDocument()
    })
  })
})
