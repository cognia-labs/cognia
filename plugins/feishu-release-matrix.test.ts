/**
 * @jest-environment jsdom
 * @cognia-host-integration-test
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import JSZip from "jszip"
import type { PluginManifest, PluginRuntimeProfile } from "@/types/plugin"
import type { AuthConnectionRow } from "@/lib/db/auth-connections"
import type { BrowserBuiltinRegistryEntry } from "@/lib/plugin/core/browser-builtin-registry"

jest.mock("@tauri-apps/api/core", () => ({
  ...jest.requireActual("@tauri-apps/api/core"),
  invoke: jest.fn(),
}))
jest.mock("@/lib/plugin/security/signature", () => ({
  ...jest.requireActual("@/lib/plugin/security/signature"),
  getPluginSignatureVerifier: () => ({
    getConfig: () => ({ requireSignatures: true, allowUntrusted: false }),
    clearCache: () => undefined,
    verify: async () => ({ valid: true, warnings: [] }),
  }),
}))

const AUTH = "feishu-auth"
const CALENDAR = "feishu-calendar"
const PROVIDER = "feishu-user-oauth"
const HANDLER = `${CALENDAR}:syncSubscribedCalendars`
const fixtureIds = [AUTH, CALENDAR] as const

interface Transaction {
  pluginId: string
  directory: string
  committed: boolean
}

/** Source manifests use authoring paths; the release compiler rewrites those paths. */
function releaseContract(manifest: PluginManifest) {
  return {
    permissions: manifest.permissions,
    requiresServices: manifest.requiresServices,
    providesServices: manifest.providesServices,
    authProviders: manifest.authProviders,
    runtimeCompatibility: Object.fromEntries(
      Object.entries(manifest.runtimeCompatibility ?? {}).map(([runtime, support]) => [
        runtime,
        {
          ...support,
          entrypoint: support.entrypoint === manifest.main ? "$main" : support.entrypoint,
        },
      ])
    ),
  }
}

async function exists(file: string) {
  return access(file).then(
    () => true,
    () => false
  )
}

