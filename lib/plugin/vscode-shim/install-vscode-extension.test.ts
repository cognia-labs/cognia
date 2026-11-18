/**
 * Tests for the single `.vsix` -> installed-plugin path.
 *
 * The `hostile_*` cases are regression tests for a real privilege-escalation
 * chain: the dialog persisted the raw VS Code `package.json` as the cognia
 * manifest, so an extension could self-declare
 * `vscodeExtension.publisherKeyFingerprint`, which `manager.ts` forwarded to
 * `lsp-binary-policy` — where a plain string match against `trustedPublishers`
 * granted prompt-free `child_process.spawn`.
 *
 * Fixtures are synthesised in-memory with JSZip, matching `vsix-installer.test.ts`.
 */

import { createHash } from "node:crypto"
import JSZip from "jszip"

import type { Plugin } from "@/types/plugin"

jest.mock("@/lib/db/plugins", () => ({
  upsertPlugin: jest.fn(async (draft) => draft),
  getPlugin: jest.fn(async () => undefined),
  deletePlugin: jest.fn(async () => undefined),
}))
jest.mock("@/lib/native/utils", () => ({ canUseTauriInvoke: jest.fn(() => false) }))
jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))
jest.mock("@/lib/db/plugin-install-origins", () => ({
  putInstallOrigin: jest.fn(async () => undefined),
  getInstallOrigin: jest.fn(async () => undefined),
}))
jest.mock("@/lib/file/file-operations", () => ({ removeFile: jest.fn(async () => undefined) }))
jest.mock("@/lib/plugin/error-bus", () => ({ dispatchPluginError: jest.fn() }))

/** The runtime store the manager owns, reduced to its entries. */
const mockStore: { plugins: Record<string, Plugin> } = { plugins: {} }
jest.mock("@/stores/plugin-runtime", () => ({ usePluginStore: { getState: () => mockStore } }))

/** Every manager and backup call, in order, as `name:arg`. */
const mockEvents: string[] = []
function mockSetStatus(id: string, status: Plugin["status"]) {
  const entry = mockStore.plugins[id]
  if (entry) mockStore.plugins[id] = { ...entry, status }
}
function mockStep(name: string, status?: Plugin["status"]) {
  return jest.fn(async (id: string) => {
    mockEvents.push(`${name}:${id}`)
    if (status) mockSetStatus(id, status)
  })
}
const mockManager = {
  registerVscodeExtension: jest.fn(async (manifest: Plugin["manifest"], path: string, source) => {
    mockEvents.push(`register:${manifest.id}@${manifest.version}`)
    const existing = mockStore.plugins[manifest.id]
    mockStore.plugins[manifest.id] = {
      manifest,
      path,
      source,
      status: existing?.status ?? "installed",
      config: {},
    } as Plugin
  }),
  restorePluginEntry: jest.fn(async (id: string, previous: Plugin | undefined) => {
    mockEvents.push(`restore-entry:${id}:${previous ? previous.manifest.version : "none"}`)
    if (previous) mockStore.plugins[id] = { ...previous, status: "installed" }
    else delete mockStore.plugins[id]
  }),
  reservePluginRuntimeGraph: jest.fn((id: string) => ({ id })),
  releasePluginRuntimeGraph: jest.fn(),
  withPluginPackageMutation: jest.fn(async (_id: string, operation: () => Promise<unknown>) =>
    operation()
  ),
  enablePlugin: mockStep("enable", "enabled"),
  disablePlugin: mockStep("disable", "disabled"),
  suspendPlugin: mockStep("suspend", "suspended"),
  loadPlugin: mockStep("load", "loaded"),
  unloadPlugin: mockStep("unload", "installed"),
}
jest.mock("@/lib/plugin/core/manager", () => ({ getPluginManager: () => mockManager }))

const mockBackup = {
  createBackup: jest.fn(async (id: string) => {
    mockEvents.push(`backup:${id}`)
    return { success: true, backup: { id: `${id}-snap` }, duration: 0 }
  }),
  restore: jest.fn(async (backupId: string) => {
    mockEvents.push(`restore-backup:${backupId}`)
    return { success: true, pluginId: "", restoredVersion: "", duration: 0, requiresRestart: false }
  }),
}
jest.mock("@/lib/plugin/lifecycle/backup", () => ({ getPluginBackupManager: () => mockBackup }))
jest.mock("@cognia/logging", () => ({
  loggers: { plugin: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } },
}))

