/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}(${Object.values(values).join(",")})` : key
    t.has = () => true
    return t
  },
  useFormatter: () => ({
    dateTime: (date: Date) => `date(${date.getTime()})`,
  }),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { toast } from "sonner"
import { CollabError, type CollabOwnerlessSession } from "@/lib/collab/client"
import type { CurrentCollabContext } from "@/lib/collab/runtime-client"

import {
  RECLAIM_REASON_MIN_LENGTH,
  WorkspaceOwnerlessSessions,
} from "./workspace-ownerless-sessions"

function ownerless(overrides: Partial<CollabOwnerlessSession> = {}): CollabOwnerlessSession {
  return {
    sessionId: "ses_1",
    workspaceId: "proj_1",
    status: "active",
    createdByUserId: "usr_ada",
    memberCount: 2,
    createdAt: 1,
    updatedAt: 5,
    ...overrides,
  }
}

function adminWith(
  client: {
    listOwnerlessSessions: jest.Mock
    reclaimSessionOwnership?: jest.Mock
  },
  canManageOrg = true
) {
  const context: CurrentCollabContext = {
    localAccountId: "acct_a",
    orgId: "org_acme",
    userId: "usr_cleo",
    client: client as unknown as CurrentCollabContext["client"],
  }
  return { status: "ready" as const, canManageOrg, context }
}

describe("WorkspaceOwnerlessSessions", () => {
  beforeEach(() => jest.clearAllMocks())

  it("is for org owners and admins only, and asks nothing of anyone else", () => {
    const list = jest.fn(async () => [ownerless()])
    const { container } = render(
      <WorkspaceOwnerlessSessions
        admin={adminWith({ listOwnerlessSessions: list }, false)}
        workspaceId="proj_1"
      />
    )
    expect(container).toBeEmptyDOMElement()
    expect(list).not.toHaveBeenCalled()
  })

  it("stays silent when nothing in this workspace is waiting", async () => {
    const list = jest.fn(async () => [ownerless({ workspaceId: "proj_other" })])
    const { container } = render(
      <WorkspaceOwnerlessSessions
        admin={adminWith({ listOwnerlessSessions: list })}
        workspaceId="proj_1"
      />
    )
    await waitFor(() => expect(list).toHaveBeenCalledWith("org_acme"))
    expect(container).toBeEmptyDOMElement()
  })

  it("lists this workspace's ownerless conversations by metadata only", async () => {
    const list = jest.fn(async () => [
      ownerless(),
      ownerless({ sessionId: "ses_2", workspaceId: "proj_other" }),
    ])
    render(
      <WorkspaceOwnerlessSessions
        admin={adminWith({ listOwnerlessSessions: list })}
        workspaceId="proj_1"
      />
    )
    const row = await screen.findByTestId("workspace-ownerless-ses_1")
    expect(screen.queryByTestId("workspace-ownerless-ses_2")).toBeNull()
    expect(screen.getByTestId("workspace-ownerless-sessions")).toHaveTextContent(
      "ownerless.title(1)"
    )
    expect(row).toHaveTextContent("ownerless.startedBy(usr_ada)")
    expect(row).toHaveTextContent("ownerless.members(2)")
    expect(row).toHaveTextContent("ownerless.changed(date(5))")
  })

  it("takes ownership only with a reason, then reloads and tells the page", async () => {
    let rows = [ownerless()]
    const list = jest.fn(async () => rows)
    const reclaim = jest.fn(async () => {
      rows = []
      return {}
    })
    const onReclaimed = jest.fn()
    render(
      <WorkspaceOwnerlessSessions
        admin={adminWith({ listOwnerlessSessions: list, reclaimSessionOwnership: reclaim })}
        workspaceId="proj_1"
        onReclaimed={onReclaimed}
      />
    )
    fireEvent.click(await screen.findByTestId("workspace-ownerless-reclaim-ses_1"))
    const confirm = screen.getByTestId("workspace-ownerless-confirm")
    fireEvent.change(screen.getByTestId("workspace-ownerless-reason"), {
      target: { value: "x".repeat(RECLAIM_REASON_MIN_LENGTH - 1) },
    })
    expect(confirm).toBeDisabled()
    fireEvent.change(screen.getByTestId("workspace-ownerless-reason"), {
      target: { value: "  Ada left the team  " },
    })
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    await waitFor(() =>
      expect(reclaim).toHaveBeenCalledWith("org_acme", "ses_1", "Ada left the team")
    )
    await waitFor(() => expect(screen.queryByTestId("workspace-ownerless-sessions")).toBeNull())
    expect(toast.success).toHaveBeenCalledWith("ownerless.reclaimed")
    expect(onReclaimed).toHaveBeenCalledTimes(1)
  })

  it("reads a 409 as somebody else owning it now, and a refusal as an error", async () => {
    const list = jest.fn(async () => [ownerless()])
    const reclaim = jest
      .fn()
      .mockRejectedValueOnce(new CollabError(409, "conflict"))
      .mockRejectedValueOnce(new CollabError(403, "forbidden"))
    render(
      <WorkspaceOwnerlessSessions
        admin={adminWith({ listOwnerlessSessions: list, reclaimSessionOwnership: reclaim })}
        workspaceId="proj_1"
      />
    )
    for (const expected of ["success", "error"] as const) {
      fireEvent.click(await screen.findByTestId("workspace-ownerless-reclaim-ses_1"))
      fireEvent.change(screen.getByTestId("workspace-ownerless-reason"), {
        target: { value: "Ada left the team" },
      })
      fireEvent.click(screen.getByTestId("workspace-ownerless-confirm"))
      await waitFor(() => expect(toast[expected]).toHaveBeenCalled())
    }
    expect(toast.success).toHaveBeenCalledWith("ownerless.alreadyOwned")
    expect(toast.error).toHaveBeenCalledWith("toast.failed", { description: "errors.forbidden" })
  })

  it("says so when the list cannot be read", async () => {
    const list = jest.fn(async () => {
      throw new CollabError(500, "storage unavailable")
    })
    render(
      <WorkspaceOwnerlessSessions
        admin={adminWith({ listOwnerlessSessions: list })}
        workspaceId="proj_1"
      />
    )
    expect(await screen.findByTestId("workspace-ownerless-error")).toHaveTextContent(
      "ownerless.failed(errors.server(storage unavailable))"
    )
  })
})
