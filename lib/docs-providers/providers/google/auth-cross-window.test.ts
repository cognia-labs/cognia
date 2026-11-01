import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
import { createGoogleDocsTestHost } from "@/lib/testing/google-docs-host"
import { __setGoogleStatePortForTests, googleState, subscribeGoogleStateChanged } from "./state"

afterEach(() => __setGoogleStatePortForTests(null))

it("reads shared Host state on every renderer snapshot and publishes change signals", async () => {
  const host = createGoogleDocsTestHost()
  __setGoogleStatePortForTests(host.call)
  const listener = jest.fn()
  const stop = subscribeGoogleStateChanged(listener)
  try {
    const first = await googleState(
      { action: "snapshot" },
      { localAuthorization: LOCAL_PERSON_RUN }
    )
    await host.call({ action: "setClientSecret", clientId: "other-renderer", secret: "private" })
    const second = await googleState(
      { action: "snapshot" },
      { localAuthorization: LOCAL_PERSON_RUN }
    )
    expect(first.clients).toEqual([])
    expect(second.clients).toEqual([{ clientId: "other-renderer", hasClientSecret: true }])
    await googleState({ action: "clearClientSecret", clientId: "other-renderer" })
    expect(listener).toHaveBeenCalledTimes(1)
  } finally {
    stop()
  }
})
