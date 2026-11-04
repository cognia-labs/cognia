jest.mock("./personal-marks", () => ({ markPersonalCredential: jest.fn(async () => undefined) }))
import { markPersonalCredential } from "./personal-marks"
/** @jest-environment node */
jest.mock("./acting-authority", () => ({
  LOCAL_PERSON_RUN: Symbol("host-local-person-run"),
  resolveRunActingIdentity: jest.fn(),
}))
jest.mock("@/lib/skills/built-in/lark/acting-identity", () => ({
  verifyLarkImOwnerAuthorization: jest.fn(),
  verifiedLarkAuthorizationPerson: (authorization: { person?: unknown }) => authorization.person,
}))
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsLarkUserAuth: jest.fn(),
}))
import { LOCAL_PERSON_RUN, resolveRunActingIdentity } from "./acting-authority"
import { admitPersonalCredential } from "./personal-credential"
import { verifyLarkImOwnerAuthorization } from "@/lib/skills/built-in/lark/acting-identity"

const resolve = jest.mocked(resolveRunActingIdentity)
const local = {
  trigger: "local",
  lane: "legacy",
  requesters: [{ kind: "local-person" }],
  authorizingPrincipal: { kind: "local-person" },
}
beforeEach(() => jest.resetAllMocks())
it("admits only an explicit Host symbol without a run", async () => {
  expect(await admitPersonalCredential(undefined, { source: "github-user" })).toMatchObject({
    ok: false,
  })
  expect(
    await admitPersonalCredential(
      { localAuthorization: "local" as never },
      { source: "github-user" }
    )
  ).toMatchObject({ ok: false })
  expect(
    await admitPersonalCredential(
      { localAuthorization: LOCAL_PERSON_RUN },
      { source: "github-user" }
    )
  ).toMatchObject({ ok: true })
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
    await admitPersonalCredential({ sessionId: "s", executionRunId: "r" }, { source: "mcp-oauth" })
  ).toMatchObject({ ok: false })
})
it("admits a desktop root and a schedule with a verified local authorizer", async () => {
  for (const trigger of ["local", "schedule"]) {
    resolve.mockResolvedValue({ ...local, trigger } as never)
    expect(
      await admitPersonalCredential(
        { sessionId: "s", executionRunId: "r" },
        { source: "github-user" }
      )
    ).toMatchObject({ ok: true })
  }
})
it("does not let a Host admission override an executing service run", async () => {
  resolve.mockResolvedValue({ ...local, lane: "service" } as never)
  expect(
    await admitPersonalCredential(
      { sessionId: "s", executionRunId: "r", localAuthorization: LOCAL_PERSON_RUN },
      { source: "google-docs" }
    )
  ).toMatchObject({ ok: false })
})
it("resolves an explicit sessionless execution without inventing a session", async () => {
  resolve.mockResolvedValue(local as never)
  expect(
    await admitPersonalCredential({ executionRunId: "standalone" }, { source: "github-user" })
  ).toMatchObject({ ok: true })
  expect(resolve).toHaveBeenLastCalledWith(undefined, "standalone", undefined)
  resolve.mockResolvedValue(undefined)
  expect(
    await admitPersonalCredential({ executionRunId: "missing" }, { source: "github-user" })
  ).toMatchObject({ ok: false, reason: "missing-identity" })
})
it("keeps the IM owner exception exclusive to Lark", async () => {
  resolve.mockResolvedValue({ ...local, trigger: "requester" } as never)
  jest.mocked(verifyLarkImOwnerAuthorization).mockResolvedValue({
    accessToken: "owner",
    authorizationEpoch: "e",
    person: { kind: "platform", platform: "lark", adapterId: "a", remoteUserId: "owner" },
  } as never)
  const ctx = { sessionId: "s", executionRunId: "r", larkContext: { sessionId: "s" } }
  expect(await admitPersonalCredential(ctx, { source: "lark-user", person: "a" })).toMatchObject({
    ok: true,
    authorization: { authorizationEpoch: "e" },
  })
  expect(await admitPersonalCredential(ctx, { source: "mcp-oauth" })).toMatchObject({ ok: false })
})
it("never exports personal OAuth credentials to an external engine", async () => {
  expect(
    await admitPersonalCredential(
      { localAuthorization: LOCAL_PERSON_RUN, externalEngine: true },
      { source: "mcp-oauth" }
    )
  ).toMatchObject({ ok: false, reason: "external-engine" })
})
it("fails closed on identity storage failure", async () => {
  resolve.mockRejectedValue(new Error("database switched"))
  expect(
    await admitPersonalCredential({ sessionId: "s" }, { source: "github-user" })
  ).toMatchObject({ ok: false })
})

it("applies the same personal rule to non-GitHub integration users", async () => {
  resolve.mockResolvedValue({ ...local, trigger: "external-event" } as never)
  expect(
    await admitPersonalCredential(
      { sessionId: "s", executionRunId: "r" },
      { source: "integration-user" }
    )
  ).toMatchObject({ ok: false })
  expect(
    await admitPersonalCredential(
      { localAuthorization: LOCAL_PERSON_RUN },
      { source: "integration-user" }
    )
  ).toMatchObject({ ok: true })
})

it("limits terminal-run admission to Lark delivery rather than model data access", async () => {
  resolve.mockResolvedValue(local as never)
  const context = { sessionId: "s", executionRunId: "finished", delivery: true }
  await admitPersonalCredential(context, { source: "lark-user" })
  expect(resolve).toHaveBeenLastCalledWith("s", "finished", { delivery: true })
  await admitPersonalCredential(context, { source: "mcp-oauth" })
  expect(resolve).toHaveBeenLastCalledWith("s", "finished", undefined)
})

it("admits Drive backup OAuth only with a verified personal root or Host UI proof", async () => {
  await expect(
    admitPersonalCredential(undefined, { source: "google-drive-backup" })
  ).resolves.toMatchObject({ ok: false })
  await expect(
    admitPersonalCredential(
      { localAuthorization: LOCAL_PERSON_RUN },
      { source: "google-drive-backup" }
    )
  ).resolves.toMatchObject({ ok: true })
  resolve.mockResolvedValue({
    ...local,
    trigger: "schedule",
    authorizingPrincipal: undefined,
  } as never)
  await expect(
    admitPersonalCredential({ executionRunId: "scheduled" }, { source: "google-drive-backup" })
  ).resolves.toMatchObject({ ok: false })
})

it("refuses every successful run admission if its personal mark cannot commit", async () => {
  resolve.mockResolvedValue(local as never)
  jest.mocked(markPersonalCredential).mockRejectedValueOnce(new Error("disk write failed"))
  expect(
    await admitPersonalCredential({ executionRunId: "r" }, { source: "google-docs" })
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
  expect(await admitPersonalCredential(context, { source: "google-docs" })).toMatchObject({
    ok: true,
  })
  expect(markPersonalCredential).toHaveBeenCalledWith(
    context,
    local,
    { kind: "local-person" },
    "google-docs"
  )
})
