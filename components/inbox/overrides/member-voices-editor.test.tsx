/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

import { MemberVoicesEditor, memberVoicesForTeam } from "./member-voices-editor"

const members = [
  { id: "c_ana", name: "Ana" },
  { id: "c_ben", name: "Ben" },
]
const bots = [
  { id: "bot_a", displayName: "Room bot", enabled: true },
  { id: "bot_b", displayName: "Ana bot", enabled: true },
  { id: "bot_off", displayName: "Off bot", enabled: false },
]

describe("MemberVoicesEditor", () => {
  it("offers the platform's other enabled bots, defaulting each member to this one", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(
      <MemberVoicesEditor
        adapterId="bot_a"
        members={members}
        bots={bots}
        value={{}}
        onChange={onChange}
      />
    )
    expect(screen.getByText("help")).toBeInTheDocument()
    expect(screen.getByTestId("conv-override-member-voice-c_ana")).toHaveTextContent("ownBot")
    await user.click(screen.getByTestId("conv-override-member-voice-c_ana"))
    const options = screen.getAllByRole("option").map((option) => option.textContent)
    expect(options).toEqual(["ownBot", "Ana bot"])
    await user.click(screen.getByRole("option", { name: "Ana bot" }))
    expect(onChange).toHaveBeenCalledWith({ c_ana: "bot_b" })
  })

  it("clears a member back to this bot, and shows a bot that is gone", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(
      <MemberVoicesEditor
        adapterId="bot_a"
        members={members}
        bots={bots}
        value={{ c_ana: "bot_b", c_ben: "bot_gone" }}
        onChange={onChange}
      />
    )
    expect(screen.getByTestId("conv-override-member-voice-c_ben")).toHaveTextContent(
      'missing:{"id":"bot_gone"}'
    )
    await user.click(screen.getByTestId("conv-override-member-voice-c_ana"))
    await user.click(screen.getByRole("option", { name: "ownBot" }))
    expect(onChange).toHaveBeenCalledWith({ c_ben: "bot_gone" })
  })

  it("says how to give a member a voice when no other bot exists, and draws nothing without members", () => {
    const { container, rerender } = render(
      <MemberVoicesEditor
        adapterId="bot_a"
        members={members}
        bots={[bots[0]!]}
        value={{}}
        onChange={jest.fn()}
      />
    )
    expect(screen.getByText("noSiblings")).toBeInTheDocument()
    rerender(
      <MemberVoicesEditor
        adapterId="bot_a"
        members={[]}
        bots={bots}
        value={{}}
        onChange={jest.fn()}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })
})

describe("memberVoicesForTeam", () => {
  it("keeps the entries of current members only", () => {
    expect(
      memberVoicesForTeam({ c_ana: "bot_b", c_gone: "bot_c", c_ben: "" }, ["c_ana", "c_ben"])
    ).toEqual({ c_ana: "bot_b" })
    expect(memberVoicesForTeam({ c_gone: "bot_c" }, ["c_ana"])).toBeUndefined()
  })
})
