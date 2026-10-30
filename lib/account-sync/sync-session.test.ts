import { spaceIdFor } from "@cognia/sync-protocol"

import { officialDeployment } from "@/lib/identity/official-deployment"
import type { LogtoSession } from "@/lib/logto/client"

import { officialSyncSession as readOfficialSyncSession } from "./sync-session"

const deployment = officialDeployment({})!
const owner = {
  localAccountId: "local_1",
  userId: "usr_abc",
  logtoSubject: "usr_abc",
  logtoIssuer: deployment.issuer,
  boundAt: 1,
  updatedAt: 1,
}
const officialSyncSession = (deps: Parameters<typeof readOfficialSyncSession>[0] = {}) =>
  readOfficialSyncSession({ registry: { get: async () => owner }, ...deps })

function token(sub: string): string {
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${b64({ alg: "ES256" })}.${b64({ sub })}.sig`
}

function session(sub: string, issuer = deployment.issuer): LogtoSession {
  return {
    issuer,
    clientId: "cognia-app",
    resource: deployment.audience,
    accessToken: token(sub),
    scopes: [],
  }
}

describe("officialSyncSession", () => {
  it("names the person, their space and the sync Worker", async () => {
    const getSession = jest.fn(async () => session("usr_abc"))
    const result = await officialSyncSession({
      localAccountId: "local_1",
      deployment,
      getSession,
      syncUrl: "https://sync.test",
    })
    expect(result).toMatchObject({
      localAccountId: "local_1",
      issuer: deployment.issuer,
      userId: "usr_abc",
      spaceId: await spaceIdFor(deployment.issuer, "usr_abc"),
      syncUrl: "https://sync.test",
    })
    expect(await result!.accessToken()).toBe(token("usr_abc"))
    expect(getSession).toHaveBeenCalledWith({ localAccountId: "local_1" })
  })

  it("is null without an official session", async () => {
    expect(await officialSyncSession({ deployment, getSession: async () => null })).toBeNull()
    expect(
      await officialSyncSession({
        deployment,
        getSession: async () => session("usr_abc", "https://self.host/api/auth"),
      })
    ).toBeNull()
    expect(
      await officialSyncSession({ deployment, getSession: async () => session("someone") })
    ).toBeNull()
    expect(
      await officialSyncSession({ deployment: null, getSession: async () => session("usr_abc") })
    ).toBeNull()
  })

  it("stops handing out tokens once the profile is signed in as someone else", async () => {
    let current: LogtoSession | null = session("usr_abc")
    const result = await officialSyncSession({ deployment, getSession: async () => current })
    current = session("usr_other")
    expect(await result!.accessToken()).toBeNull()
    current = null
    expect(await result!.accessToken()).toBeNull()
  })

  it("requires matching active profile ownership before choosing a space or returning tokens", async () => {
    const getSession = async () => session("usr_abc")
    for (const mismatch of [
      null,
      { ...owner, logtoSubject: "usr_someone_else" },
      { ...owner, logtoIssuer: "https://another.test" },
    ]) {
      expect(
        await officialSyncSession({
          deployment,
          getSession,
          registry: { get: async () => mismatch },
        })
      ).toBeNull()
    }
    let active = true
    const result = await officialSyncSession({
      deployment,
      getSession,
      registry: { get: async () => (active ? owner : null) },
    })
    expect(result).not.toBeNull()
    active = false
    expect(await result!.accessToken()).toBeNull()
  })
})
