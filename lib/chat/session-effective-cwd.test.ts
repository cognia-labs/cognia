/** @jest-environment jsdom */
import {
  defaultWorkingDirNow,
  resolveEffectiveCwdForSession,
  subscribeDefaultWorkingDir,
} from "./session-effective-cwd"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"
import { resolveCharacterById } from "@/lib/db/characters"
import type { Project } from "@/types"
import type { AppSettings } from "@cognia/agent-config-types"

jest.mock("@/lib/db/characters", () => ({ resolveCharacterById: jest.fn() }))

const resolveCharacterByIdMock = resolveCharacterById as jest.Mock

function makeProject(path: string): Project {
  return {
    id: "proj-1",
    name: "Workspace",
    roots: [{ id: "r1", path, isPrimary: true }],
    knowledgeBase: [],
    sessionIds: [],
    sessionCount: 0,
    messageCount: 0,
    isArchived: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastAccessedAt: new Date(),
  } as Project
}

function seedStores(opts: {
  project?: Project | null
  active?: boolean
  defaultWorkingDir?: string
}) {
  const projects = opts.project ? [opts.project] : []
  useProjectStore.setState({
    projects,
    activeProjectId: opts.active && opts.project ? opts.project.id : null,
    loaded: false,
  })
  useSettingsStore.setState({
    settings: { defaultWorkingDir: opts.defaultWorkingDir } as AppSettings,
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  seedStores({})
})

describe("resolveEffectiveCwdForSession", () => {
  it("prefers session workingDir", async () => {
    seedStores({ project: makeProject("/ws"), active: true })
    await expect(resolveEffectiveCwdForSession({ workingDir: "/session" })).resolves.toBe(
      "/session"
    )
    expect(resolveCharacterByIdMock).not.toHaveBeenCalled()
  })

  it("falls back to the active workspace root", async () => {
    seedStores({ project: makeProject("/ws"), active: true })
    await expect(resolveEffectiveCwdForSession({})).resolves.toBe("/ws")
  })

  it("resolves the character from Dexie when needed", async () => {
    seedStores({})
    resolveCharacterByIdMock.mockResolvedValue({ id: "char-1", workingDir: "/char" })
    await expect(resolveEffectiveCwdForSession({ characterId: "char-1" })).resolves.toBe("/char")
    expect(resolveCharacterByIdMock).toHaveBeenCalledWith("char-1")
  })

  it("survives a character lookup failure and uses the app default", async () => {
    seedStores({ defaultWorkingDir: "/def" })
    resolveCharacterByIdMock.mockRejectedValue(new Error("dexie down"))
    await expect(resolveEffectiveCwdForSession({ characterId: "char-1" })).resolves.toBe("/def")
  })

  it("returns null when nothing resolves", async () => {
    await expect(resolveEffectiveCwdForSession(null)).resolves.toBeNull()
  })
})

describe("the app default, for the reactive hook", () => {
  it("reads the default now and hears it change", () => {
    seedStores({ defaultWorkingDir: "/a" })
    expect(defaultWorkingDirNow()).toBe("/a")
    const heard = jest.fn()
    const unsubscribe = subscribeDefaultWorkingDir(heard)
    seedStores({ defaultWorkingDir: "/b" })
    expect(heard).toHaveBeenCalled()
    expect(defaultWorkingDirNow()).toBe("/b")
    unsubscribe()
    heard.mockClear()
    seedStores({ defaultWorkingDir: "/c" })
    expect(heard).not.toHaveBeenCalled()
  })
})
