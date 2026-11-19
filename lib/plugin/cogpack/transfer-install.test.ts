import { sha256Bytes } from "@/lib/utils/hash"
import { loadJSZip } from "@/lib/packaging/signed-zip"
import { encodeBase64 } from "@/lib/share/encoding"

import { exportCogpack, type CogpackSigner, type ExportCogpackInput } from "./package"
import {
  __resetAnsweredTransfersForTests,
  installTransferredCogpack,
  type TransferInstallDeps,
} from "./transfer-install"

const text = (value: string) => new TextEncoder().encode(value)
const UPLOAD = "11111111-1111-4111-8111-111111111111"
const OP = "22222222-2222-4222-8222-222222222222"

function input(overrides: Partial<ExportCogpackInput> = {}): ExportCogpackInput {
  return {
    id: "transfer.work-laptop",
    version: "1.0.0",
    name: "Plugins from Work laptop",
    minHostVersion: "0.1.0",
    members: [
      {
        id: "acme-notes",
        name: "Notes",
        version: "0.2.0",
        optional: false,
        source: { kind: "embedded" },
      },
    ],
    embedded: new Map([
      [
        "acme-notes",
        [
          { path: "plugin.json", bytes: text('{"id":"acme-notes","version":"0.2.0"}') },
          { path: "index.js", bytes: text("export {}") },
        ],
      ],
    ]),
    ...overrides,
  }
}

async function signer(): Promise<CogpackSigner> {
  const keys = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey))
  return {
    publisher: "Work laptop",
    publicKey: encodeBase64(raw),
    sign: async (payload) =>
      new Uint8Array(
        await crypto.subtle.sign("Ed25519", keys.privateKey, Uint8Array.from(payload))
      ),
  }
}

/** A host manager whose statuses move the way the real lifecycle's do. */
function packages(
  initial: Record<string, string> = {},
  intents: Record<string, "auto" | "enabled" | "disabled"> = {}
) {
  const status: Record<string, string | undefined> = { ...initial }
  const events: string[] = []
  const move = (name: string, next: string) =>
    jest.fn(async (pluginId: string) => {
      events.push(`${name}:${pluginId}`)
      if (status[pluginId] !== undefined) status[pluginId] = next
    })
  const manager = {
    getPlugin: (pluginId: string) =>
      status[pluginId] === undefined ? undefined : ({ status: status[pluginId] } as never),
    getPluginLifecycleState: async (pluginId: string) => ({ intent: intents[pluginId] ?? "auto" }),
    enablePlugin: jest.fn(async (pluginId: string) => {
      events.push(`enable:${pluginId}`)
      status[pluginId] = "enabled"
    }),
    disablePlugin: move("disable", "disabled"),
    suspendPlugin: move("suspend", "suspended"),
    loadPlugin: move("load", "loaded"),
    unloadPlugin: move("unload", "installed"),
    uninstallPlugin: jest.fn(),
    reservePluginRuntimeGraph: jest.fn(() => ({}) as never),
    releasePluginRuntimeGraph: jest.fn(() => true),
    withPluginPackageMutation: jest.fn(<T>(_id: string, operation: () => Promise<T>) =>
      operation()
    ),
  }
  const register = jest.fn(async (pluginId: string) => {
    events.push(`register:${pluginId}`)
    if (status[pluginId] === undefined) status[pluginId] = "installed"
  })
  return { manager, register, status, events }
}

function deps(
  overrides: Partial<TransferInstallDeps> = {},
  host = packages()
): TransferInstallDeps & {
  installStaged: jest.Mock
  recordOrigin: jest.Mock
  host: ReturnType<typeof packages>
} {
  return {
    resolveTrust: jest.fn(async () => ({ trust: "signed-unknown" as const })),
    installStaged: jest.fn(async () => {
      host.events.push("installStaged")
      return {
        fingerprint: "f".repeat(64),
        installed: [{ pluginId: "acme-notes", version: "0.2.0" }],
        failed: [],
      }
    }),
    recordOrigin: jest.fn(async () => undefined),
    packages: { manager: host.manager, register: host.register },
    host,
    ...overrides,
  } as never
}

beforeEach(() => __resetAnsweredTransfersForTests())

