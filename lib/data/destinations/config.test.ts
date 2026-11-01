/** @jest-environment jsdom */
import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
import type { AppSettings } from "@cognia/agent-config-types"

const settingsState: { current: Partial<AppSettings> } = { current: {} }
const saveSettingsMock = jest.fn(async (patch: Partial<AppSettings>) => {
  settingsState.current = { ...settingsState.current, ...patch }
  return settingsState.current as AppSettings
})
jest.mock("@/lib/db/settings", () => ({
  getSettings: async () => settingsState.current,
  saveSettings: (input: Partial<AppSettings> | ((current: AppSettings) => Partial<AppSettings>)) =>
    saveSettingsMock(
      typeof input === "function" ? input(settingsState.current as AppSettings) : input
    ),
}))

const providerSessions: Record<string, unknown[]> = {}
const requestCredentials: Record<string, () => Promise<{ accessToken: string }>> = {}
const resolveRequestCredential = jest.fn(async () => ({ accessToken: "installation-token" }))
jest.mock("@/lib/plugin/auth/auth-provider-registry", () => ({
  getProvider: (id: string) =>
    providerSessions[id]
      ? {
          id,
          pluginId: null,
          getSessions: async () => providerSessions[id],
          resolveRequestCredential:
            requestCredentials[id] ?? (id === "github-app" ? resolveRequestCredential : undefined),
        }
      : undefined,
}))

const driveAuthState = { bound: false, secret: false }
jest.mock("./google-oauth", () => ({
  resolveGoogleDriveConnection: async () => (driveAuthState.bound ? { id: "connection" } : null),
}))
jest.mock("@/lib/docs-providers/providers/google/state", () => ({
  googleState: async () => ({
    clients: [{ clientId: "cid", hasClientSecret: driveAuthState.secret }],
  }),
}))

import {
  DEFAULT_GITHUB_BACKUP_PATH,
  DEFAULT_GOOGLE_DRIVE_FOLDER_NAME,
  __setBackupDestinationSecretStoreForTesting,
  clearGithubBackupToken,
  describeBackupDestinationReadiness,
  getBackupDestinationsSettings,
  getGithubBackupToken,
  isDeprecatedBackupDestination,
  normalizeGithubPath,
  parseRepoFullName,
  resolveGithubBackupConfig,
  resolveGoogleDriveBackupConfig,
  setGithubBackupToken,
  updateBackupDestinationsSettings,
} from "./config"

class MemoryStore {
  data = new Map<string, string>()
  async save(k: string, v: string) {
    this.data.set(k, v)
  }
  async load(k: string) {
    return this.data.get(k) ?? null
  }
  async delete(k: string) {
    this.data.delete(k)
  }
}

let store: MemoryStore

beforeEach(() => {
  store = new MemoryStore()
  __setBackupDestinationSecretStoreForTesting(store)
  driveAuthState.bound = false
  driveAuthState.secret = false
  settingsState.current = {}
  saveSettingsMock.mockClear()
  for (const key of Object.keys(providerSessions)) delete providerSessions[key]
  for (const key of Object.keys(requestCredentials)) delete requestCredentials[key]
})

afterAll(() => __setBackupDestinationSecretStoreForTesting(null))

describe("repo/path normalisation", () => {
  it("parses owner/name in several spellings", () => {
    expect(parseRepoFullName("octo/repo")).toEqual({ owner: "octo", repo: "repo" })
    expect(parseRepoFullName(" https://github.com/octo/repo.git ")).toEqual({
      owner: "octo",
      repo: "repo",
    })
    expect(parseRepoFullName("octo")).toBeNull()
    expect(parseRepoFullName("-bad/repo")).toBeNull()
    expect(parseRepoFullName(undefined)).toBeNull()
  })

  it("normalises the in-repo path and refuses traversal", () => {
    expect(normalizeGithubPath(undefined)).toBe(DEFAULT_GITHUB_BACKUP_PATH)
    expect(normalizeGithubPath("/backups/cognia/")).toBe("backups/cognia")
    expect(normalizeGithubPath("../etc")).toBe(DEFAULT_GITHUB_BACKUP_PATH)
  })

  it("flags convex as deprecated", () => {
    expect(isDeprecatedBackupDestination("convex")).toBe(true)
    expect(isDeprecatedBackupDestination("github")).toBe(false)
    expect(isDeprecatedBackupDestination(undefined)).toBe(false)
  })
})