import { invoke } from "@tauri-apps/api/core"
import { deletePlugin, getPlugin, upsertPlugin } from "@/lib/db/plugins"
import { removeFile } from "@/lib/file/file-operations"
import { dispatchPluginError } from "@/lib/plugin/error-bus"
import { canUseTauriInvoke } from "@/lib/native/utils"
import { canonicalExtensionId, InvalidExtensionIdError } from "./extension-id"
import {
  commitVscodeExtension,
  installVscodeExtensionFromBytes,
  prepareVscodeExtension,
  vscodeInstallOrigin,
  VscodeExtensionsUnavailableError,
  type PreparedVscodeExtension,
} from "./install-vscode-extension"
import { getInstallOrigin, putInstallOrigin } from "@/lib/db/plugin-install-origins"
import {
  contractViolations,
  scenariosFor,
  type ReplacementObservation,
  type ReplacementScenario,
} from "@/lib/plugin/lifecycle/contract"
import { runtimeResumeStateOf } from "@/lib/plugin/lifecycle/runtime-state"
import type { VsCodeExtensionBlock } from "@/types/plugin/plugin-vscode"

const upsertPluginMock = upsertPlugin as jest.Mock
const canUseTauriInvokeMock = canUseTauriInvoke as jest.Mock
const invokeMock = invoke as unknown as jest.Mock

async function buildVsix(
  pkgJson: Record<string, unknown>,
  files: Record<string, string> = { "out/extension.js": "module.exports = {}" }
): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file("extension/package.json", JSON.stringify(pkgJson))
  for (const [path, content] of Object.entries(files)) {
    zip.file(`extension/${path}`, content)
  }
  return zip.generateAsync({ type: "uint8array" })
}

const BENIGN = {
  publisher: "cognia",
  name: "hello",
  version: "1.0.0",
  main: "./out/extension.js",
  engines: { vscode: ">=1.74.0" },
}

beforeEach(() => {
  jest.clearAllMocks()
  canUseTauriInvokeMock.mockReturnValue(true)
  mockStore.plugins = {}
  mockEvents.length = 0
})

/** Commit as the desktop does, with Rust unpacking to the extension's own directory. */
function commit(
  prepared: PreparedVscodeExtension,
  provenance?: Parameters<typeof commitVscodeExtension>[1]
) {
  const id = prepared.adapted.manifest.id
  invokeMock.mockResolvedValueOnce({
    extensionId: id,
    installPath: `/data/cognia/vscode-extensions/${id}`,
    sha256Hex: prepared.vsix.sha256,
    packageJson: {},
  })
  return commitVscodeExtension(prepared, provenance)
}

describe("prepareVscodeExtension", () => {
  it("produces the fields the loader requires, which the raw package.json lacks", async () => {
    const prepared = await prepareVscodeExtension(await buildVsix(BENIGN), "vsix-upload")

    // `loadVscodeDefinition` throws without both of these.
    expect(prepared.adapted.manifest.vscodeMain).toBe("./out/extension.js")
    expect(prepared.adapted.manifest.vscodeExtension?.identifier).toBe("cognia.hello")
    // Neither exists on a real VS Code manifest — proving adaptation happened.
    expect(prepared.vsix.pkgJson).not.toHaveProperty("vscodeMain")
    expect(prepared.vsix.pkgJson).not.toHaveProperty("vscodeExtension")
  })

  it("threads the install source into the manifest", async () => {
    const prepared = await prepareVscodeExtension(await buildVsix(BENIGN), "openvsx")
    expect(prepared.adapted.manifest.vscodeExtension?.source).toBe("openvsx")
  })

  it("escapes dots in an id component so the id cannot traverse", async () => {
    // Dots are what made `.` / `..` reachable; escaping them means the only
    // dot in the id is the separator itself.
    const prepared = await prepareVscodeExtension(
      await buildVsix({ ...BENIGN, publisher: "a.b" }),
      "vsix-upload"
    )
    expect(prepared.adapted.manifest.id).toBe("a-b.hello")
  })

  it("rejects a non-string publisher that slips past the parser", async () => {
    // `installVsix` guards the string/empty cases; this pins the id rule's own
    // guard, which is what the Rust command relies on for headless installs.
    expect(() => canonicalExtensionId(undefined, "hello")).toThrow(InvalidExtensionIdError)
  })

  it("relies on installVsix to reject empty publisher/name before the id rule", async () => {
    // Documents the layering: the parser is the first gate for `""`, and the
    // id rule is the second. Both matter — the Rust `plugin_vscode_install_vsix`
    // command is reachable without the parser (headless / registry installs),
    // which is why `sanitize_plugin_id_strict` enforces the same rule there.
    await expect(
      prepareVscodeExtension(await buildVsix({ ...BENIGN, publisher: "" }), "vsix-upload")
    ).rejects.toThrow(/missing required `publisher`/)
  })
})

