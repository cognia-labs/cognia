jest.mock("./personal-marks", () => ({ markPersonalCredential: jest.fn(async () => undefined) }))
import { markPersonalCredential } from "./personal-marks"
/** @jest-environment node */
jest.mock("./acting-authority", () => ({
  LOCAL_PERSON_RUN: Symbol("host-local-person-run"),
  resolveRunActingIdentity: jest.fn(),
}))
jest.mock("./personal-sink", () => ({ readHostPersonContext: jest.fn() }))
import { LOCAL_PERSON_RUN, resolveRunActingIdentity } from "./acting-authority"
import { readHostPersonContext } from "./personal-sink"
import { admitPersonalCredential, LOCAL_PERSON } from "./personal-credential"

const owner = { kind: "platform", platform: "lark", adapterId: "a", remoteUserId: "owner" } as const
const member = {
  kind: "platform",
  platform: "lark",
  adapterId: "a",
  remoteUserId: "member",
} as const
const resolve = jest.mocked(resolveRunActingIdentity)
const local = {
  trigger: "local",
  lane: "legacy",
  requesters: [{ kind: "local-person" }],
  authorizingPrincipal: { kind: "local-person" },
}
beforeEach(() => {
  jest.resetAllMocks()
  jest.mocked(readHostPersonContext).mockResolvedValue({ connectedOwners: [owner] })
})
it("admits only an explicit Host symbol without a run", async () => {
  expect(
    await admitPersonalCredential(undefined, { source: "github-user", person: LOCAL_PERSON })
  ).toMatchObject({
    ok: false,
  })
  expect(
    await admitPersonalCredential(
      { localAuthorization: "local" as never },
      { source: "github-user", person: LOCAL_PERSON }
    )
  ).toMatchObject({ ok: false })
  expect(
    await admitPersonalCredential(
      { localAuthorization: LOCAL_PERSON_RUN },
      { source: "github-user", person: LOCAL_PERSON }
    )
  ).toMatchObject({ ok: true })
  expect(
    await admitPersonalCredential(
      {
        executionRunId: "reserved-turn",
        executionRunReserved: true,
        executionRunParentId: "coordinator",
      },
      { source: "github-user", person: LOCAL_PERSON }
    )
  ).toMatchObject({ ok: false, reason: "missing-identity" })
  expect(resolve).toHaveBeenLastCalledWith(undefined, "reserved-turn", undefined)
})
it.each([
  undefined,
  { ...local, trigger: "external-event" },
  { ...local, trigger: "schedule", authorizingPrincipal: undefined },
  { ...local, lane: "service" },
  { ...local, requesters: [{ kind: "local-person" }, { kind: "local-person" }] },
])("refuses missing or ineligible persisted roots", async (identity) => {
  resolve.mockResolvedValue(identity as never)
  expect(
    await admitPersonalCredential(
      { sessionId: "s", executionRunId: "r" },
      { source: "mcp-oauth", person: LOCAL_PERSON }
    )
  ).toMatchObject({ ok: false })
})
it("admits a desktop root and a schedule with a verified local authorizer", async () => {
  for (const trigger of ["local", "schedule"]) {
    resolve.mockResolvedValue({ ...local, trigger } as never)
    expect(
      await admitPersonalCredential(
        { sessionId: "s", executionRunId: "r" },
        { source: "github-user", person: LOCAL_PERSON }
      )
    ).toMatchObject({ ok: true })
  }
})
it("does not let a Host admission override an executing service run", async () => {
  resolve.mockResolvedValue({ ...local, lane: "service" } as never)
  expect(
    await admitPersonalCredential(
      { sessionId: "s", executionRunId: "r", localAuthorization: LOCAL_PERSON_RUN },
      { source: "google-docs", person: LOCAL_PERSON }
    )
  ).toMatchObject({ ok: false })
})
it("resolves an explicit sessionless execution without inventing a session", async () => {
  resolve.mockResolvedValue(local as never)
  expect(
    await admitPersonalCredential(
      { executionRunId: "standalone" },
      { source: "github-user", person: LOCAL_PERSON }
    )
  ).toMatchObject({ ok: true })
  expect(resolve).toHaveBeenLastCalledWith(undefined, "standalone", undefined)
  resolve.mockResolvedValue(undefined)
  expect(
    await admitPersonalCredential(
      { executionRunId: "missing" },
      { source: "github-user", person: LOCAL_PERSON }
    )
  ).toMatchObject({ ok: false, reason: "missing-identity" })
})
it("admits a delegated requester for their own credential only", async () => {
  const delegated = {
    trigger: "requester",
    lane: "delegated",
    requesters: [member],
    actingPrincipal: member,
  }
  resolve.mockResolvedValue(delegated as never)
  const ctx = { sessionId: "s", executionRunId: "r" }
  expect(await admitPersonalCredential(ctx, { source: "lark-user", person: member })).toEqual({
    ok: true,
    source: "lark-user",
    person: member,
  })
  expect(markPersonalCredential).toHaveBeenCalledWith(ctx, delegated, member, "lark-user")
  expect(await admitPersonalCredential(ctx, { source: "lark-user", person: owner })).toMatchObject({
    ok: false,
    reason: "owner-not-verified",
  })
  expect(
    await admitPersonalCredential(ctx, { source: "mcp-oauth", person: LOCAL_PERSON })
  ).toMatchObject({ ok: false, reason: "owner-not-verified" })
})
it("treats the connected owner and the local person as one person", async () => {
  resolve.mockResolvedValue({
    trigger: "requester",
    lane: "delegated",
    requesters: [owner],
    actingPrincipal: owner,
  } as never)
  expect(
    await admitPersonalCredential(
      { sessionId: "s", executionRunId: "r" },
      { source: "mcp-oauth", person: LOCAL_PERSON }
    )
  ).toMatchObject({ ok: true, person: owner })
  resolve.mockResolvedValue(local as never)
  expect(
    await admitPersonalCredential(
      { sessionId: "s", executionRunId: "r" },
      { source: "lark-user", person: owner }
    )
  ).toMatchObject({ ok: true, person: LOCAL_PERSON })
  expect(
    await admitPersonalCredential(
      { localAuthorization: LOCAL_PERSON_RUN },
      { source: "lark-user", person: member }
    )
  ).toMatchObject({ ok: false, reason: "owner-not-verified" })
})
it.each([
  { trigger: "requester", lane: "legacy", requesters: [owner] },
  { trigger: "external-event", lane: "delegated", requesters: [], actingPrincipal: owner },
  { trigger: "requester", lane: "delegated", requesters: [owner] },
])("never admits an IM run outside the delegated lane", async (identity) => {
  resolve.mockResolvedValue(identity as never)
  expect(
    await admitPersonalCredential(
      { sessionId: "s", executionRunId: "r" },
      { source: "lark-user", person: owner }
    )
  ).toMatchObject({ ok: false, reason: "trigger-not-personal" })
})
it("never exports personal OAuth credentials to an external engine", async () => {
  expect(
    await admitPersonalCredential(
      { localAuthorization: LOCAL_PERSON_RUN, externalEngine: true },
      { source: "mcp-oauth", person: LOCAL_PERSON }
    )
  ).toMatchObject({ ok: false, reason: "external-engine" })
})
it("fails closed on identity storage failure", async () => {
  resolve.mockRejectedValue(new Error("database switched"))
  expect(
    await admitPersonalCredential(
      { sessionId: "s" },
      { source: "github-user", person: LOCAL_PERSON }
    )
  ).toMatchObject({ ok: false })
})

