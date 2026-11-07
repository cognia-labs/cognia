/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

// Radix Select is exercised by its own suite; here a transparent mock exposes
// `onValueChange` and every rendered item so the picker's mapping is testable.
let lastOnValueChange: ((value: string) => void) | undefined
jest.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    onOpenChange,
    children,
    disabled,
  }: {
    value?: string
    onValueChange?: (v: string) => void
    onOpenChange?: (open: boolean) => void
    children: React.ReactNode
    disabled?: boolean
  }) => {
    lastOnValueChange = onValueChange
    lastOnOpenChange = onOpenChange
    return (
      <div data-testid="select" data-value={value} data-disabled={disabled ? "true" : "false"}>
        {children}
      </div>
    )
  },
  SelectTrigger: ({ children, ...rest }: { children: React.ReactNode }) => (
    <div {...rest}>{children}</div>
  ),
  SelectValue: () => <span data-testid="select-value" />,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectLabel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="select-group-label">{children}</div>
  ),
  SelectItem: ({ children, value, ...rest }: { children: React.ReactNode; value: string }) => (
    <div data-value={value} {...rest}>
      {children}
    </div>
  ),
}))

let characters: Array<{ id: string; name: string }> = []
let lastOnOpenChange: ((open: boolean) => void) | undefined
jest.mock("@/hooks/data", () => ({ useClientLiveQuery: () => characters }))
jest.mock("@/lib/db/characters", () => ({ listCharacters: jest.fn() }))

let teams: Record<string, { id: string; name: string; projectId?: string }> = {}
jest.mock("@/stores/squads/agent-team-store/store", () => ({
  useAgentTeamStore: (selector: (s: { teams: typeof teams }) => unknown) => selector({ teams }),
}))
let activeProjectId: string | null = "w1"
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (s: { activeProjectId: string | null }) => unknown) =>
    selector({ activeProjectId }),
}))

import { render, screen } from "@testing-library/react"
import {
  AssigneePicker,
  UNASSIGNED_VALUE,
  actorForValue,
  buildAssigneeOptions,
  memberAssigneeOptions,
} from "./assignee-picker"

beforeEach(() => {
  characters = [{ id: "c1", name: "Ada" }]
  teams = {
    t1: { id: "t1", name: "Squad", projectId: "w1" },
    t2: { id: "t2", name: "Elsewhere", projectId: "w2" },
    t3: { id: "t3", name: "Legacy" },
  }
  activeProjectId = "w1"
  lastOnValueChange = undefined
  lastOnOpenChange = undefined
})

describe("buildAssigneeOptions / actorForValue", () => {
  it("lists me, Characters as agents and teams as squads, keyed by actorKey", () => {
    const options = buildAssigneeOptions(
      [{ id: "c1", name: "Ada" }],
      [{ id: "t1", name: "Squad" }],
      "Me"
    )
    expect(options.map((o) => [o.key, o.group, o.actor.label])).toEqual([
      ["human:self", "human", "Me"],
      ["agent:c1", "agent", "Ada"],
      ["team:t1", "team", "Squad"],
    ])
    expect(actorForValue(UNASSIGNED_VALUE, options)).toBeNull()
    expect(actorForValue("agent:c1", options)).toEqual({ kind: "agent", id: "c1", label: "Ada" })
    expect(actorForValue("agent:ghost", options)).toBeUndefined()
  })
})

describe("memberAssigneeOptions", () => {
  it("names each member by id, labelled with their name, in the member group", () => {
    expect(
      memberAssigneeOptions([
        { userId: "usr_bob", displayName: "Bob" },
        { userId: "usr_cat", displayName: "Cat" },
      ])
    ).toEqual([
      {
        key: "human:usr_bob",
        actor: { kind: "human", id: "usr_bob", label: "Bob" },
        group: "member",
      },
      {
        key: "human:usr_cat",
        actor: { kind: "human", id: "usr_cat", label: "Cat" },
        group: "member",
      },
    ])
  })
})