describe("commitVscodeExtension", () => {
  it("persists the adapted manifest, never the raw package.json", async () => {
    const prepared = await prepareVscodeExtension(await buildVsix(BENIGN), "vsix-upload")
    await commit(prepared)

    const draft = upsertPluginMock.mock.calls[0]![0]
    expect(draft.manifest).toBe(prepared.adapted.manifest)
    expect(draft.manifest).not.toBe(prepared.vsix.pkgJson)
    expect(draft.manifest.vscodeExtension.identifier).toBe("cognia.hello")
    expect(draft.type).toBe("vscode-extension")
    expect(draft.enabled).toBe(false)
  })

  it("records an Open VSX origin pinned by version and VSIX hash, with cogpack provenance", async () => {
    const prepared = await prepareVscodeExtension(
      await buildVsix(BENIGN),
      "openvsx",
      "darwin-arm64"
    )
    await commit(prepared, {
      viaCogpack: { cogpackId: "coder", version: "2.0.0", fingerprint: "f" },
    })
    expect(putInstallOrigin).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: prepared.adapted.manifest.id,
        origin: {
          kind: "openvsx",
          namespace: "cognia",
          name: "hello",
          version: "1.0.0",
          sha256: prepared.vsix.sha256,
          targetPlatform: "darwin-arm64",
        },
        viaCogpack: { cogpackId: "coder", version: "2.0.0", fingerprint: "f" },
      })
    )
  })

  it("records a dropped .vsix as local, since there is nothing to fetch again", async () => {
    const prepared = await prepareVscodeExtension(await buildVsix(BENIGN), "vsix-upload")
    await commit(prepared)
    expect(putInstallOrigin).toHaveBeenCalledWith(
      expect.objectContaining({ origin: { kind: "local", via: "vsix" } })
    )
  })

  it("maps the manifest source onto the PluginRow source vocabulary", async () => {
    // `PluginSource` has no "openvsx" member — the two fields share a name but
    // not a domain.
    const fromRegistry = await prepareVscodeExtension(await buildVsix(BENIGN), "openvsx")
    await commit(fromRegistry)
    expect(upsertPluginMock.mock.calls[0]![0].source).toBe("marketplace")

    upsertPluginMock.mockClear()
    const fromDisk = await prepareVscodeExtension(await buildVsix(BENIGN), "vsix-upload")
    await commit(fromDisk)
    expect(upsertPluginMock.mock.calls[0]![0].source).toBe("local")
  })

  it("uses the Rust install path and rejects an id the two sides disagree on", async () => {
    const prepared = await prepareVscodeExtension(await buildVsix(BENIGN), "vsix-upload")
    invokeMock.mockResolvedValue({
      extensionId: "cognia.hello",
      installPath: "/data/cognia/vscode-extensions/cognia.hello",
      sha256Hex: prepared.vsix.sha256,
      packageJson: {},
    })

    await commitVscodeExtension(prepared)
    expect(upsertPluginMock.mock.calls[0]![0].path).toBe(
      "/data/cognia/vscode-extensions/cognia.hello"
    )

    // A drift between the TS and Rust id rules must fail loudly, not persist a
    // row that points at someone else's directory.
    upsertPluginMock.mockClear()
    invokeMock.mockResolvedValue({
      extensionId: "someone.else",
      installPath: "/data/cognia/vscode-extensions/someone.else",
      sha256Hex: prepared.vsix.sha256,
      packageJson: {},
    })
    await expect(commitVscodeExtension(prepared)).rejects.toThrow(/id mismatch/)
    expect(upsertPluginMock).not.toHaveBeenCalled()
  })

  it("refuses an install where VS Code extensions cannot run, recording nothing", async () => {
    canUseTauriInvokeMock.mockReturnValue(false)
    const prepared = await prepareVscodeExtension(await buildVsix(BENIGN), "vsix-upload")
    await expect(commitVscodeExtension(prepared)).rejects.toBeInstanceOf(
      VscodeExtensionsUnavailableError
    )
    expect(invokeMock).not.toHaveBeenCalled()
    expect(upsertPluginMock).not.toHaveBeenCalled()
    expect(putInstallOrigin).not.toHaveBeenCalled()
  })
})

