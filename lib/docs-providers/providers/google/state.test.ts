/** @jest-environment jsdom */
import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  LOCAL_PERSON_RUN,
  startToolExecutionRun,
  finishToolExecutionRun,
} from "@/lib/execution/acting-authority"
jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: { call: jest.fn(), subscribe: jest.fn() },
}))
import { transport } from "@/lib/tauri/transport-instance"
import {
  __setGoogleStatePortForTests,
  googleState,
  subscribeGoogleStateChanged,
  type GoogleStateReply,
} from "./state"
const call = transport.call as jest.Mock
const subscribe = transport.subscribe as jest.Mock
const reply: GoogleStateReply = {
  lineages: [],
  clients: [],
  pending: [],
  migrationNeedsClientId: false,
  backupMigrationNeedsClientId: false,
}
beforeEach(() => {
  jest.clearAllMocks()
  __setGoogleStatePortForTests(null)
  call.mockResolvedValue(reply)
  subscribe.mockReturnValue(jest.fn())
})
afterEach(() => __setGoogleStatePortForTests(null))
it("sends guarded transitions to the selected host without a renderer storage fallback", async () => {
  await expect(
    googleState(
      { action: "accessToken", lineageId: "lineage", minValidityMs: 60_000 },
      { localAuthorization: LOCAL_PERSON_RUN }
    )
  ).resolves.toBe(reply)
  expect(call).toHaveBeenCalledWith("connectors_google_docs_auth", {
    input: { action: "accessToken", lineageId: "lineage", minValidityMs: 60_000 },
  })
})
it.each([
  ["google_docs_state_stale", "connection changed"],
  [new Error("google_docs_state_mismatch"), "oauth state mismatch"],
])("maps host fences to typed authorization errors: %s", async (error, reason) => {
  call.mockRejectedValue(error)
  await expect(
    googleState(
      { action: "complete", state: "s", code: "code" },
      { localAuthorization: LOCAL_PERSON_RUN }
    )
  ).rejects.toMatchObject({
    code: "notAuthorized",
    params: { reason },
  })
})
it("preserves actual storage/transport failures", async () => {
  const error = new Error("disk unavailable")
  call.mockRejectedValue(error)
  await expect(
    googleState(
      { action: "disconnect", lineageId: "lineage" },
      { localAuthorization: LOCAL_PERSON_RUN }
    )
  ).rejects.toBe(error)
})
it("shares the native signal subscription and releases it after the last observer", () => {
  const first = jest.fn(),
    second = jest.fn(),
    stop = jest.fn()
  subscribe.mockReturnValue(stop)
  const offA = subscribeGoogleStateChanged(first),
    offB = subscribeGoogleStateChanged(second)
  try {
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(subscribe.mock.calls[0][0]).toBe("google-docs-connection-changed")
    const signal = subscribe.mock.calls[0][1] as () => void
    signal()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    offA()
    signal()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
    expect(stop).not.toHaveBeenCalled()
  } finally {
    offA()
    offB()
  }
  expect(stop).toHaveBeenCalledTimes(1)
})
it("notifies local observers after mutations, including failed cleanup, but never on reads", async () => {
  const listener = jest.fn()
  const off = subscribeGoogleStateChanged(listener)
  try {
    await googleState({ action: "snapshot" }, { localAuthorization: LOCAL_PERSON_RUN })
    expect(listener).not.toHaveBeenCalled()
    await googleState(
      { action: "begin", clientId: "client", scopes: ["docs:read"] },
      { localAuthorization: LOCAL_PERSON_RUN }
    )
    expect(listener).toHaveBeenCalledTimes(1)
    call.mockRejectedValueOnce(new Error("write failed"))
    await expect(
      googleState(
        { action: "disconnect", lineageId: "lineage" },
        { localAuthorization: LOCAL_PERSON_RUN }
      )
    ).rejects.toThrow("write failed")
    expect(listener).toHaveBeenCalledTimes(2)
  } finally {
    off()
  }
})

it("forwards the backup migration hint through the selected Host transport", async () => {
  await googleState(
    { action: "snapshot", legacyBackupClientId: "backup" },
    { localAuthorization: LOCAL_PERSON_RUN }
  )
  expect(call).toHaveBeenCalledWith("connectors_google_docs_auth", {
    input: { action: "snapshot", legacyBackupClientId: "backup" },
  })
})

it.each([
  { action: "snapshot" },
  { action: "accessToken", lineageId: "lineage" },
  { action: "complete", state: "s", code: "c" },
  { action: "pollDevice", attemptId: "attempt" },
  { action: "disconnect", lineageId: "lineage" },
] as const)(
  "refuses an unproven %s before the native command, including legacy userinfo hydration",
  async (input) => {
    await expect(googleState(input)).rejects.toMatchObject({
      name: "PersonalCredentialRefusedError",
    })
    expect(call).not.toHaveBeenCalled()
  }
)

it("does not let a row proof authorize a global snapshot or a different lineage", async () => {
  const admission = { connectionAuthorization: {} as never, lineageId: "allowed" }
  await expect(googleState({ action: "snapshot" }, admission)).rejects.toMatchObject({
    code: "notAuthorized",
  })
  await expect(
    googleState({ action: "accessToken", lineageId: "other" }, admission)
  ).rejects.toMatchObject({ code: "notAuthorized" })
  expect(call).not.toHaveBeenCalled()
})

it("discards a native credential reply when the real Host run settles while the command awaits", async () => {
  const fixture = createDbTestFixture()
  await fixture.initialize()
  try {
    const run = await startToolExecutionRun(undefined, {
      runId: "native-await-run",
      localAuthorization: LOCAL_PERSON_RUN,
    })
    let finish!: (reply: GoogleStateReply) => void
    call.mockImplementationOnce(
      () =>
        new Promise<GoogleStateReply>((resolve) => {
          finish = resolve
        })
    )
    const pending = googleState(
      { action: "accessToken", lineageId: "allowed" },
      { executionRunId: run.id }
    )
    for (let i = 0; i < 50 && !finish; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    expect(finish).toBeDefined()
    await finishToolExecutionRun(run.id)
    finish({
      ...reply,
      credential: {
        accessToken: "must-not-escape",
        expiresAt: 100,
        revision: "r",
        credentialRevision: "c",
      },
    })
    await expect(pending).rejects.toMatchObject({ name: "PersonalCredentialRefusedError" })
  } finally {
    await fixture.dispose()
  }
})