it("applies the same personal rule to non-GitHub integration users", async () => {
  resolve.mockResolvedValue({ ...local, trigger: "external-event" } as never)
  expect(
    await admitPersonalCredential(
      { sessionId: "s", executionRunId: "r" },
      { source: "integration-user", person: LOCAL_PERSON }
    )
  ).toMatchObject({ ok: false })
  expect(
    await admitPersonalCredential(
      { localAuthorization: LOCAL_PERSON_RUN },
      { source: "integration-user", person: LOCAL_PERSON }
    )
  ).toMatchObject({ ok: true })
})

it("limits terminal-run admission to Lark delivery rather than model data access", async () => {
  resolve.mockResolvedValue(local as never)
  const context = { sessionId: "s", executionRunId: "finished", delivery: true }
  await admitPersonalCredential(context, { source: "lark-user", person: LOCAL_PERSON })
  expect(resolve).toHaveBeenLastCalledWith("s", "finished", { delivery: true })
  await admitPersonalCredential(context, { source: "mcp-oauth", person: LOCAL_PERSON })
  expect(resolve).toHaveBeenLastCalledWith("s", "finished", undefined)
})

it("admits Drive backup OAuth only with a verified personal root or Host UI proof", async () => {
  await expect(
    admitPersonalCredential(undefined, { source: "google-drive-backup", person: LOCAL_PERSON })
  ).resolves.toMatchObject({ ok: false })
  await expect(
    admitPersonalCredential(
      { localAuthorization: LOCAL_PERSON_RUN },
      { source: "google-drive-backup", person: LOCAL_PERSON }
    )
  ).resolves.toMatchObject({ ok: true })
  resolve.mockResolvedValue({
    ...local,
    trigger: "schedule",
    authorizingPrincipal: undefined,
  } as never)
  await expect(
    admitPersonalCredential(
      { executionRunId: "scheduled" },
      { source: "google-drive-backup", person: LOCAL_PERSON }
    )
  ).resolves.toMatchObject({ ok: false })
})

it("refuses every successful run admission if its personal mark cannot commit", async () => {
  resolve.mockResolvedValue(local as never)
  jest.mocked(markPersonalCredential).mockRejectedValueOnce(new Error("disk write failed"))
  expect(
    await admitPersonalCredential(
      { executionRunId: "r" },
      { source: "google-docs", person: LOCAL_PERSON }
    )
  ).toMatchObject({ ok: false, reason: "mark-unavailable" })
  expect(markPersonalCredential).toHaveBeenCalledWith(
    { executionRunId: "r" },
    local,
    { kind: "local-person" },
    "google-docs"
  )
})

it("also records a direct Host action when its session resolves to a run", async () => {
  resolve.mockResolvedValue(local as never)
  const context = { sessionId: "s", localAuthorization: LOCAL_PERSON_RUN } as const
  expect(
    await admitPersonalCredential(context, { source: "google-docs", person: LOCAL_PERSON })
  ).toMatchObject({
    ok: true,
  })
  expect(markPersonalCredential).toHaveBeenCalledWith(
    context,
    local,
    { kind: "local-person" },
    "google-docs"
  )
})

it("a content-only network fence never grants credential authority", async () => {
  await expect(
    admitPersonalCredential(
      { personalEgressBlocked: true },
      { source: "mcp-oauth", person: LOCAL_PERSON }
    )
  ).resolves.toMatchObject({ ok: false })
})