const INSTALL_PATH = "/data/cognia/vscode-extensions/cognia.hello"

/** The host installing exactly what it was handed, as the real commands do. */
function hostInstalls(prepared: PreparedVscodeExtension) {
  invokeMock.mockImplementation(async (_command: string, args: { expectedSha256: string }) => {
    mockEvents.push("host-install")
    return {
      extensionId: prepared.adapted.manifest.id,
      installPath: INSTALL_PATH,
      sha256Hex: args.expectedSha256,
      packageJson: {},
    }
  })
}

/** An installed `cognia.hello` at `version`, with a runtime entry in `status`. */
function installed(version: string, status: Plugin["status"]) {
  const manifest = { id: "cognia.hello", name: "hello", version, type: "vscode-extension" }
  mockStore.plugins["cognia.hello"] = {
    manifest,
    status,
    source: "local",
    path: INSTALL_PATH,
    config: {},
  } as unknown as Plugin
  const row = {
    id: "cognia.hello",
    name: "hello",
    version,
    type: "vscode-extension",
    status: "enabled",
    enabled: true,
    source: "local",
    path: INSTALL_PATH,
    manifest,
  }
  ;(getPlugin as jest.Mock).mockResolvedValue(row)
  ;(getInstallOrigin as jest.Mock).mockResolvedValue({
    pluginId: "cognia.hello",
    version,
    origin: { kind: "local", via: "vsix" },
    recordedAt: 1,
  })
  return row
}