describe("settings access", () => {
  it("reads, patches and functionally updates backupDestinations", async () => {
    expect(await getBackupDestinationsSettings()).toEqual({})
    await updateBackupDestinationsSettings({ github: { enabled: true, repo: "o/r" } })
    expect(saveSettingsMock).toHaveBeenLastCalledWith({
      backupDestinations: { github: { enabled: true, repo: "o/r" } },
    })
    await updateBackupDestinationsSettings((current) => ({
      ...current,
      googleDrive: { enabled: true, clientId: "cid" },
    }))
    expect((await getBackupDestinationsSettings()).googleDrive).toEqual({
      enabled: true,
      clientId: "cid",
    })
  })

  it("tolerates a failing settings read", async () => {
    settingsState.current = null as unknown as Partial<AppSettings>
    expect(await getBackupDestinationsSettings()).toEqual({})
  })
})

describe("github config + token", () => {
  it("resolves a Host PAT handle only after personal admission", async () => {
    providerSessions["github-pat"] = [
      { id: "pat", accessToken: "host-resolved", account: { id: "person" } },
    ]
    const resolve = jest.fn(async () => ({ accessToken: "actual-personal-pat" }))
    requestCredentials["github-pat"] = resolve
    const credential = { kind: "auth-session", providerId: "github-pat", sessionId: "pat" } as const
    await expect(getGithubBackupToken(credential)).rejects.toMatchObject({
      name: "PersonalCredentialRefusedError",
    })
    expect(resolve).not.toHaveBeenCalled()
    await expect(
      getGithubBackupToken(credential, { localAuthorization: LOCAL_PERSON_RUN })
    ).resolves.toBe("actual-personal-pat")
    expect(resolve).toHaveBeenCalledTimes(1)
  })
  it("resolves an enabled config with defaults and the keyring credential", () => {
    expect(resolveGithubBackupConfig(undefined)).toBeNull()
    expect(resolveGithubBackupConfig({ enabled: false, repo: "o/r" })).toBeNull()
    expect(
      resolveGithubBackupConfig({ enabled: false, repo: "o/r" }, { requireEnabled: false })
    ).toMatchObject({
      repoFullName: "o/r",
    })
    expect(resolveGithubBackupConfig({ enabled: true, repo: "nope" })).toBeNull()
    expect(
      resolveGithubBackupConfig({ enabled: true, repo: "o/r", branch: " main ", path: "/x/" })
    ).toEqual({
      owner: "o",
      repo: "r",
      repoFullName: "o/r",
      branch: "main",
      path: "x",
      credential: { kind: "keyring" },
    })
  })

  it("stores, loads and clears the keyring token", async () => {
    await expect(setGithubBackupToken("  ")).rejects.toThrow(/empty/)
    await setGithubBackupToken(" ghp_x ")
    expect(
      await getGithubBackupToken({ kind: "keyring" }, { localAuthorization: LOCAL_PERSON_RUN })
    ).toBe("ghp_x")
    await clearGithubBackupToken()
    expect(
      await getGithubBackupToken({ kind: "keyring" }, { localAuthorization: LOCAL_PERSON_RUN })
    ).toBeNull()
  })

  it("reuses github-pat / github-app auth sessions", async () => {
    providerSessions["github-pat"] = [{ id: "s1", accessToken: "pat-token", account: { id: "a" } }]
    providerSessions["github-app"] = [{ id: "s2", accessToken: "jwt", account: { id: "b" } }]
    expect(
      await getGithubBackupToken(
        {
          kind: "auth-session",
          providerId: "github-pat",
          sessionId: "s1",
        },
        { localAuthorization: LOCAL_PERSON_RUN }
      )
    ).toBe("pat-token")
    expect(
      await getGithubBackupToken(
        {
          kind: "auth-session",
          providerId: "github-app",
          sessionId: "s2",
        },
        { localAuthorization: LOCAL_PERSON_RUN }
      )
    ).toBe("installation-token")
    await expect(
      getGithubBackupToken({ kind: "auth-session", providerId: "github-app", sessionId: "s2" })
    ).resolves.toBe("installation-token")
    expect(resolveRequestCredential).toHaveBeenCalledWith("s2", {
      connectorAccountId: "b",
      origin: "https://api.github.com",
    })
    expect(
      await getGithubBackupToken(
        {
          kind: "auth-session",
          providerId: "github-pat",
          sessionId: "missing",
        },
        { localAuthorization: LOCAL_PERSON_RUN }
      )
    ).toBeNull()
    expect(
      await getGithubBackupToken(
        {
          kind: "auth-session",
          providerId: "github-app",
          sessionId: "s2",
        },
        { localAuthorization: LOCAL_PERSON_RUN }
      )
    ).toBe("installation-token")
    delete providerSessions["github-pat"]
    expect(
      await getGithubBackupToken(
        {
          kind: "auth-session",
          providerId: "github-pat",
          sessionId: "s1",
        },
        { localAuthorization: LOCAL_PERSON_RUN }
      )
    ).toBeNull()
  })
})