describe("installTransferredCogpack", () => {
  it("installs the verified members, anchored on the manifest the archive carries", async () => {
    const exported = await exportCogpack({ ...input(), signer: await signer() })
    const d = deps()
    const result = await installTransferredCogpack(
      { uploadId: UPLOAD, operationId: OP, manifest: exported.manifest, adminLease: "lease" },
      d
    )
    expect(result.installed).toEqual([{ pluginId: "acme-notes", version: "0.2.0" }])

    // The hash Rust checks is the hash of the archive's own manifest.json.
    const zip = await (await loadJSZip()).loadAsync(exported.bytes)
    const archived = await zip.file("manifest.json")!.async("uint8array")
    expect(d.installStaged).toHaveBeenCalledWith({
      uploadId: UPLOAD,
      manifestSha256: await sha256Bytes(archived),
      members: [{ id: "acme-notes", version: "0.2.0" }],
    })
    expect(d.recordOrigin).toHaveBeenCalledWith(
      { pluginId: "acme-notes", version: "0.2.0" },
      { cogpackId: "transfer.work-laptop", version: "1.0.0", fingerprint: "f".repeat(64) }
    )
    // New here: registered and started.
    expect(d.host.events).toEqual(["installStaged", "register:acme-notes", "enable:acme-notes"])
  })

  it("stops a member this host runs before its package changes, and brings it back", async () => {
    const exported = await exportCogpack(input())
    const d = deps({}, packages({ "acme-notes": "loaded" }))
    await installTransferredCogpack(
      { uploadId: UPLOAD, operationId: OP, manifest: exported.manifest },
      d
    )
    expect(d.host.events).toEqual([
      "unload:acme-notes",
      "installStaged",
      "register:acme-notes",
      "load:acme-notes",
    ])
  })

  it("leaves a member whose intent is disabled here stopped", async () => {
    const exported = await exportCogpack(input())
    const d = deps(
      {},
      packages({ "acme-notes": "disabled" }, { "acme-notes": "disabled" })
    )
    const result = await installTransferredCogpack(
      { uploadId: UPLOAD, operationId: OP, manifest: exported.manifest },
      d
    )
    expect(d.host.events).toEqual(["unload:acme-notes", "installStaged", "register:acme-notes"])
    expect(result.installed).toEqual([{ pluginId: "acme-notes", version: "0.2.0" }])
  })

  it("puts a running member back when the staged install fails", async () => {
    const exported = await exportCogpack(input())
    const host = packages({ "acme-notes": "enabled" })
    const d = deps(
      {
        installStaged: jest.fn(async () => {
          throw new Error("cogpack_manifest_mismatch: archive changed")
        }),
      },
      host
    )
    await expect(
      installTransferredCogpack(
        { uploadId: UPLOAD, operationId: OP, manifest: exported.manifest },
        d
      )
    ).rejects.toThrow("cogpack_manifest_mismatch")
    expect(host.status["acme-notes"]).toBe("enabled")
  })

  it("refuses what this host's own plugin policy refuses, and never trusts the signer for it", async () => {
    const exported = await exportCogpack(input())
    const d = deps({
      resolveTrust: jest.fn(async () => ({
        trust: "unsigned" as const,
        refusedBy: "signature-required" as const,
      })),
    })
    await expect(
      installTransferredCogpack(
        { uploadId: UPLOAD, operationId: OP, manifest: exported.manifest },
        d
      )
    ).rejects.toThrow(/^cogpack_refused: signature-required/)
    expect(d.installStaged).not.toHaveBeenCalled()
  })

  it("refuses a manifest whose signature does not verify", async () => {
    const exported = await exportCogpack({ ...input(), signer: await signer() })
    const forged = { ...exported.manifest, name: "Something else" }
    await expect(
      installTransferredCogpack({ uploadId: UPLOAD, operationId: OP, manifest: forged }, deps())
    ).rejects.toThrow(/^cogpack_signature_invalid/)
  })

  it("refuses a member this host would have to fetch from elsewhere", async () => {
    const exported = await exportCogpack(
      input({
        members: [
          ...input().members,
          {
            id: "gh-tools",
            name: "GitHub tools",
            version: "1.0.0",
            optional: false,
            source: {
              kind: "github",
              owner: "acme",
              repo: "tools",
              commit: "0123456789abcdef0123456789abcdef01234567",
            },
          },
        ],
      })
    )
    await expect(
      installTransferredCogpack(
        { uploadId: UPLOAD, operationId: OP, manifest: exported.manifest },
        deps()
      )
    ).rejects.toThrow(/^cogpack_member_not_embedded: gh-tools/)
  })

  it("reports a plugin that installed but could not be enabled as not installed", async () => {
    const exported = await exportCogpack(input())
    const host = packages()
    host.register.mockRejectedValueOnce(new Error("plugin_not_discovered: refused"))
    const d = deps({}, host)
    const result = await installTransferredCogpack(
      { uploadId: UPLOAD, operationId: OP, manifest: exported.manifest },
      d
    )
    expect(result.installed).toEqual([])
    expect(result.failed).toEqual([
      { pluginId: "acme-notes", message: "plugin_not_discovered: refused" },
    ])
  })

  it("answers a retried operation with what the first call installed", async () => {
    const exported = await exportCogpack(input())
    const d = deps()
    const request = { uploadId: UPLOAD, operationId: OP, manifest: exported.manifest }
    const first = await installTransferredCogpack(request, d)
    await expect(installTransferredCogpack(request, d)).resolves.toEqual(first)
    expect(d.installStaged).toHaveBeenCalledTimes(1)
  })

  it("rejects fields it does not know", async () => {
    const exported = await exportCogpack(input())
    await expect(
      installTransferredCogpack(
        { uploadId: UPLOAD, operationId: OP, manifest: exported.manifest, trustSigner: true },
        deps()
      )
    ).rejects.toThrow(/trustSigner/)
  })
})