describe("commit transaction (PL03, PL04, PL05)", () => {
  afterEach(() => {
    ;(getPlugin as jest.Mock).mockResolvedValue(undefined)
    ;(getInstallOrigin as jest.Mock).mockResolvedValue(undefined)
  })

  it("asks the host for exactly the reviewed bytes on both install paths", async () => {
    const prepared = await prepareVscodeExtension(await buildVsix(BENIGN), "vsix-upload")
    hostInstalls(prepared)

    await commitVscodeExtension(prepared)
    await commitVscodeExtension({ ...prepared, stagedPath: "/data/.downloads/x.vsix" })

    expect(invokeMock).toHaveBeenNthCalledWith(1, "plugin_vscode_install_vsix", {
      vsixBase64: expect.any(String),
      expectedSha256: prepared.vsix.sha256,
    })
    expect(invokeMock).toHaveBeenNthCalledWith(2, "plugin_vscode_install_vsix_from_path", {
      tempPath: "/data/.downloads/x.vsix",
      expectedSha256: prepared.vsix.sha256,
    })
  })

  it("undoes a fresh install whose installed bytes are not the reviewed ones", async () => {
    const prepared = await prepareVscodeExtension(await buildVsix(BENIGN), "vsix-upload")
    invokeMock.mockResolvedValue({
      extensionId: "cognia.hello",
      installPath: INSTALL_PATH,
      sha256Hex: "f".repeat(64),
      packageJson: {},
    })

    await expect(commitVscodeExtension(prepared)).rejects.toThrow(/not the reviewed/)

    expect(upsertPluginMock).not.toHaveBeenCalled()
    expect(removeFile).toHaveBeenCalledWith(INSTALL_PATH, { recursive: true })
  })

  it("registers a fresh install with the runtime, discovered and off", async () => {
    const prepared = await prepareVscodeExtension(await buildVsix(BENIGN), "vsix-upload")
    hostInstalls(prepared)

    const { row } = await commitVscodeExtension(prepared)

    expect(mockManager.registerVscodeExtension).toHaveBeenCalledWith(
      prepared.adapted.manifest,
      INSTALL_PATH,
      "local"
    )
    expect(mockStore.plugins["cognia.hello"]?.path).toBe(INSTALL_PATH)
    expect(row).toMatchObject({ status: "discovered", enabled: false })
    // Nothing was installed before, so there was nothing to stop or snapshot.
    expect(mockEvents).toEqual(["host-install", "register:cognia.hello@1.0.0"])
  })

  it("stops, snapshots and restarts an enabled extension it replaces, keeping its row state", async () => {
    installed("0.9.0", "enabled")
    const prepared = await prepareVscodeExtension(await buildVsix(BENIGN), "vsix-upload")
    hostInstalls(prepared)

    await commitVscodeExtension(prepared)

    expect(mockEvents).toEqual([
      "disable:cognia.hello",
      "unload:cognia.hello",
      "backup:cognia.hello",
      "host-install",
      "register:cognia.hello@1.0.0",
      "enable:cognia.hello",
    ])
    const draft = upsertPluginMock.mock.calls[0]![0]
    expect(draft).not.toHaveProperty("status")
    expect(draft).not.toHaveProperty("enabled")
    expect(mockManager.reservePluginRuntimeGraph).toHaveBeenCalledWith("cognia.hello")
    expect(mockManager.releasePluginRuntimeGraph).toHaveBeenCalled()
  })

  it.each([
    ["loaded", ["unload:cognia.hello", "load:cognia.hello"]],
    [
      "suspended",
      [
        "disable:cognia.hello",
        "unload:cognia.hello",
        "enable:cognia.hello",
        "suspend:cognia.hello",
      ],
    ],
  ] as const)("returns a %s extension to that state, not to enabled", async (status, calls) => {
    installed("0.9.0", status)
    const prepared = await prepareVscodeExtension(await buildVsix(BENIGN), "vsix-upload")
    hostInstalls(prepared)

    await commitVscodeExtension(prepared)

    expect(mockEvents.filter((e) => !/^(backup|host-install|register)/.test(e))).toEqual(calls)
  })

  it("puts the previous package, row, entry and origin back when recording the new one fails", async () => {
    const previousRow = installed("0.9.0", "enabled")
    const prepared = await prepareVscodeExtension(await buildVsix(BENIGN), "vsix-upload")
    hostInstalls(prepared)
    upsertPluginMock.mockRejectedValueOnce(new Error("quota exceeded"))

    await expect(commitVscodeExtension(prepared)).rejects.toThrow("quota exceeded")

    expect(mockBackup.restore).toHaveBeenCalledWith("cognia.hello-snap", mockManager)
    expect(upsertPluginMock).toHaveBeenLastCalledWith(previousRow)
    expect(mockEvents).toEqual([
      "disable:cognia.hello",
      "unload:cognia.hello",
      "backup:cognia.hello",
      "host-install",
      "restore-backup:cognia.hello-snap",
      "restore-entry:cognia.hello:0.9.0",
      "enable:cognia.hello",
    ])
    expect(putInstallOrigin).toHaveBeenLastCalledWith(
      expect.objectContaining({ version: "0.9.0", origin: { kind: "local", via: "vsix" } })
    )
    expect(removeFile).not.toHaveBeenCalled()
  })

  it("removes a fresh install whose row could not be written: row, entry, then directory", async () => {
    const prepared = await prepareVscodeExtension(await buildVsix(BENIGN), "vsix-upload")
    hostInstalls(prepared)
    upsertPluginMock.mockRejectedValueOnce(new Error("quota exceeded"))
    const order: string[] = []
    ;(deletePlugin as jest.Mock).mockImplementationOnce(async () => void order.push("row"))
    mockManager.restorePluginEntry.mockImplementationOnce(async () => void order.push("entry"))
    ;(removeFile as jest.Mock).mockImplementationOnce(async () => void order.push("dir"))

    await expect(commitVscodeExtension(prepared)).rejects.toThrow("quota exceeded")

    expect(order).toEqual(["row", "entry", "dir"])
    expect(removeFile).toHaveBeenCalledWith(INSTALL_PATH, { recursive: true })
  })

  it("never touches the package when the snapshot fails, and restarts the old runtime", async () => {
    installed("0.9.0", "enabled")
    const prepared = await prepareVscodeExtension(await buildVsix(BENIGN), "vsix-upload")
    hostInstalls(prepared)
    mockBackup.createBackup.mockResolvedValueOnce({
      success: false,
      error: "disk full",
      duration: 0,
    } as never)

    await expect(commitVscodeExtension(prepared)).rejects.toThrow(/Could not snapshot.*disk full/)

    expect(invokeMock).not.toHaveBeenCalled()
    expect(mockEvents).toEqual([
      "disable:cognia.hello",
      "unload:cognia.hello",
      "enable:cognia.hello",
    ])
  })

  it("registers an extension installed before installs reached the runtime, then replaces it", async () => {
    const previousRow = installed("0.9.0", "installed")
    delete mockStore.plugins["cognia.hello"]
    const prepared = await prepareVscodeExtension(await buildVsix(BENIGN), "vsix-upload")
    hostInstalls(prepared)

    await commitVscodeExtension(prepared)

    expect(mockManager.registerVscodeExtension).toHaveBeenNthCalledWith(
      1,
      previousRow.manifest,
      INSTALL_PATH,
      "local"
    )
    // Registered, so it could be snapshotted before its files were replaced.
    expect(mockEvents.slice(0, 3)).toEqual([
      "register:cognia.hello@0.9.0",
      "backup:cognia.hello",
      "host-install",
    ])
  })

  it("refuses to install over a plugin of another type with the same id", async () => {
    ;(getPlugin as jest.Mock).mockResolvedValue({ id: "cognia.hello", type: "frontend" })
    const prepared = await prepareVscodeExtension(await buildVsix(BENIGN), "vsix-upload")
    hostInstalls(prepared)

    await expect(commitVscodeExtension(prepared)).rejects.toThrow(/frontend plugin/)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("leaves the directory of another id alone when the host and renderer disagree", async () => {
    const prepared = await prepareVscodeExtension(await buildVsix(BENIGN), "vsix-upload")
    invokeMock.mockResolvedValue({
      extensionId: "someone.else",
      installPath: "/data/cognia/vscode-extensions/someone.else",
      sha256Hex: prepared.vsix.sha256,
      packageJson: {},
    })

    await expect(commitVscodeExtension(prepared)).rejects.toThrow(/id mismatch/)
    expect(removeFile).not.toHaveBeenCalled()
  })

  it("reports a failed restart without calling the install a failure", async () => {
    installed("0.9.0", "enabled")
    const prepared = await prepareVscodeExtension(await buildVsix(BENIGN), "vsix-upload")
    hostInstalls(prepared)
    mockManager.enablePlugin.mockRejectedValueOnce(new Error("not trusted"))

    await expect(commitVscodeExtension(prepared)).resolves.toMatchObject({
      row: expect.objectContaining({ id: "cognia.hello" }),
    })
    expect(dispatchPluginError).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "cognia.hello",
        message: "not trusted",
        severity: "warning",
      })
    )
  })

  it("reverts a fresh install by removing it", async () => {
    const prepared = await prepareVscodeExtension(await buildVsix(BENIGN), "vsix-upload")
    hostInstalls(prepared)
    const { revert } = await commitVscodeExtension(prepared)
    mockEvents.length = 0

    await revert()

    expect(deletePlugin).toHaveBeenCalledWith("cognia.hello")
    expect(removeFile).toHaveBeenCalledWith(INSTALL_PATH, { recursive: true })
    expect(mockStore.plugins["cognia.hello"]).toBeUndefined()
    expect(mockBackup.restore).not.toHaveBeenCalled()
  })

  it("reverts a replacement by restoring the snapshot and the previous runtime state", async () => {
    const previousRow = installed("0.9.0", "enabled")
    const prepared = await prepareVscodeExtension(await buildVsix(BENIGN), "vsix-upload")
    hostInstalls(prepared)
    const { revert } = await commitVscodeExtension(prepared)
    mockEvents.length = 0

    await revert()

    expect(mockEvents).toEqual([
      "disable:cognia.hello",
      "unload:cognia.hello",
      "restore-backup:cognia.hello-snap",
      "restore-entry:cognia.hello:0.9.0",
      "enable:cognia.hello",
    ])
    expect(upsertPluginMock).toHaveBeenLastCalledWith(previousRow)
    expect(removeFile).not.toHaveBeenCalled()
  })
})

