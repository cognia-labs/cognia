/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { WritePlanButton } from "./write-plan-button"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const mockGetSession = jest.fn()
jest.mock("@/lib/db/sessions", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}))

jest.mock("./plan-composer-dialog", () => ({
  PlanComposerDialog: (props: { open: boolean; sessionId: string; characterId?: string }) =>
    props.open ? (
      <div data-testid="dialog">{`${props.sessionId}:${props.characterId ?? "none"}`}</div>
    ) : null,
}))

describe("WritePlanButton", () => {
  beforeEach(() => mockGetSession.mockReset())

  it("opens the composer with the session's agent", async () => {
    mockGetSession.mockResolvedValue({ id: "s1", characterId: "agent-7" })
    render(<WritePlanButton sessionId="s1" />)
    expect(screen.queryByTestId("dialog")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("plan-composer-open"))
    await waitFor(() => expect(screen.getByTestId("dialog")).toHaveTextContent("s1:agent-7"))
    expect(mockGetSession).toHaveBeenCalledWith("s1")
  })

  it("still opens when the session cannot be read", async () => {
    mockGetSession.mockRejectedValue(new Error("gone"))
    render(<WritePlanButton sessionId="s2" />)
    fireEvent.click(screen.getByText("openLabel"))
    await waitFor(() => expect(screen.getByTestId("dialog")).toHaveTextContent("s2:none"))
  })
})
