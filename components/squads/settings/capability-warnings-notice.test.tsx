/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"

import type { CapabilityAuditWarning } from "@/lib/squads/capability-audit"
import { CapabilityWarningsNotice } from "./capability-warnings-notice"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

let warnings: readonly CapabilityAuditWarning[] = []
const useSquadCapabilityWarnings = jest.fn(() => warnings)
jest.mock("@/hooks/squads/use-squad-capability-warnings", () => ({
  useSquadCapabilityWarnings: (...args: unknown[]) => useSquadCapabilityWarnings(...(args as [])),
}))

jest.mock("@/stores/squads/agent-team-store/store", () => ({
  useAgentTeamStore: (select: (s: unknown) => unknown) =>
    select({ teammates: { m1: { id: "m1", name: "Reviewer" } } }),
}))

describe("CapabilityWarningsNotice", () => {
  beforeEach(() => {
    warnings = []
    useSquadCapabilityWarnings.mockClear()
  })

  it("renders nothing while every id resolves, and still audits", () => {
    const { container } = render(<CapabilityWarningsNotice teamId="t1" />)
    expect(container).toBeEmptyDOMElement()
    expect(useSquadCapabilityWarnings).toHaveBeenCalledWith("t1", { audit: true })
  })

  it("names each stale id with its owner and bucket", () => {
    warnings = [
      {
        code: "missing-skill",
        bucket: "skillIds",
        missingId: "ghost-skill",
        scope: { kind: "team", teamId: "t1" },
      },
      {
        code: "missing-subagent",
        bucket: "subagentIds",
        missingId: "plugin-x:ghost",
        scope: { kind: "teammate", teamId: "t1", teammateId: "m1" },
      },
    ]
    render(<CapabilityWarningsNotice teamId="t1" />)
    expect(screen.getByText('title:{"count":2}')).toBeInTheDocument()
    const items = screen.getByRole("list", { name: "listLabel" }).querySelectorAll("li")
    expect(items[0]).toHaveTextContent(
      'entryContext:{"owner":"teamScope","bucket":"buckets.skillIds"} ghost-skill'
    )
    expect(items[1]).toHaveTextContent(
      'entryContext:{"owner":"teammateScope:{\\"name\\":\\"Reviewer\\"}","bucket":"buckets.subagentIds"} plugin-x:ghost'
    )
  })
})