describe("lifecycle contract (ADR-0258)", () => {
  const VERSIONS = { from: "0.9.0", to: "1.0.0" }
  const STATUS_OF = {
    enabled: "enabled",
    suspended: "suspended",
    loaded: "loaded",
    stopped: "installed",
  } as const

  afterEach(() => {
    upsertPluginMock.mockImplementation(async (draft) => draft)
    mockBackup.restore.mockImplementation(async (backupId: string) => {
      mockEvents.push(`restore-backup:${backupId}`)
      return {
        success: true,
        pluginId: "",
        restoredVersion: "",
        duration: 0,
        requiresRestart: false,
      }
    })
    ;(getPlugin as jest.Mock).mockResolvedValue(undefined)
    ;(getInstallOrigin as jest.Mock).mockResolvedValue(undefined)
  })

  /** Install v1.0.0 over an installed v0.9.0, with `scenario`'s fault injected. */
  async function run(scenario: ReplacementScenario): Promise<ReplacementObservation> {
    installed(VERSIONS.from, STATUS_OF[scenario.before])
    let disk: string | undefined = VERSIONS.from
    let recorded: string | undefined = VERSIONS.from
    const prepared = await prepareVscodeExtension(await buildVsix(BENIGN), "vsix-upload")

    invokeMock.mockImplementation(async (_command: string, args: { expectedSha256: string }) => {
      // The host refuses bytes other than the reviewed ones before unpacking.
      if (scenario.fault === "identity") throw { code: "digest_mismatch", message: "not reviewed" }
      disk = VERSIONS.to
      return {
        extensionId: "cognia.hello",
        installPath: INSTALL_PATH,
        sha256Hex: args.expectedSha256,
        packageJson: {},
      }
    })
    mockBackup.restore.mockImplementation(async () => {
      disk = VERSIONS.from
      return {
        success: true,
        pluginId: "",
        restoredVersion: "",
        duration: 0,
        requiresRestart: false,
      }
    })
    upsertPluginMock.mockImplementation(async (draft: { version: string }) => {
      if (scenario.fault === "after-commit" && draft.version === VERSIONS.to) {
        throw new Error("quota exceeded")
      }
      recorded = draft.version
      return draft
    })
    if (scenario.fault === "before-commit") {
      mockBackup.createBackup.mockResolvedValueOnce({
        success: false,
        error: "disk full",
        duration: 0,
      } as never)
    }

    let outcome: ReplacementObservation["outcome"] = "succeeded"
    try {
      await commitVscodeExtension(prepared)
    } catch {
      outcome = "failed"
    }
    return {
      outcome,
      // The commit reports a runtime it could not restart as an activation warning.
      restartRequired: (dispatchPluginError as jest.Mock).mock.calls.some(
        ([detail]) => detail.stage === "activation"
      ),
      packageVersion: disk,
      recordedVersion: recorded,
      runtime: runtimeResumeStateOf(mockStore.plugins["cognia.hello"]?.status),
    }
  }

  it.each(scenariosFor("vscode-install"))("$id", async (scenario) => {
    expect(contractViolations(scenario, VERSIONS, await run(scenario))).toEqual([])
  })
})

