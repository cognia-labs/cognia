import { render, screen } from "@testing-library/react"

import type { ChatSession } from "@cognia/agent-config-types"

import { ComposerCapabilityMenu } from "./composer-capability-menu"

const rowProps: Record<string, unknown> = {}
jest.mock("./web-search-toggle", () => ({
  WebSearchToggle: (props: { disabled?: boolean }) => {
    rowProps.webSearch = props
    return <div data-testid="web-search" />
  },
}))
jest.mock("./room-target-picker", () => ({
  RoomTargetPicker: (props: { disabled?: boolean }) => {
    rowProps.room = props
    return <div data-testid="room" />
  },
}))
jest.mock("./skills-menu-entry", () => ({
  SkillsMenuEntry: (props: { disabled?: boolean }) => {
    rowProps.skills = props
    return <div data-testid="skills" />
  },
}))

const session = { id: "s1", kind: "direct" } as ChatSession

it("lists web search, the room target and skills, enabled while idle", () => {
  render(<ComposerCapabilityMenu session={session} status="ready" onOpenSettings={jest.fn()} />)

  expect(screen.getByTestId("composer-capability-menu")).toBeInTheDocument()
  for (const props of Object.values(rowProps)) {
    expect(props).toEqual(expect.objectContaining({ disabled: false }))
  }
})

it("disables every row while a turn streams or the composer is disabled", () => {
  render(<ComposerCapabilityMenu session={session} status="streaming" onOpenSettings={jest.fn()} />)
  for (const props of Object.values(rowProps)) {
    expect(props).toEqual(expect.objectContaining({ disabled: true }))
  }

  render(
    <ComposerCapabilityMenu session={session} status="ready" disabled onOpenSettings={jest.fn()} />
  )
  for (const props of Object.values(rowProps)) {
    expect(props).toEqual(expect.objectContaining({ disabled: true }))
  }
})