describe("google drive config + secrets", () => {
  it("resolves the config with a default folder name", () => {
    expect(resolveGoogleDriveBackupConfig(undefined)).toBeNull()
    expect(resolveGoogleDriveBackupConfig({ enabled: true })).toBeNull()
    expect(resolveGoogleDriveBackupConfig({ enabled: true, clientId: " cid " })).toEqual({
      clientId: "cid",
      folderName: DEFAULT_GOOGLE_DRIVE_FOLDER_NAME,
      folderId: undefined,
    })
    expect(
      resolveGoogleDriveBackupConfig(
        { enabled: false, clientId: "cid", folderId: "f" },
        { requireEnabled: false }
      )
    ).toMatchObject({ folderId: "f" })
  })
})

describe("readiness matrix", () => {
  it("lists the registry, and requires both Host encryption and destination credentials", async () => {
    const { clearSyncPassphrase, setSyncPassphrase } = await import("@/lib/webdav/passphrase-cache")
    clearSyncPassphrase()
    let readiness = await describeBackupDestinationReadiness()
    expect(readiness.map((row) => row.destination)).toEqual([
      "local",
      "webdav",
      "github",
      "googledrive",
    ])
    expect(readiness.find((row) => row.destination === "github")).toMatchObject({
      state: "needs-setup",
      reasonKey: "syncPassphraseLocked",
    })
    setSyncPassphrase("sync-pass")
    readiness = await describeBackupDestinationReadiness()
    expect(readiness.find((row) => row.destination === "github")).toMatchObject({
      state: "needs-setup",
      reasonKey: "github",
    })
    settingsState.current = {
      backupDestinations: {
        github: { enabled: true, repo: "o/r" },
        googleDrive: { enabled: true, clientId: "cid" },
      },
    }
    driveAuthState.bound = true
    driveAuthState.secret = true
    await setGithubBackupToken("github-token")
    readiness = await describeBackupDestinationReadiness(undefined, {
      localAuthorization: LOCAL_PERSON_RUN,
    })
    expect(readiness.find((row) => row.destination === "github")?.state).toBe("ready")
    expect(readiness.find((row) => row.destination === "googledrive")?.state).toBe("ready")
    clearSyncPassphrase()
  })
})

it("refuses the stored backup PAT without Host admission", async () => {
  await setGithubBackupToken("personal-backup-token")
  await expect(getGithubBackupToken({ kind: "keyring" })).rejects.toMatchObject({
    name: "PersonalCredentialRefusedError",
  })
})