describe("hostile manifests", () => {
  // Rust unpacks the archive and derives the id from its own package.json.
  beforeEach(() => {
    invokeMock.mockImplementation(async (_command: string, args: { vsixBase64: string }) => {
      const zip = await JSZip.loadAsync(args.vsixBase64, { base64: true })
      const pkg = JSON.parse(await zip.file("extension/package.json")!.async("string"))
      const id = canonicalExtensionId(pkg.publisher, pkg.name)
      return {
        extensionId: id,
        installPath: `/data/cognia/vscode-extensions/${id}`,
        // The host hashes the bytes it installs, as the real command does.
        sha256Hex: createHash("sha256")
          .update(Buffer.from(args.vsixBase64, "base64"))
          .digest("hex"),
        packageJson: pkg,
      }
    })
  })

  const HOSTILE = {
    publisher: "evil",
    name: "x",
    version: "1.0.0",
    main: "./out/extension.js",
    // Everything below is the attacker trying to forge adapter output.
    vscodeMain: "./out/extension.js",
    vscodeExtension: {
      identifier: "microsoft.vscode",
      publisherKeyFingerprint: "placeholder:microsoft.vscode",
      source: "dev",
    },
    permissions: ["shell:execute", "filesystem:write"],
    lspServers: [{ id: "evil", command: "./bin/payload", languages: ["rust"] }],
  }

  it("cannot inject publisherKeyFingerprint", async () => {
    const { prepared } = await installVscodeExtensionFromBytes({
      bytes: await buildVsix(HOSTILE),
      source: "vsix-upload",
    })

    // The one field that bought prompt-free child_process.spawn.
    expect(prepared.adapted.manifest.vscodeExtension?.publisherKeyFingerprint).toBeUndefined()
    const draft = upsertPluginMock.mock.calls[0]![0]
    expect(draft.manifest.vscodeExtension.publisherKeyFingerprint).toBeUndefined()
  })

  it("cannot impersonate another extension's identifier", async () => {
    const { prepared } = await installVscodeExtensionFromBytes({
      bytes: await buildVsix(HOSTILE),
      source: "vsix-upload",
    })

    // Derived from publisher/name, not copied from the attacker's block.
    expect(prepared.adapted.manifest.id).toBe("evil.x")
    expect(prepared.adapted.manifest.vscodeExtension?.identifier).toBe("evil.x")
  })

  it("cannot self-declare permissions or LSP servers", async () => {
    const { prepared } = await installVscodeExtensionFromBytes({
      bytes: await buildVsix(HOSTILE),
      source: "vsix-upload",
    })
    const manifest = prepared.adapted.manifest

    // Permissions are inferred from the bundle, never read off the manifest.
    // This extension's bundle requires nothing, so nothing is granted.
    expect(manifest.permissions).not.toContain("shell:execute")
    expect(manifest.permissions).not.toContain("filesystem:write")
    expect(manifest.lspServers ?? []).toHaveLength(0)
  })

  it("cannot override the install source recorded by the caller", async () => {
    const { prepared } = await installVscodeExtensionFromBytes({
      bytes: await buildVsix(HOSTILE),
      source: "vsix-upload",
    })
    // The manifest claimed "dev"; the caller said "vsix-upload".
    expect(prepared.adapted.manifest.vscodeExtension?.source).toBe("vsix-upload")
  })

  it("still infers permissions the bundle actually implies", async () => {
    // The inverse guard: rejecting self-declared permissions must not mean
    // under-reporting real ones.
    const { prepared } = await installVscodeExtensionFromBytes({
      bytes: await buildVsix(
        { ...BENIGN },
        { "out/extension.js": "const cp = require('child_process'); cp.spawn('sh')" }
      ),
      source: "vsix-upload",
    })
    expect(prepared.adapted.manifest.permissions).toContain("process:spawn")
  })
})

describe("vscodeInstallOrigin", () => {
  const block: VsCodeExtensionBlock = {
    identifier: "acme.tools.pro",
    version: "3.1.0",
    engineVscode: "^1.80.0",
    vsixSha256: "x",
    source: "openvsx",
    bundleFormat: "cjs",
    activationEvents: [],
  }

  it("splits the namespace from a name that itself contains dots", () => {
    expect(vscodeInstallOrigin(block, "abc")).toEqual({
      kind: "openvsx",
      namespace: "acme",
      name: "tools.pro",
      version: "3.1.0",
      sha256: "abc",
    })
  })

  it("falls back to local for dev, drag-drop and malformed identifiers", () => {
    expect(vscodeInstallOrigin({ ...block, source: "dev" }, "a")).toEqual({
      kind: "local",
      via: "directory",
    })
    expect(vscodeInstallOrigin({ ...block, source: null }, "a")).toEqual({
      kind: "local",
      via: "vsix",
    })
    expect(vscodeInstallOrigin({ ...block, identifier: "nodot" }, "a")).toEqual({
      kind: "local",
      via: "vsix",
    })
    expect(vscodeInstallOrigin(undefined, "a")).toEqual({ kind: "local", via: "vsix" })
  })
})
