/** @jest-environment jsdom */
import { transport } from "@/lib/tauri"
import {
  scanClaudeSkills,
  skillsScanNative,
  skillsCatalogGet,
  skillsBundleUploadOpen,
  skillsBundleUploadWrite,
  skillsBundleUploadCommit,
  skillsBundleUploadAbort,
  skillsInstallAtomic,
  skillsUninstall,
  skillsScanDir,
  skillsInstallNative,
  skillsUninstallNative,
  skillsFetchRemoteMd,
  skillsFetchRemoteJson,
  skillsLoadRegistry,
  skillsScanSecurity,
  skillsScanResources,
} from "./host-client"

const TAURI_KEY = "__TAURI_INTERNALS__"

function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
}

let callSpy: jest.SpiedFunction<typeof transport.call>

beforeEach(() => {
  setTauri(true)
  callSpy = jest.spyOn(transport, "call")
})

afterEach(() => {
  setTauri(false)
  jest.restoreAllMocks()
})

describe("scanClaudeSkills", () => {
  it("camelCases each row's snake_case fields", async () => {
    callSpy.mockResolvedValueOnce([
      { dir_name: "skill-a", file_path: "/p/a.md", content: "a body" },
      { dir_name: "skill-b", file_path: "/p/b.md", content: "b body" },
    ])
    const out = await scanClaudeSkills()
    expect(out).toEqual([
      { dirName: "skill-a", filePath: "/p/a.md", content: "a body" },
      { dirName: "skill-b", filePath: "/p/b.md", content: "b body" },
    ])
  })
})

describe("skills commands", () => {
  it("uses the host Skills catalog contract", async () => {
    callSpy.mockResolvedValueOnce({ cognia: [], claude: [], codex: [] })
    await expect(skillsCatalogGet()).resolves.toEqual({ cognia: [], claude: [], codex: [] })
    expect(callSpy).toHaveBeenCalledWith("skills_catalog_get")
  })

  it("forwards every phase of a transactional bundle upload", async () => {
    callSpy
      .mockResolvedValueOnce({ handleId: "upload-1", chunkBytes: 32768 })
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ targets: [], trashedFrom: null })
      .mockResolvedValueOnce(undefined)

    await skillsBundleUploadOpen(4, "a".repeat(64))
    await skillsBundleUploadWrite({
      handleId: "upload-1",
      offset: 0,
      dataBase64: "e30=",
      chunkHash: "b".repeat(64),
    })
    await skillsBundleUploadCommit("upload-1")
    await skillsInstallAtomic("upload-1", "lease-1")
    await skillsBundleUploadAbort("upload-2")

    expect(callSpy.mock.calls).toEqual([
      ["skills_bundle_upload_open", { request: { expectedSize: 4, expectedHash: "a".repeat(64) } }],
      [
        "skills_bundle_upload_write",
        {
          handleId: "upload-1",
          offset: 0,
          dataBase64: "e30=",
          chunkHash: "b".repeat(64),
        },
      ],
      ["skills_bundle_upload_commit", { handleId: "upload-1" }],
      ["skills_install_atomic", { handleId: "upload-1", adminLease: "lease-1" }],
      ["skills_bundle_upload_abort", { handleId: "upload-2" }],
    ])
  })

  it("uninstalls only from the explicitly selected host target", async () => {
    callSpy.mockResolvedValueOnce({ removed: true, directory: "/host/skills/x" })
    await skillsUninstall("codex", "x", "lease-1")
    expect(callSpy).toHaveBeenCalledWith("skills_uninstall", {
      target: "codex",
      dirName: "x",
      adminLease: "lease-1",
    })
  })

  it("skillsScanNative just forwards the response", async () => {
    callSpy.mockResolvedValueOnce([{ dirName: "x", filePath: "/x", content: "", resources: [] }])
    await expect(skillsScanNative()).resolves.toHaveLength(1)
    expect(callSpy).toHaveBeenCalledWith("skills_scan_native")
  })

  it("skillsScanDir forwards the path argument", async () => {
    callSpy.mockResolvedValueOnce([])
    await skillsScanDir("/scan/me")
    expect(callSpy).toHaveBeenCalledWith("skills_scan_dir", { path: "/scan/me" })
  })

  it("skillsInstallNative wraps the request in {request}", async () => {
    callSpy.mockResolvedValueOnce({ directory: "/d", writtenFiles: ["a"] })
    const req = { dirName: "x", content: "y", resources: [], clean: false }
    await skillsInstallNative(req)
    expect(callSpy).toHaveBeenCalledWith("skills_install_native", { request: req })
  })

  it("skillsUninstallNative forwards dirName", async () => {
    callSpy.mockResolvedValueOnce({ removed: true, directory: "/d" })
    await skillsUninstallNative("x")
    expect(callSpy).toHaveBeenCalledWith("skills_uninstall_native", { dirName: "x" })
  })

  it("skillsFetchRemoteMd forwards url", async () => {
    callSpy.mockResolvedValueOnce("# md")
    await expect(skillsFetchRemoteMd("https://e/x.md")).resolves.toBe("# md")
    expect(callSpy).toHaveBeenCalledWith("skills_fetch_remote_md", {
      url: "https://e/x.md",
    })
  })

  it("skillsFetchRemoteJson wraps the request in {req}", async () => {
    callSpy.mockResolvedValueOnce({ status: 200, body: "{}", retryAfter: null })
    await expect(
      skillsFetchRemoteJson({ url: "https://skills.sh/api/search?q=x", bearerToken: "tok" })
    ).resolves.toEqual({ status: 200, body: "{}", retryAfter: null })
    expect(callSpy).toHaveBeenCalledWith("skills_fetch_remote_json", {
      req: { url: "https://skills.sh/api/search?q=x", bearerToken: "tok" },
    })
  })

  it("skillsLoadRegistry just returns the array", async () => {
    callSpy.mockResolvedValueOnce([{ id: "x", source: "y", sourceType: "z" }])
    await expect(skillsLoadRegistry()).resolves.toHaveLength(1)
  })

  it("skillsScanSecurity forwards content", async () => {
    callSpy.mockResolvedValueOnce([])
    await skillsScanSecurity("body")
    expect(callSpy).toHaveBeenCalledWith("skills_scan_security", { content: "body" })
  })

  it("skillsScanResources forwards the [path,content] tuples", async () => {
    callSpy.mockResolvedValueOnce([])
    await skillsScanResources([
      ["/a", "alpha"],
      ["/b", "beta"],
    ])
    expect(callSpy).toHaveBeenCalledWith("skills_scan_resources", {
      resources: [
        ["/a", "alpha"],
        ["/b", "beta"],
      ],
    })
  })
})

// ── Mobile message + session wrappers (Phase 2) ──────────────────────────