describe("Feishu release matrix through the real PluginManager (ADR-0246 ES-34)", () => {
  let root: string
  let pluginRoot: string
  let artifactRoot: string
  let manager: import("@/lib/plugin/core/manager").PluginManager
  let Manager: typeof import("@/lib/plugin/core/manager").PluginManager
  let store: typeof import("@/stores/plugin-runtime").usePluginStore
  let db: typeof import("@/lib/db/schema").getDb
  let fixture: ReturnType<typeof import("@/lib/db/test-fixture").createDbTestFixture>
  let auth: typeof import("@/lib/plugin/auth/auth-provider-registry")
  let integrations: typeof import("@/lib/integrations/registry")
  let scheduler: typeof import("@/lib/plugin/scheduler/scheduler-plugin-executor")
  let importer: typeof import("@/cli/src/plugin/node-importer").makeNodeFrontendImporter
  let validate: typeof import("@/lib/plugin/core/validation").validatePluginManifest
  let invokeMock: jest.Mock
  let catalog: { entries: Record<string, BrowserBuiltinRegistryEntry> }
  const sources = new Map<string, PluginManifest>()
  const packages = new Map<string, PluginManifest>()
  const transactions = new Map<string, Transaction>()
  const commands: Array<{ command: string; pluginId?: string }> = []
  const secrets = new Map<string, string>()
  const lifecycle: Array<{ id: string; status: string; version: string }> = []
  let unsubscribe: (() => void) | undefined
  let transactionSequence = 0

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "cognia-feishu-release-"))
    artifactRoot = path.join(root, "artifacts")
    // Isolate all builder caches and release outputs from the shared checkout.
    // The real producer consumes the host's complete curated product profile.
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import {mkdir,symlink,copyFile} from "node:fs/promises";
      import path from "node:path";
      import {producePluginArtifacts} from "./scripts/plugin/artifacts/produce.mjs";
      import {createProductProfile,readHostAuthoringIdentity} from "./scripts/build/plugin-artifact-contract.mjs";
      import {buildFrontendPlugin,writeFrontendPackage} from "./scripts/plugin/build-frontend-plugins.mjs";
      const repo=process.cwd(), out=process.argv[1], root=path.join(out,"toolchain");
      await mkdir(root,{recursive:true});
      await symlink(path.join(repo,"node_modules"),path.join(root,"node_modules"),"dir");
      for(const file of ["package.json","pnpm-lock.yaml"]) await copyFile(path.join(repo,file),path.join(root,file));
      const pluginsRoot=path.join(repo,"plugins");
      for(const directory of ${JSON.stringify(fixtureIds)})
        await writeFrontendPackage(await buildFrontendPlugin({root,pluginsRoot,directory}),path.join(out,"packages"));
      await producePluginArtifacts({root,pluginsRoot,outDir:path.join(out,"artifacts"),
        profile:createProductProfile({root:repo}),authoring:readHostAuthoringIdentity(repo)});
    `,
        root,
      ],
      { cwd: process.cwd(), stdio: "pipe", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }
    )
    catalog = JSON.parse(
      await readFile(path.join(artifactRoot, "browser-builtin-assets.json"), "utf8")
    )
    // Supply freshly produced DATA to the actual registry, rather than mocking
    // registry discovery, loading, verification, or manager implementation.
    jest.doMock("@/lib/plugin/core/browser-builtin-assets.generated.json", () => catalog)
    ;({ PluginManager: Manager } = await import("@/lib/plugin/core/manager"))
    ;({ usePluginStore: store } = await import("@/stores/plugin-runtime"))
    ;({ getDb: db } = await import("@/lib/db/schema"))
    const { createDbTestFixture } = await import("@/lib/db/test-fixture")
    fixture = createDbTestFixture({ seeded: false })
    await fixture.initialize()
    auth = await import("@/lib/plugin/auth/auth-provider-registry")
    integrations = await import("@/lib/integrations/registry")
    scheduler = await import("@/lib/plugin/scheduler/scheduler-plugin-executor")
    ;({ makeNodeFrontendImporter: importer } = await import("@/cli/src/plugin/node-importer"))
    ;({ validatePluginManifest: validate } = await import("@/lib/plugin/core/validation"))
    invokeMock = (await import("@tauri-apps/api/core")).invoke as jest.Mock
    for (const id of fixtureIds) {
      sources.set(id, JSON.parse(await readFile(`plugins/${id}/plugin.json`, "utf8")))
      packages.set(
        id,
        JSON.parse(await readFile(path.join(root, "packages", id, "plugin.json"), "utf8"))
      )
    }
  }, 150_000)

  /** Rust marketplace.rs: stage package, move old to previous-package, promote,
   * then finalize or discard/restore. No store or runtime behavior is faked. */
  async function nativeInvoke(
    command: string,
    args: Record<string, unknown> = {}
  ): Promise<unknown> {
    const pluginId = args.pluginId as string | undefined
    commands.push({ command, pluginId })
    if (command === "plugin_bundle_install_from_file") {
      expect(args.deferCommit).toBe(true)
      const bytes = await readFile(args.bundlePath as string)
      const zip = await JSZip.loadAsync(bytes)
      const manifestFile = zip.file("plugin.json")
      if (!manifestFile) throw new Error("Invalid plugin manifest: plugin.json missing")
      const manifest = JSON.parse(await manifestFile.async("string")) as PluginManifest
      const validation = validate(manifest)
      if (!validation.valid)
        throw new Error(`Invalid plugin manifest: ${validation.errors.join(", ")}`)
      const transactionId = `release-${++transactionSequence}`
      const directory = path.join(pluginRoot, ".updates", manifest.id, transactionId)
      const staged = path.join(directory, "package")
      for (const file of Object.values(zip.files).filter((entry) => !entry.dir)) {
        const destination = path.resolve(staged, file.name)
        if (!destination.startsWith(`${staged}${path.sep}`)) throw new Error("Unsafe ZIP entry")
        await mkdir(path.dirname(destination), { recursive: true })
        await writeFile(destination, await file.async("nodebuffer"))
      }
      if (!(await exists(path.join(staged, manifest.main!))))
        throw new Error("Package entry missing")
      transactions.set(transactionId, { pluginId: manifest.id, directory, committed: false })
      return {
        manifest,
        path: path.join(pluginRoot, manifest.id),
        transactionId,
        signatureVerified: false,
        bundleSha256: createHash("sha256").update(bytes).digest("hex"),
      }
    }
    if (
      [
        "plugin_commit_staged_update",
        "plugin_finalize_staged_update",
        "plugin_discard_staged_update",
      ].includes(command)
    ) {
      const id = args.transactionId as string
      const transaction = transactions.get(id)
      if (!transaction || transaction.pluginId !== pluginId)
        throw new Error("Unknown install transaction")
      const installed = path.join(pluginRoot, pluginId!)
      const previous = path.join(transaction.directory, "previous-package")
      if (command === "plugin_commit_staged_update") {
        if (transaction.committed) throw new Error("Transaction already committed")
        if (await exists(installed)) await rename(installed, previous)
        await rename(path.join(transaction.directory, "package"), installed)
        transaction.committed = true
      } else {
        if (command === "plugin_finalize_staged_update" && !transaction.committed)
          throw new Error("Uncommitted transaction")
        if (command === "plugin_discard_staged_update" && transaction.committed) {
          await rm(installed, { recursive: true, force: true })
          if (await exists(previous)) await rename(previous, installed)
        }
        await rm(transaction.directory, { recursive: true, force: true })
        transactions.delete(id)
      }
      return undefined
    }
    if (command === "plugin_scan_directory") {
      const entries = await readdir(pluginRoot, { withFileTypes: true })
      return Promise.all(
        entries
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
          .map(async (entry) => ({
            manifest: JSON.parse(
              await readFile(path.join(pluginRoot, entry.name, "plugin.json"), "utf8")
            ),
            path: path.join(pluginRoot, entry.name),
            source: "local",
            installRootKind: "installed",
          }))
      )
    }
    if (command === "plugin_uninstall")
      return rm(path.join(pluginRoot, pluginId!), { recursive: true })
    if (command === "plugin_get_directory") return pluginRoot
    if (command === "plugin_list_preopens") return []
    if (command.startsWith("secret_store_")) {
      const input = args.input as {
        namespace: string
        key: string
        value?: string
      }
      const key = JSON.stringify([input.namespace, input.key])
      if (command === "secret_store_get") return secrets.get(key) ?? null
      if (command === "secret_store_delete") {
        secrets.delete(key)
        return undefined
      }
      if (command === "secret_store_set") {
        const condition = args.condition as
          | { expected: string | null; changes: Array<{ key: string; value: string | null }> }
          | undefined
        if (condition && (secrets.get(key) ?? null) !== condition.expected)
          throw new Error("Secret revision conflict")
        secrets.set(key, input.value!)
        for (const change of condition?.changes ?? []) {
          const related = JSON.stringify([input.namespace, change.key])
          if (change.value === null) secrets.delete(related)
          else secrets.set(related, change.value)
        }
        return undefined
      }
    }
    if (
      [
        "plugin_set_status",
        "plugin_permission_grant",
        "plugin_permission_revoke",
        "plugin_set_shell_allowlist",
        "plugin_set_network_allowlist",
      ].includes(command)
    )
      return undefined
    throw new Error(`Unexpected native command: ${command}`)
  }

  function createManager(runtimeProfile: PluginRuntimeProfile = "tauri") {
    return new Manager({
      pluginDirectory: pluginRoot,
      runtimeProfile,
      lifecycleFeatures: { runtimeServices: true },
      frontendImporter: importer(),
      builtinAssetFetcher: (async (input) => {
        const url = String(input)
        const prefix = "/_cognia/builtin-plugins/"
        if (!url.startsWith(prefix)) throw new Error(`Unexpected asset: ${url}`)
        const bytes = await readFile(
          path.join(artifactRoot, "builtin-plugins", url.slice(prefix.length))
        )
        return { ok: true, arrayBuffer: async () => Uint8Array.from(bytes).buffer } as Response
      }) as typeof fetch,
    })
  }

  beforeEach(async () => {
    if (!fixture) return
    await fixture.restore()
    localStorage.clear()
    pluginRoot = await mkdtemp(path.join(root, "installed-"))
    transactions.clear()
    commands.length = 0
    lifecycle.length = 0
    secrets.clear()
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} })
    store.setState({
      plugins: {},
      removedPlugins: {},
      loading: new Set(),
      errors: {},
      loadOrder: [],
      rememberedPermissions: {},
    })
    invokeMock.mockImplementation(nativeInvoke)
    manager = createManager()
    unsubscribe = store.subscribe((state, previous) => {
      for (const id of fixtureIds) {
        const plugin = state.plugins[id]
        if (plugin && plugin.status !== previous.plugins[id]?.status)
          lifecycle.push({ id, status: plugin.status, version: plugin.manifest.version })
      }
    })
  })

  afterEach(async () => {
    unsubscribe?.()
    if (!manager) return
    try {
      for (const id of [CALENDAR, AUTH])
        if (store.getState().plugins[id]) await manager.unloadPlugin(id)
      await settleAvailability()
    } finally {
      manager.dispose()
      Reflect.deleteProperty(window, "__TAURI_INTERNALS__")
    }
  })

  afterAll(async () => {
    try {
      await fixture?.dispose()
    } finally {
      if (root) await rm(root, { recursive: true, force: true })
      jest.dontMock("@/lib/plugin/core/browser-builtin-assets.generated.json")
    }
  })

  const zipPath = (id: string, version = "1.0.0") =>
    path.join(root, "packages", `${id}-${version}.zip`)
  async function install(id: string, version = "1.0.0") {
    return manager.installPluginBundleFromLocalFile(zipPath(id, version))
  }
  async function enable(id: string) {
    await manager.setFrontendTrust(id, true)
    await manager.setPluginIntent(id, "enabled", "release-matrix")
  }
  async function installPair() {
    await install(AUTH)
    await install(CALENDAR)
    await enable(AUTH)
    await enable(CALENDAR)
    await assertActive()
  }
  async function assertActive() {
    for (const id of fixtureIds) {
      expect(store.getState().plugins[id].status).toBe("enabled")
      expect(await manager.getPluginLifecycleState(id)).toMatchObject({
        actual: "active",
        intent: "enabled",
      })
    }
    expect(manager.getPluginServiceSnapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serviceId: "auth.feishu",
          providerPluginId: AUTH,
          status: "available",
        }),
      ])
    )
    expect(auth.getProvider(PROVIDER)).toMatchObject({ pluginId: AUTH, management: "host" })
    const integration = integrations.getRegisteredIntegration(CALENDAR, CALENDAR)
    expect(integration).toBeDefined()
    for (const action of integration!.definition.actions)
      expect(typeof integration!.handlers.get(action.id)).toBe("function")
    expect(typeof integration!.resourceProvider).toBe("function")
    expect(typeof integration!.accountStatusProvider).toBe("function")
    expect(scheduler.hasPluginTaskHandler(HANDLER)).toBe(true)
  }
  async function assertWaiting(kind: "missing" | "version-mismatch", foundVersion?: string) {
    const state = await manager.getPluginLifecycleState(CALENDAR)
    expect(state).toMatchObject({ actual: "waiting", intent: "enabled" })
    expect(JSON.parse(state.lastError!)).toEqual([
      {
        serviceId: "auth.feishu",
        constraint: "^1.0.0",
        kind,
        ...(foundVersion ? { foundVersion } : {}),
      },
    ])
    expect(store.getState().plugins[CALENDAR]).toBeDefined()
    expect(store.getState().plugins[CALENDAR].status).not.toBe("enabled")
    expect(integrations.getRegisteredIntegration(CALENDAR, CALENDAR)).toBeUndefined()
    expect(scheduler.hasPluginTaskHandler(HANDLER)).toBe(false)
  }
  async function repackage(version: string, serviceVersion = "1.0.0", failActivation = false) {
    const zip = await JSZip.loadAsync(await readFile(zipPath(AUTH)))
    const manifest = {
      ...packages.get(AUTH)!,
      version,
      providesServices: { "auth.feishu": serviceVersion },
    }
    zip.file("plugin.json", JSON.stringify(manifest))
    const entry = manifest.main!
    zip.file(
      entry,
      `${await zip.file(entry)!.async("string")}\n;module.exports.default.manifest=${JSON.stringify(manifest)};${failActivation ? 'module.exports.default.activate=()=>{throw new Error("release activation failure")};' : ""}`
    )
    await writeFile(zipPath(AUTH, version), await zip.generateAsync({ type: "nodebuffer" }))
  }
  async function seedConnection() {
    const connection: AuthConnectionRow = {
      id: "release-matrix-connection" as AuthConnectionRow["id"],
      providerId: PROVIDER,
      ownerPluginId: AUTH,
      publisher: "Cognia Official",
      contractMajor: 1,
      issuer: "https://accounts.feishu.cn",
      clientId: "release-client",
      tenantId: "release-tenant",
      principalId: "release-user",
      principalKind: "user",
      accountLabel: "Release account",
      scopes: ["calendar:calendar:readonly"],
      revision: 7,
      credentialRevision: 3,
      lineageId: "release-lineage",
      status: "needs-reauth",
      identityKey: "release-identity",
      createdAt: 1,
      updatedAt: 1,
    }
    await db().authConnections.put(connection)
    return connection
  }
  async function settleAvailability() {
    // Availability reconciliation is queued by real provider registration.
    // An IDB read after a turn drains that queue without replacing its logic.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await db().authConnections.toArray()
  }
  async function assertConnection(connection: AuthConnectionRow) {
    await settleAvailability()
    const current = await db().authConnections.get(connection.id)
    expect(current).toMatchObject({ ...connection, updatedAt: expect.any(Number) })
    expect(await db().authConnections.count()).toBe(1)
  }

  it("1. discovers fresh curated built-ins, verifies source contracts, loads chunks and activates both", async () => {
    // The curation file names plugin source directories; the catalog is keyed
    // by the manifest id each directory declares.
    const curated = JSON.parse(
      await readFile("lib/plugin/distribution/browser-builtins.json", "utf8")
    ) as string[]
    const curatedIds = await Promise.all(
      curated.map(
        async (directory) =>
          (
            JSON.parse(await readFile(path.join("plugins", directory, "plugin.json"), "utf8")) as {
              id: string
            }
          ).id
      )
    )
    expect(Object.keys(catalog.entries).sort()).toEqual(curatedIds.sort())
    for (const id of fixtureIds) {
      const built = catalog.entries[id].manifest
      const source = sources.get(id)!
      expect(releaseContract(built)).toEqual(releaseContract(source))
      expect(built).toEqual(packages.get(id))
    }
    await manager.scanPlugins()
    for (const id of fixtureIds)
      expect(store.getState().plugins[id]).toMatchObject({
        source: "builtin",
        path: `builtin://${id}`,
      })
    await enable(AUTH)
    await enable(CALENDAR)
    await assertActive()
  })

  it("2. installs standalone ZIPs through staging and activates their installed bytes with manifest parity", async () => {
    await installPair()
    for (const id of fixtureIds) {
      expect(JSON.parse(await readFile(path.join(pluginRoot, id, "plugin.json"), "utf8"))).toEqual(
        packages.get(id)
      )
      expect(releaseContract(packages.get(id)!)).toEqual(releaseContract(sources.get(id)!))
      expect(store.getState().plugins[id]).toMatchObject({
        source: "local",
        path: path.join(pluginRoot, id),
      })
    }
    expect(transactions.size).toBe(0)
  })

  it("3. keeps a missing-service install visible and recovers after installing the provider", async () => {
    await install(CALENDAR)
    await enable(CALENDAR)
    await assertWaiting("missing")
    await install(AUTH)
    await enable(AUTH)
    await enable(CALENDAR)
    await assertActive()
  })

  it("4. refuses a 2.x service for ^1.0.0 and resumes after reverting to 1.x", async () => {
    await repackage("2.0.0", "2.0.0")
    await install(AUTH, "2.0.0")
    await install(CALENDAR)
    await enable(AUTH)
    await enable(CALENDAR)
    await assertWaiting("version-mismatch", "2.0.0")
    await install(AUTH)
    await enable(CALENDAR)
    await assertActive()
  })

  it("5. quiesces a running consumer before upgrading auth and restores its intent and Host connection", async () => {
    await installPair()
    const connection = await seedConnection()
    const before = await manager.getPluginLifecycleState(CALENDAR)
    lifecycle.length = 0
    await repackage("1.0.1")
    await install(AUTH, "1.0.1")
    const stoppedCalendar = lifecycle.findIndex(
      (entry) => entry.id === CALENDAR && entry.status === "disabled"
    )
    const stoppedAuth = lifecycle.findIndex(
      (entry) => entry.id === AUTH && entry.status === "disabled"
    )
    expect(stoppedCalendar).toBeGreaterThanOrEqual(0)
    expect(stoppedAuth).toBeGreaterThan(stoppedCalendar)
    expect(store.getState().plugins[AUTH].manifest.version).toBe("1.0.1")
    expect((await manager.getPluginLifecycleState(CALENDAR)).intent).toBe(before.intent)
    await assertActive()
    await assertConnection(connection)
  })

  it("6. restores 1.0.1 files, runtime, consumer and connection after a failed 1.0.2 activation", async () => {
    await installPair()
    await repackage("1.0.1")
    await install(AUTH, "1.0.1")
    const connection = await seedConnection()
    const previousEntry = await readFile(path.join(pluginRoot, AUTH, packages.get(AUTH)!.main!))
    await repackage("1.0.2", "1.0.0", true)
    await expect(install(AUTH, "1.0.2")).rejects.toThrow("release activation failure")
    expect(
      JSON.parse(await readFile(path.join(pluginRoot, AUTH, "plugin.json"), "utf8")).version
    ).toBe("1.0.1")
    expect(await readFile(path.join(pluginRoot, AUTH, packages.get(AUTH)!.main!))).toEqual(
      previousEntry
    )
    expect(store.getState().plugins[AUTH].manifest.version).toBe("1.0.1")
    await assertActive()
    await assertConnection(connection)
    expect(transactions.size).toBe(0)
  })

  it("6. refuses a ZIP with a corrupt manifest before touching the live installation", async () => {
    await installPair()
    const connection = await seedConnection()
    const bytes = await readFile(path.join(pluginRoot, AUTH, "plugin.json"))
    const zip = await JSZip.loadAsync(await readFile(zipPath(AUTH)))
    zip.file("plugin.json", JSON.stringify({ id: AUTH, version: "bad" }))
    const corrupt = path.join(root, "corrupt.zip")
    await writeFile(corrupt, await zip.generateAsync({ type: "nodebuffer" }))
    commands.length = 0
    lifecycle.length = 0
    await expect(manager.installPluginBundleFromLocalFile(corrupt)).rejects.toThrow(
      "Invalid plugin manifest"
    )
    expect(commands.map((entry) => entry.command)).toEqual(["plugin_bundle_install_from_file"])
    expect(lifecycle).toEqual([])
    expect(await readFile(path.join(pluginRoot, AUTH, "plugin.json"))).toEqual(bytes)
    await assertActive()
    await assertConnection(connection)
  })

  it("7. preserves an independent same-id install over the bundled catalog on rediscovery", async () => {
    // seed-bundled-plugins.ts policy: independently installed packages win.
    await manager.scanPlugins()
    expect(store.getState().plugins[AUTH].source).toBe("builtin")
    await repackage("1.0.1")
    await install(AUTH, "1.0.1")
    await manager.scanPlugins()
    expect(store.getState().plugins[AUTH]).toMatchObject({
      source: "local",
      path: path.join(pluginRoot, AUTH),
      manifest: { version: "1.0.1" },
    })
    await enable(AUTH)
    await enable(CALENDAR)
    await assertActive()
  })

  it("8. lets the service provider be uninstalled: the consumer waits and the Host connection is tombstoned", async () => {
    // A `requiresServices` consumer does not pin its provider the way a package
    // `dependencies` entry does: the uninstall dialog says "Plugins using them
    // lose access" (ADR-0246 §9). The consumer keeps its enable intent and
    // waits for any compatible provider; nothing is left half-running.
    await installPair()
    const connection = await seedConnection()
    await manager.uninstallPlugin(AUTH)
    expect(store.getState().plugins[AUTH]).toBeUndefined()
    expect(auth.getProvider(PROVIDER)).toBeUndefined()
    expect(await exists(path.join(pluginRoot, AUTH))).toBe(false)
    await assertWaiting("missing")
    // ADR §4 forbids owner takeover; §5 requires a revocation barrier.
    expect(await db().authConnections.get(connection.id)).toMatchObject({
      id: connection.id,
      ownerPluginId: AUTH,
      status: "tombstoned",
      revision: connection.revision + 1,
    })
    // Reinstalling the provider resumes the consumer, but never revives the
    // tombstoned connection: a new owner starts with new connections.
    await install(AUTH)
    await enable(AUTH)
    await enable(CALENDAR)
    await assertActive()
    expect(await db().authConnections.get(connection.id)).toMatchObject({ status: "tombstoned" })
    await manager.uninstallPlugin(CALENDAR)
    expect(store.getState().plugins[CALENDAR]).toBeUndefined()
  })
})
