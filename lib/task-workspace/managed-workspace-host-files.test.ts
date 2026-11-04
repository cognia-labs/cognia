import { createHostManagedWorkspaceFiles } from "./managed-workspace-host-files"
import { callTaskWorkspaceOrigin, captureTaskWorkspaceOrigin } from "./origin"
import { getRuntimeTargetScopeKey } from "@/lib/runtime/runtime-target-context"

jest.mock("./origin", () => ({
  captureTaskWorkspaceOrigin: jest.fn(),
  callTaskWorkspaceOrigin: jest.fn(),
}))
jest.mock("@/lib/runtime/runtime-target-context", () => ({ getRuntimeTargetScopeKey: jest.fn() }))
jest.mock("@/lib/platform/detect", () => ({ isHeadlessHost: () => false }))

const root = "/srv/workspaces"
const base = `${root}/managed-workspaces`
const call = jest.mocked(callTaskWorkspaceOrigin)

beforeEach(() => {
  jest.clearAllMocks()
  jest
    .mocked(captureTaskWorkspaceOrigin)
    .mockReturnValue({ kind: "remote", hostId: "companion:host-a" })
  jest.mocked(getRuntimeTargetScopeKey).mockReturnValue("account-a:host-a:1")
  call.mockImplementation(async (_origin, command) => {
    if (command === "fs_workspace_roots") {
      return { roots: [{ path: root, source: "headless-workspaces-dir" }] } as never
    }
    if (command === "fs_stat_workspace_file") return { exists: true, is_dir: false } as never
    return null as never
  })
})

it("creates directories on the captured Host and preserves binary archive bytes", async () => {
  const files = await createHostManagedWorkspaceFiles()
  expect(await files.managedBaseRoot()).toBe(base)
  await files.mkdir(`${base}/session-a`)
  expect(call).toHaveBeenLastCalledWith(
    { kind: "remote", hostId: "companion:host-a" },
    "fs_create_workspace_dir",
    { root, relPath: "managed-workspaces/session-a" },
    true
  )
  await files.writeFile(`${base}/session-a/image.bin`, new Uint8Array([0, 255, 128]))
  expect(call).toHaveBeenLastCalledWith(
    expect.anything(),
    "fs_write_workspace_file",
    {
      root,
      relPath: "managed-workspaces/session-a/image.bin",
      content: "AP+A",
      encoding: "base64",
    },
    true
  )
  call.mockResolvedValueOnce("AP+A")
  expect(await files.readFile(`${base}/session-a/image.bin`)).toEqual(new Uint8Array([0, 255, 128]))
})

it("preserves symlink metadata so archive collection can reject links", async () => {
  const files = await createHostManagedWorkspaceFiles()
  call.mockResolvedValueOnce([
    { absolute_path: `${base}/session-a/link`, rel_path: "managed-workspaces/session-a/link" },
  ] as never)
  call.mockResolvedValueOnce({ exists: true, is_dir: false, is_symlink: true } as never)
  expect(await files.readDir(`${base}/session-a`)).toEqual([
    { name: "link", isDirectory: false, isFile: false, isSymlink: true },
  ])
})

it("scopes deletes, renames and root registration to the managed directory", async () => {
  const files = await createHostManagedWorkspaceFiles()
  await files.remove(`${base}/session-a`)
  expect(call).toHaveBeenLastCalledWith(
    expect.anything(),
    "fs_delete_workspace_entry",
    { root, relPath: "managed-workspaces/session-a", recursive: true },
    true
  )
  await files.rename(`${base}/session-a`, `${base}/session-b`)
  expect(call).toHaveBeenLastCalledWith(
    expect.anything(),
    "fs_rename_workspace_entry",
    {
      root,
      fromRelPath: "managed-workspaces/session-a",
      toRelPath: "managed-workspaces/session-b",
    },
    true
  )
  call.mockClear()
  expect(() => files.rename(`${base}/session-a`, "/outside")).toThrow("outside its Host root")
  expect(() => files.rename("/outside", `${base}/session-b`)).toThrow("outside its Host root")
  await files.registerAllowedRoot(`${base}/session-b`)
  await expect(files.registerAllowedRoot("/outside")).rejects.toThrow("outside its Host root")
  expect(call).not.toHaveBeenCalled()
})

it.each(
  [[], [root, "/another-root"], ["relative-root"], ["/srv/../escape"], ["/srv/./workspaces"]].map(
    (paths) => [paths]
  )
)("refuses invalid or ambiguous advertised roots %j", async (paths) => {
  call.mockResolvedValueOnce({
    roots: paths.map((path) => ({ path, source: "headless-workspaces-dir" })),
  } as never)
  await expect(createHostManagedWorkspaceFiles()).rejects.toThrow(/managed workspace root/)
})

it.each([
  "/etc/passwd",
  `${base}-other/file`,
  `${base}/../escape`,
  `${base}/a/./b`,
  `${base}/a\\b`,
])("rejects escaped path %s before making a write", async (path) => {
  const files = await createHostManagedWorkspaceFiles()
  call.mockClear()
  expect(() => files.mkdir(path)).toThrow("outside its Host root")
  expect(call).not.toHaveBeenCalled()
})

it("refuses work after an account or routing generation change", async () => {
  const files = await createHostManagedWorkspaceFiles()
  jest.mocked(getRuntimeTargetScopeKey).mockReturnValue("account-a:host-a:3")
  call.mockClear()
  await expect(files.managedBaseRoot()).rejects.toThrow("connection changed")
  expect(() => files.mkdir(`${base}/session-a`)).toThrow("connection changed")
  expect(call).not.toHaveBeenCalled()
})

it("rejects a response if authority changes while the request is in flight", async () => {
  const files = await createHostManagedWorkspaceFiles()
  call.mockImplementationOnce(async () => {
    jest.mocked(getRuntimeTargetScopeKey).mockReturnValue("account-b:host-b:2")
    return { exists: true } as never
  })
  await expect(files.exists(`${base}/session-a`)).rejects.toThrow("connection changed")
})

it("does not guess a root from a desktop project or an unpaired browser", async () => {
  call.mockResolvedValueOnce({ roots: [{ path: "/project", source: "desktop-project" }] } as never)
  await expect(createHostManagedWorkspaceFiles()).rejects.toThrow("one managed workspace root")
  jest.mocked(captureTaskWorkspaceOrigin).mockReturnValue({ kind: "local" })
  await expect(createHostManagedWorkspaceFiles()).rejects.toThrow("connected Host")
})
