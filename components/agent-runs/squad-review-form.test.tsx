/** @jest-environment jsdom */

import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { AgentTeamChildRun } from "@cognia/agent-orchestration"

let liveChildren: (AgentTeamChildRun | undefined)[] = []
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => liveChildren }))

jest.mock("next-intl", () => ({
  useTranslations: (ns?: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${ns}.${key}:${JSON.stringify(values)}` : `${ns}.${key}`,
}))

import { SquadReviewForm, isRenderableSquadReview } from "./squad-review-form"
import type { SquadReviewKind } from "@/types/execution/run"
import { RECOVERY_REASONS } from "@/lib/squads/durable/team-recovery"
import en from "@/i18n/messages/en/agentRuns.json"
import zh from "@/i18n/messages/zh-CN/agentRuns.json"

function interrupt(reviewKind: SquadReviewKind, subject?: Record<string, unknown>) {
  return { id: "int-1", reviewKind, expiresAt: 1, ...(subject ? { subject } : {}) }
}

const recoveryChild = (overrides: Partial<AgentTeamChildRun> = {}): AgentTeamChildRun =>
  ({
    id: "c1",
    status: "needs_input",
    attempt: 2,
    dispatchEpoch: 3,
    hostRef: "device:a",
    remoteSessionId: "remote-1",
    stop: { state: "unconfirmed", epoch: 3, requestedAt: 1 },
    ...overrides,
  }) as AgentTeamChildRun

describe("SquadReviewForm", () => {
  beforeEach(() => {
    liveChildren = []
  })
  it.each(Array.from(RECOVERY_REASONS))(
    "translates recovery reason %s in both supported locales",
    (reason) => {
      for (const messages of [en, zh]) {
        expect(messages.review.recovery.reasons).toHaveProperty(reason, expect.any(String))
        expect(
          (messages.review.recovery.reasons as Record<string, string>)[reason].trim()
        ).not.toBe("")
      }
    }
  )

  it("renders nothing for an interrupt that is not a Squad review", () => {
    expect(isRenderableSquadReview({ reviewKind: undefined })).toBe(false)
    const { container } = render(
      <SquadReviewForm
        interrupt={{ id: "x", reviewKind: undefined, expiresAt: 1 }}
        onDecide={() => {}}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("plan: approves with redactable feedback and denies with the same text", async () => {
    const onDecide = jest.fn()
    render(<SquadReviewForm interrupt={interrupt("plan")} onDecide={onDecide} />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("agentRuns.review.plan.feedbackLabel"), "tighter")
    await user.click(screen.getByRole("button", { name: "agentRuns.review.kinds.plan.approve" }))
    expect(onDecide).toHaveBeenLastCalledWith("approve", { kind: "plan", feedback: "tighter" })
    await user.click(screen.getByRole("button", { name: "agentRuns.review.kinds.plan.deny" }))
    expect(onDecide).toHaveBeenLastCalledWith("deny", { kind: "plan", feedback: "tighter" })
  })

  it("capability audit: lists the stale ids and approves with no payload fields", async () => {
    const onDecide = jest.fn()
    render(
      <SquadReviewForm
        interrupt={interrupt("capability_audit", { missingCapabilities: ["cap.a", "cap.b"] })}
        onDecide={onDecide}
      />
    )
    expect(screen.getByText("cap.a")).toBeInTheDocument()
    await userEvent
      .setup()
      .click(
        screen.getByRole("button", { name: "agentRuns.review.kinds.capability_audit.approve" })
      )
    expect(onDecide).toHaveBeenCalledWith("approve", { kind: "capability_audit" })
  })

  it("budget: submits the integer amount and refuses a non-positive one", async () => {
    const onDecide = jest.fn()
    render(<SquadReviewForm interrupt={interrupt("budget_extension")} onDecide={onDecide} />)
    const user = userEvent.setup()
    const input = screen.getByLabelText("agentRuns.review.budget.extraTokensLabel")
    await user.clear(input)
    await user.type(input, "0")
    expect(
      screen.getByRole("button", { name: "agentRuns.review.kinds.budget_extension.approve" })
    ).toBeDisabled()
    await user.clear(input)
    await user.type(input, "120000")
    await user.click(
      screen.getByRole("button", { name: "agentRuns.review.kinds.budget_extension.approve" })
    )
    expect(onDecide).toHaveBeenCalledWith("approve", {
      kind: "budget_extension",
      extraTokens: 120000,
    })
  })

  it("deadlock: needs a teammate or reset-all before it can approve", async () => {
    const onDecide = jest.fn()
    render(
      <SquadReviewForm
        interrupt={interrupt("deadlock", { teammateIds: ["m1", "m2"] })}
        onDecide={onDecide}
      />
    )
    const user = userEvent.setup()
    const approve = screen.getByRole("button", { name: "agentRuns.review.kinds.deadlock.approve" })
    expect(approve).toBeDisabled()
    await user.click(screen.getByLabelText("m2"))
    await user.click(approve)
    expect(onDecide).toHaveBeenLastCalledWith("approve", { kind: "deadlock", teammateIds: ["m2"] })
    await user.click(screen.getByLabelText("agentRuns.review.deadlock.resetAll"))
    await user.click(approve)
    expect(onDecide).toHaveBeenLastCalledWith("approve", { kind: "deadlock", resetAll: true })
  })

  it("teammate repair: defaults to rejoin and can switch to skip", async () => {
    const onDecide = jest.fn()
    render(<SquadReviewForm interrupt={interrupt("teammate_repair")} onDecide={onDecide} />)
    const user = userEvent.setup()
    const approve = screen.getByRole("button", {
      name: "agentRuns.review.kinds.teammate_repair.approve",
    })
    await user.click(approve)
    expect(onDecide).toHaveBeenLastCalledWith("approve", {
      kind: "teammate_repair",
      action: "rejoin",
    })
    await user.click(screen.getByLabelText("agentRuns.review.teammateRepair.skip"))
    await user.click(approve)
    expect(onDecide).toHaveBeenLastCalledWith("approve", {
      kind: "teammate_repair",
      action: "skip",
    })
  })

  it("recovery: offers only the choices the interrupt carries and needs a host for retry_host", async () => {
    const onDecide = jest.fn()
    render(
      <SquadReviewForm
        interrupt={interrupt("team_recovery", {
          reason: "legacy_run_not_resumable",
          choices: ["restart_run", "terminate"],
          uncertainChildIds: [],
        })}
        onDecide={onDecide}
      />
    )
    expect(
      screen.queryByLabelText("agentRuns.review.recovery.choices.retry_same_host")
    ).not.toBeInTheDocument()
    expect(
      screen.getByText(
        'agentRuns.review.recovery.reason:{"reason":"agentRuns.review.recovery.reasons.legacy_run_not_resumable"}'
      )
    ).toBeInTheDocument()
    const user = userEvent.setup()
    const approve = screen.getByRole("button", {
      name: "agentRuns.review.kinds.team_recovery.approve",
    })
    expect(approve).toBeDisabled()
    await user.click(screen.getByLabelText("agentRuns.review.recovery.choices.restart_run"))
    await user.click(approve)
    expect(onDecide).toHaveBeenCalledWith("approve", {
      kind: "team_recovery",
      choice: "restart_run",
    })
  })

  it("recovery: retry_host stays disabled until a host is named", async () => {
    liveChildren = [
      recoveryChild({
        stop: {
          state: "confirmed",
          epoch: 3,
          requestedAt: 1,
          proof: { kind: "ack", epoch: 3, at: 1 },
        },
      }),
    ]
    const onDecide = jest.fn()
    render(
      <SquadReviewForm
        interrupt={interrupt("team_recovery", { uncertainChildIds: ["c1"] })}
        onDecide={onDecide}
      />
    )
    const user = userEvent.setup()
    await user.click(screen.getByLabelText("agentRuns.review.recovery.choices.retry_host"))
    const approve = screen.getByRole("button", {
      name: "agentRuns.review.kinds.team_recovery.approve",
    })
    expect(approve).toBeDisabled()
    await user.type(screen.getByLabelText("agentRuns.review.recovery.hostRefPlaceholder"), "host-b")
    await user.click(approve)
    expect(onDecide).toHaveBeenCalledWith("approve", {
      kind: "team_recovery",
      choice: "retry_host",
      hostRef: "host-b",
    })
  })

  it("recovery: shows every uncertain child's attempt, stop proof, epoch and host", () => {
    liveChildren = [
      recoveryChild({
        stop: {
          state: "confirmed",
          epoch: 3,
          requestedAt: 1,
          proof: { kind: "ack", epoch: 3, at: 1 },
        },
      }),
      recoveryChild({
        id: "c2",
        attempt: 4,
        dispatchEpoch: 5,
        hostRef: "device:b",
        stop: { state: "requested", epoch: 5, requestedAt: 1 },
      }),
    ]
    render(
      <SquadReviewForm
        interrupt={interrupt("team_recovery", { uncertainChildIds: ["c1", "c2"] })}
        onDecide={jest.fn()}
      />
    )
    for (const text of [
      "c1",
      "c2",
      'agentRuns.review.recovery.attempt:{"value":2}',
      'agentRuns.review.recovery.attempt:{"value":4}',
      'agentRuns.review.recovery.epoch:{"value":3}',
      'agentRuns.review.recovery.epoch:{"value":5}',
      'agentRuns.review.recovery.host:{"value":"device:a"}',
      'agentRuns.review.recovery.host:{"value":"device:b"}',
    ])
      expect(screen.getByText(text)).toBeInTheDocument()
    expect(screen.getAllByText(/recovery.attemptStatus/)).toHaveLength(2)
    expect(screen.getByText(/recovery.stop.proof.ack/)).toBeInTheDocument()
    expect(screen.getByText(/recovery.stop.requested/)).toBeInTheDocument()
    expect(screen.getByText(/recovery.stop.noProof/)).toBeInTheDocument()
  })

  it("recovery: offers only manual decisions without stop proof and preserves their payloads", async () => {
    liveChildren = [recoveryChild()]
    const onDecide = jest.fn()
    render(
      <SquadReviewForm
        interrupt={interrupt("team_recovery", { uncertainChildIds: ["c1"] })}
        onDecide={onDecide}
      />
    )
    for (const choice of ["retry_same_host", "retry_host"]) {
      const option = screen.getByRole("radio", {
        name: `agentRuns.review.recovery.choices.${choice}`,
      })
      expect(option).toBeDisabled()
      expect(option).toHaveAccessibleDescription("agentRuns.review.recovery.stop.retryBlocked")
    }
    const user = userEvent.setup()
    const approve = screen.getByRole("button", {
      name: "agentRuns.review.kinds.team_recovery.approve",
    })
    for (const choice of ["restart_run", "terminate"]) {
      await user.click(screen.getByLabelText(`agentRuns.review.recovery.choices.${choice}`))
      await user.click(approve)
      expect(onDecide).toHaveBeenLastCalledWith("approve", { kind: "team_recovery", choice })
    }
    await user.click(
      screen.getByRole("button", { name: "agentRuns.review.kinds.team_recovery.deny" })
    )
    expect(onDecide).toHaveBeenLastCalledWith("deny", undefined)
  })

  it("recovery: refuses retry while child records are missing", () => {
    liveChildren = [undefined]
    render(
      <SquadReviewForm
        interrupt={interrupt("team_recovery", { uncertainChildIds: ["c1"] })}
        onDecide={jest.fn()}
      />
    )
    expect(screen.getByText("agentRuns.review.recovery.detailsUnavailable")).toBeInTheDocument()
    expect(
      screen.getByRole("radio", { name: "agentRuns.review.recovery.choices.retry_same_host" })
    ).toBeDisabled()
  })

  it("recovery: invalidates a selected retry if its live proof disappears", async () => {
    liveChildren = [
      recoveryChild({
        stop: {
          state: "confirmed",
          epoch: 3,
          requestedAt: 1,
          proof: { kind: "ack", epoch: 3, at: 1 },
        },
      }),
    ]
    const onDecide = jest.fn()
    const props = { interrupt: interrupt("team_recovery", { uncertainChildIds: ["c1"] }), onDecide }
    const view = render(<SquadReviewForm {...props} />)
    await userEvent
      .setup()
      .click(screen.getByLabelText("agentRuns.review.recovery.choices.retry_same_host"))
    expect(
      screen.getByRole("button", { name: "agentRuns.review.kinds.team_recovery.approve" })
    ).toBeEnabled()
    liveChildren = [recoveryChild()]
    view.rerender(<SquadReviewForm {...props} />)
    expect(
      screen.getByRole("button", { name: "agentRuns.review.kinds.team_recovery.approve" })
    ).toBeDisabled()
  })

  it("recovery: derives expiry live and releases retry without changing the interrupt", () => {
    jest.useFakeTimers()
    jest.setSystemTime(6_000)
    liveChildren = [
      recoveryChild({
        fenceCapable: true,
        lastRenewalSentAt: 1_000,
        leaseTtlMs: 5_000,
        fenceGraceMs: 1_000,
      }),
    ]
    try {
      const view = render(
        <SquadReviewForm
          interrupt={interrupt("team_recovery", { uncertainChildIds: ["c1"] })}
          onDecide={jest.fn()}
        />
      )
      expect(
        screen.getByRole("radio", { name: "agentRuns.review.recovery.choices.retry_same_host" })
      ).toBeDisabled()
      act(() => jest.advanceTimersByTime(1_000))
      expect(screen.getByText(/recovery.stop.proof.fence-expiry/)).toBeInTheDocument()
      expect(
        screen.getByRole("radio", { name: "agentRuns.review.recovery.choices.retry_same_host" })
      ).toBeEnabled()
      view.unmount()
    } finally {
      jest.useRealTimers()
    }
  })

  it("recovery: shows control loss for a detached failed remote attempt", () => {
    liveChildren = [
      recoveryChild({
        status: "failed",
        error: "Worker connection conn-1 detached: grant_revoked",
      }),
    ]
    render(
      <SquadReviewForm
        interrupt={interrupt("team_recovery", { uncertainChildIds: ["c1"] })}
        onDecide={jest.fn()}
      />
    )
    expect(screen.getByText(/recovery.stop.controlLost/)).toBeInTheDocument()
    expect(screen.queryByText(/operations.status.failed/)).not.toBeInTheDocument()
  })

  it("disables both buttons while a command is in flight", () => {
    render(<SquadReviewForm interrupt={interrupt("replan")} busy onDecide={() => {}} />)
    expect(
      screen.getByRole("button", { name: "agentRuns.review.kinds.replan.approve" })
    ).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "agentRuns.review.kinds.replan.deny" })
    ).toBeDisabled()
  })
})