describe("AssigneePicker", () => {
  it("offers Characters and this workspace's teams (plus legacy teams without a workspace)", () => {
    render(<AssigneePicker value={null} onChange={jest.fn()} />)
    expect(screen.getByTestId("issue-assignee-picker-none")).toBeInTheDocument()
    expect(screen.getByTestId("issue-assignee-picker-human:self")).toBeInTheDocument()
    expect(screen.getByTestId("issue-assignee-picker-agent:c1")).toHaveTextContent("Ada")
    expect(screen.getByTestId("issue-assignee-picker-team:t1")).toHaveTextContent("Squad")
    expect(screen.getByTestId("issue-assignee-picker-team:t3")).toHaveTextContent("Legacy")
    expect(screen.queryByTestId("issue-assignee-picker-team:t2")).not.toBeInTheDocument()
    expect(screen.getByTestId("select")).toHaveAttribute("data-value", UNASSIGNED_VALUE)
  })

  it("maps a selection back to an actor and clears on the sentinel", () => {
    const onChange = jest.fn()
    render(<AssigneePicker value={{ kind: "agent", id: "c1" }} onChange={onChange} />)
    expect(screen.getByTestId("select")).toHaveAttribute("data-value", "agent:c1")
    lastOnValueChange!("team:t1")
    expect(onChange).toHaveBeenLastCalledWith({ kind: "team", id: "t1", label: "Squad" })
    lastOnValueChange!(UNASSIGNED_VALUE)
    expect(onChange).toHaveBeenLastCalledWith(null)
    lastOnValueChange!("agent:unknown")
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it("keeps a stale assignee visible so the control never renders blank", () => {
    render(
      <AssigneePicker
        value={{ kind: "agent", id: "gone", label: "Ghost" }}
        onChange={jest.fn()}
        disabled
        data-testid="picker"
      />
    )
    expect(screen.getByTestId("picker-stale")).toHaveTextContent("Ghost · assignee.missing")
    expect(screen.getByTestId("select")).toHaveAttribute("data-disabled", "true")
  })

  describe("on a shared issue (ADR-0149 §10)", () => {
    const ADA = "usr_aaaaaaaaaaaaaaaaaaaaaaaa"

    it("greys out Me with the reason when nobody is signed in", () => {
      render(
        <AssigneePicker
          value={null}
          onChange={jest.fn()}
          shared={{ selfUserId: null }}
          data-testid="picker"
        />
      )
      expect(screen.getByTestId("picker-human:self")).toHaveAttribute("disabled")
      expect(screen.getByTestId("picker-human:self-refusal")).toHaveTextContent(
        "assignee.sharedRefusal.anonymous-human"
      )
      // Agents carry their own ids, so the plane can name them.
      expect(screen.getByTestId("picker-agent:c1")).not.toHaveAttribute("disabled")
      expect(screen.queryByTestId("picker-agent:c1-refusal")).toBeNull()
    })

    it("shows the signed-in person's own assignment as Me, not as a missing actor", () => {
      render(
        <AssigneePicker
          value={{ kind: "human", id: ADA, label: "Ada" }}
          onChange={jest.fn()}
          shared={{ selfUserId: ADA }}
          data-testid="picker"
        />
      )
      expect(screen.getByTestId("select")).toHaveAttribute("data-value", "human:self")
      expect(screen.queryByTestId("picker-stale")).toBeNull()
      expect(screen.getByTestId("picker-human:self")).not.toHaveAttribute("disabled")
    })

    const bob = memberAssigneeOptions([{ userId: "usr_bob", displayName: "Bob" }])

    it("offers the workspace's members under their own group, and picks one by id", () => {
      const onChange = jest.fn()
      render(
        <AssigneePicker
          value={null}
          onChange={onChange}
          shared={{ selfUserId: ADA }}
          members={bob}
          data-testid="picker"
        />
      )
      expect(screen.getAllByTestId("select-group-label").map((node) => node.textContent)).toContain(
        "assignee.members"
      )
      expect(screen.getByTestId("picker-human:usr_bob")).not.toHaveAttribute("disabled")
      lastOnValueChange!("human:usr_bob")
      expect(onChange).toHaveBeenCalledWith({ kind: "human", id: "usr_bob", label: "Bob" })
    })

    it("shows a member already assigned as that member, not as missing", () => {
      render(
        <AssigneePicker
          value={{ kind: "human", id: "usr_bob", label: "Bob" }}
          onChange={jest.fn()}
          shared={{ selfUserId: ADA }}
          members={bob}
          data-testid="picker"
        />
      )
      expect(screen.getByTestId("select")).toHaveAttribute("data-value", "human:usr_bob")
      expect(screen.queryByTestId("picker-stale")).toBeNull()
    })

    it("never offers members to a local issue", () => {
      render(
        <AssigneePicker value={null} onChange={jest.fn()} members={bob} data-testid="picker" />
      )
      expect(screen.queryByTestId("picker-human:usr_bob")).toBeNull()
    })

    it("reports the list opening, so the board can refresh its roster", () => {
      const onOpenChange = jest.fn()
      render(
        <AssigneePicker
          value={null}
          onChange={jest.fn()}
          shared={{ selfUserId: ADA }}
          onOpenChange={onOpenChange}
        />
      )
      lastOnOpenChange!(true)
      expect(onOpenChange).toHaveBeenCalledWith(true)
    })

    it("leaves a local issue's options alone", () => {
      render(<AssigneePicker value={null} onChange={jest.fn()} data-testid="picker" />)
      expect(screen.getByTestId("picker-human:self")).not.toHaveAttribute("disabled")
    })
  })

  it("hides empty groups and tolerates no active workspace", () => {
    characters = []
    teams = {}
    activeProjectId = null
    render(<AssigneePicker value={null} onChange={jest.fn()} />)
    expect(screen.getAllByTestId("select-group-label")).toHaveLength(1)
  })
})
