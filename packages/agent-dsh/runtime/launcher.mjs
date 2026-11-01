/** Cognia's verified entry into the official DSH product launcher. */
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { createRequire, registerHooks } from "node:module"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads"
import { execFileSync } from "node:child_process"

export const DSH_VERSION = "0.2.1-rc.2"
export const PROFILE_BY_COMPOSITION = Object.freeze({
  "host.sdk-readonly.yml": "cognia-sdk-readonly",
  "host.sdk-workspace.yml": "cognia-sdk-workspace",
  "host.acp.yml": "cognia-acp",
})

function kernelBootId() {
  const value =
    process.platform === "linux"
      ? readFileSync("/proc/sys/kernel/random/boot_id", "utf8")
      : process.platform === "darwin"
        ? execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8" })
        : ""
  const boot = value.trim().toLowerCase()
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(boot))
    throw new Error("DeepSeek Harness cannot verify the system boot identity")
  return boot
}

/** Sandboxed launches read the host's freshly minted ownership proof instead
 * of gaining write access to host control state. Host PIDs can belong to an
 * outer namespace, so their liveness is checked by the host, never here.
 */
export async function waitForHostProcessLease(runtimeHome, identity, nonce, timeoutMs = 5000) {
  if (typeof runtimeHome !== "string" || !isAbsolute(runtimeHome))
    throw new Error("COGNIA_DSH_RUNTIME_HOME must be an absolute runtime path")
  if (
    typeof identity !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(identity)
  )
    throw new Error("DeepSeek Harness host ownership identity is malformed")
  if (typeof nonce !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(nonce))
    throw new Error("DeepSeek Harness host ownership nonce is missing or malformed")
  const nonceDigest = createHash("sha256").update(nonce).digest("hex")
  const control = join(dirname(realpathSync(runtimeHome)), ".deepseek-harness-control")
  const directory = join(control, "processes")
  const recordPath = join(directory, `${identity}.json`)
  const deadline = performance.now() + timeoutMs
  while (true) {
    let record
    try {
      for (const path of [control, directory]) {
        const metadata = lstatSync(path)
        if (!metadata.isDirectory() || metadata.isSymbolicLink())
          throw new Error("unsafe directory")
      }
      const metadata = lstatSync(recordPath)
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("unsafe record")
      record = JSON.parse(readFileSync(recordPath, "utf8"))
    } catch {
      throw new Error("DeepSeek Harness host ownership record is missing or unreadable")
    }
    if (
      record?.schemaVersion !== 2 ||
      record.retirementRequired !== true ||
      record.retired !== false ||
      typeof record.bootId !== "string" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(record.bootId) ||
      !Number.isSafeInteger(record.pid) ||
      record.pid <= 0 ||
      (record.childPid !== undefined &&
        (!Number.isSafeInteger(record.childPid) || record.childPid <= 0))
    )
      throw new Error("DeepSeek Harness host ownership record is malformed")
    if (record.nonceDigest !== nonceDigest)
      throw new Error("DeepSeek Harness host ownership nonce does not match this launch")
    // The host publishes childPid after actual spawn. Before publication a
    // dead parent must never leave an admitted, unowned runtime behind.
    if (record.childPid !== undefined) return
    if (performance.now() >= deadline)
      throw new Error("DeepSeek Harness host did not confirm process ownership before startup")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Register this actual runtime PID before profile writes or upstream loading.
 * Hosts also register pending launches. Publish-before-check matches the Node
 * and Rust maintenance admission protocol, so either side observes the other.
 */
export function acquireRuntimeProcessLease(runtimeHome) {
  if (typeof runtimeHome !== "string" || !isAbsolute(runtimeHome))
    throw new Error("COGNIA_DSH_RUNTIME_HOME must be an absolute runtime path")
  const control = join(dirname(realpathSync(runtimeHome)), ".deepseek-harness-control")
  for (const directory of [control, join(control, "maintenance"), join(control, "processes")]) {
    try {
      mkdirSync(directory, { mode: 0o700 })
    } catch (error) {
      if (error.code !== "EEXIST") throw error
    }
    const metadata = lstatSync(directory)
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error("DeepSeek Harness ownership directory must not be a symlink")
  }
  const identity = randomUUID()
  const lease = join(control, "processes", `${identity}.json`)
  const temporary = join(control, "processes", `${identity}.tmp`)
  let released = false
  const release = () => {
    if (released) return
    try {
      unlinkSync(lease)
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
    released = true
  }
  try {
    writeFileSync(
      temporary,
      JSON.stringify({
        schemaVersion: 2,
        pid: process.pid,
        processId: "dsh-runtime",
        bootId: kernelBootId(),
        retirementRequired: true,
        retired: false,
      }),
      { flag: "wx", mode: 0o600 }
    )
    renameSync(temporary, lease)
    for (const name of readdirSync(join(control, "maintenance"))) {
      if (!name.endsWith(".json")) continue
      const recordPath = join(control, "maintenance", name)
      let record
      try {
        const metadata = lstatSync(recordPath)
        if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("unsafe record")
        record = JSON.parse(readFileSync(recordPath, "utf8"))
      } catch (error) {
        // An owner may finish between directory enumeration and this read.
        if (error.code === "ENOENT") continue
        throw new Error("DeepSeek Harness maintenance ownership is unreadable")
      }
      if (
        record?.schemaVersion !== 1 ||
        !Number.isSafeInteger(record.pid) ||
        record.pid <= 0 ||
        typeof record.operationId !== "string" ||
        !record.operationId
      )
        throw new Error("DeepSeek Harness maintenance ownership is malformed")
      try {
        process.kill(record.pid, 0)
      } catch (error) {
        if (error.code === "ESRCH") continue
        // EPERM and unknown liveness failures cannot grant admission.
      }
      throw new Error("DeepSeek Harness runtime maintenance is in progress")
    }
  } catch (error) {
    release()
    throw error
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
  return release
}

function inside(child, parent) {
  const path = relative(parent, child)
  return (
    path === "" ||
    (path !== ".." && !path.startsWith("../") && !path.startsWith("..\\") && !isAbsolute(path))
  )
}

// Resolve existing ancestors too: a not-yet-created child of a symlink must
// never pass containment merely because realpath(child) returns ENOENT.
function canonical(path) {
  try {
    return realpathSync(path)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
    const parent = dirname(resolve(path))
    if (parent === resolve(path)) throw error
    return join(canonical(parent), basename(path))
  }
}

export function managedProfileManifest(profile) {
  return {
    name: profile,
    private: true,
    type: "module",
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-sdk-minimal"], patchReload: "startup" } },
  }
}

/** Validate owned files before the product CLI can evaluate any patch or .env. */
export function prepareLaunch(argv, env) {
  if (argv.length !== 3 || !isAbsolute(argv[2] ?? "")) {
    throw new Error("Usage: node launcher.mjs <absolute-path-to-host-composition.yml>")
  }
  if (!env.COGNIA_DSH_RUNTIME_HOME || !env.DSH_HOME) {
    throw new Error("COGNIA_DSH_RUNTIME_HOME and DSH_HOME must be set by Cognia's runtime manager")
  }
  const runtimeHome = realpathSync(env.COGNIA_DSH_RUNTIME_HOME)
  const home = canonical(env.DSH_HOME)
  if (!inside(home, runtimeHome) || home === runtimeHome) {
    throw new Error("DSH_HOME must be an isolated directory inside the Cognia runtime home")
  }
  const composition = realpathSync(argv[2])
  const profile = PROFILE_BY_COMPOSITION[basename(composition)]
  if (!profile || dirname(composition) !== runtimeHome) {
    throw new Error("Composition must be a managed host profile inside the Cognia runtime home")
  }
  const profileDir = canonical(join(home, "profiles", profile))
  if (!inside(profileDir, home)) throw new Error("Managed profile escapes DSH_HOME")
  for (const path of [
    join(home, "cordis.patch.yml"),
    join(profileDir, "cordis.patch.yml"),
    join(home, ".env"),
  ]) {
    if (existsSync(path)) throw new Error(`Unmanaged DSH configuration: ${path}`)
  }
  const manifest = managedProfileManifest(profile)
  const manifestPath = join(profileDir, "package.json")
  if (!existsSync(manifestPath)) {
    mkdirSync(profileDir, { recursive: true })
    // Multiple agents may start this profile at once. Publish a complete file
    // atomically without overwriting an existing or concurrently created one.
    const temporary = join(profileDir, `.manifest-${randomUUID()}.tmp`)
    try {
      writeFileSync(temporary, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" })
      try {
        linkSync(temporary, manifestPath)
      } catch (error) {
        if (error.code !== "EEXIST") throw error
      }
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary)
    }
  }
  if (
    !inside(realpathSync(manifestPath), home) ||
    JSON.stringify(JSON.parse(readFileSync(manifestPath, "utf8"))) !== JSON.stringify(manifest)
  ) {
    throw new Error(
      `Managed DSH profile manifest differs from the approved composition: ${manifestPath}`
    )
  }
  const workspace = env.COGNIA_DSH_WORKSPACE ?? process.cwd()
  if (!isAbsolute(workspace)) throw new Error("COGNIA_DSH_WORKSPACE must be absolute")
  const sessionRoot = canonical(env.COGNIA_DSH_SESSION_ROOT ?? join(runtimeHome, "sessions"))
  if (!inside(sessionRoot, runtimeHome))
    throw new Error("Session persistence must remain inside the runtime home")
  return { home, profile, composition, workspace, sessionRoot }
}

export function resolveProductLauncher(require = createRequire(import.meta.url)) {
  const manifestPath = require.resolve("@deepseek-ai/dsh/package.json")
  for (const name of [
    "dsh",
    "dsh-sdk-minimal",
    "dsh-sdk-protocol",
    "dsh-sdk-jsonrpc-server",
    "dsh-acp",
    "dsh-app-boot",
    "dsh-launch-environment",
    "dsh-sdk-app",
    "dsh-acp-app",
    "dsh-session",
    "dsh-agent",
    "dsh-fs-sandbox",
    "dsh-tool-fs",
    "dsh-user-approval",
    "dsh-attachment-local",
    "dsh-mcp-client",
    "dsh-llm-pi-ai",
    "dsh-llm-deepseek-api-key",
    "dsh-working-directory",
    "dsh-tool-working-directory",
    "dsh-compaction-basic",
    "dsh-compaction-image-offload",
  ]) {
    const pkg = JSON.parse(
      readFileSync(require.resolve(`@deepseek-ai/${name}/package.json`), "utf8")
    )
    if (pkg.version !== DSH_VERSION)
      throw new Error(
        `Unsupported ${pkg.name} version ${pkg.version}; reinstall the managed ${DSH_VERSION} runtime`
      )
  }
  return join(dirname(manifestPath), "lib", "bin.js")
}

const MANAGED_MODULE_POLICY = "cognia/dsh-managed-module-policy"

/** The official CLI keeps its profile lifecycle; its host-facing boot exports
 * close over the certified bundle and overlay instead of mutable user layers.
 */
export function createManagedAppBoot(upstream, policy, createEnvironmentSnapshot) {
  let selected
  return {
    // All launch configuration already came through the host's environment
    // gate. Mutable profile/home dotenv files cannot add a second source.
    loadEnv() {},
    loadLayeredEnv() {
      return createEnvironmentSnapshot([{ source: "process", values: { ...process.env } }])
    },
    loadProfile(binName, name, installAnchor, home, options) {
      if (name !== policy.profile) throw new Error("Unmanaged DeepSeek Harness profile")
      const profile = upstream.loadProfile(binName, name, installAnchor, home, {
        ...options,
        userLayer: false,
      })
      if (
        profile.layers.length !== 1 ||
        profile.layers[0].packageName !== "@deepseek-ai/dsh-sdk-minimal" ||
        realpathSync(profile.layers[0].packageDir) !== policy.bundleDir
      )
        throw new Error("DeepSeek Harness profile must use its certified installation bundle")
      selected = { ...profile, patches: [] }
      return selected
    },
    readProfilePatches(binName, context, initialProfile) {
      if (!selected || initialProfile !== selected)
        throw new Error("DeepSeek Harness profile was not prepared by its managed host")
      const patches = structuredClone([
        ...upstream.readBundlePatches(binName, context, selected),
        ...upstream.loadOverlayPatches(binName, policy.composition),
      ])
      const telemetry = upstream.resolveTelemetryPatch(
        "1",
        upstream.composeEntries([patches]).some((row) => row.id === "session-telemetry-otel")
      )
      if (telemetry) patches.push(telemetry)
      return patches
    },
    boot(binName, _profileConfig, patches, prepare) {
      return upstream.boot(
        binName,
        policy.rootConfig,
        patches,
        async (ctx) => {
          await prepare?.(ctx)
          // Include normally writes back plugin retirement into its root YAML.
          // This host-owned root is immutable; profile/session data stays writable.
          let include
          Object.defineProperty(ctx.loader.builtins, "include", {
            configurable: false,
            get: () => include,
            set: (Base) => {
              include = class ManagedInclude extends Base {
                write() {
                  if (this.filename !== policy.rootConfig) return super.write()
                }
              }
            },
          })
        },
        pathToFileURL(policy.runtimeHome + "/").href
      )
    },
  }
}

/** Pin both module selection and loading, including late profile mutations.
 * Canonical URLs are delegated, so changing a writable symlink after admission
 * cannot redirect the bytes Node actually loads.
 */
export function installManagedModulePolicy(policy) {
  const facade = `data:text/javascript,${encodeURIComponent(`
    import * as upstream from ${JSON.stringify(policy.appBootUrl)};
    import { createManagedAppBoot } from ${JSON.stringify(policy.launcherUrl)};
    import { createLaunchEnvironmentSnapshot } from ${JSON.stringify(policy.launchEnvironmentUrl)};
    export * from ${JSON.stringify(policy.appBootUrl)};
    export const { boot, loadProfile, readProfilePatches, loadEnv, loadLayeredEnv } = createManagedAppBoot(upstream, ${JSON.stringify(policy)}, createLaunchEnvironmentSnapshot);
  `)}`
  const pluginNetworkFacade = policy.modlensCliUrl
    ? `data:text/javascript,${encodeURIComponent(`
      import { fetch as nativeFetch } from ${JSON.stringify(policy.undiciUrl)};
      export * from ${JSON.stringify(policy.undiciUrl)};
      import { managedPluginFetch } from ${JSON.stringify(policy.launcherUrl)};
      export const fetch = (input, init) => managedPluginFetch(nativeFetch, input, init);
    `)}`
    : undefined
  const admittedUrl = (url) => {
    if (url.startsWith("node:") || url === facade || url === pluginNetworkFacade) return url
    if (!url.startsWith("file:")) throw new Error("Unmanaged DeepSeek Harness module URL")
    const original = new URL(url)
    const filename = realpathSync(fileURLToPath(original))
    if (
      policy.stateRoots.some((root) => inside(filename, root)) ||
      ![policy.runtimeHome, policy.modules].some((root) => inside(filename, root))
    )
      throw new Error(`DeepSeek Harness cannot load module code from writable state: ${filename}`)
    const canonical = pathToFileURL(filename)
    canonical.search = original.search
    canonical.hash = original.hash
    return canonical.href
  }
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "@deepseek-ai/dsh-app-boot") return { url: facade, shortCircuit: true }
      if (specifier === "undici" && context.parentURL === policy.modlensCliUrl)
        return { url: pluginNetworkFacade, shortCircuit: true }
      const resolved = nextResolve(specifier, context)
      return { ...resolved, url: admittedUrl(resolved.url) }
    },
    load(url, context, nextLoad) {
      return nextLoad(admittedUrl(url), context)
    },
  })
}

/** The pinned ModLens CLI may POST only to its admitted gateway, without redirects. */
export async function managedPluginFetch(fetch, input, init) {
  const expected = new URL(`${process.env.OPENAI_BASE_URL.replace(/\/$/, "")}/chat/completions`)
  if (typeof input !== "string" || new URL(input).href !== expected.href || init?.method !== "POST")
    throw new Error("Managed ModLens network target refused")
  return fetch(input, { ...init, redirect: "error" })
}

export function prepareManagedModulePolicy(
  runtimeHome,
  launch,
  require = createRequire(import.meta.url)
) {
  const policy = {
    runtimeHome: realpathSync(runtimeHome),
    modules: realpathSync(join(runtimeHome, "node_modules")),
    stateRoots: [launch.home, launch.sessionRoot],
    profile: launch.profile,
    composition: launch.composition,
    rootConfig: realpathSync(join(runtimeHome, "host.root.yml")),
    appBootUrl: pathToFileURL(realpathSync(require.resolve("@deepseek-ai/dsh-app-boot"))).href,
    launchEnvironmentUrl: pathToFileURL(
      realpathSync(require.resolve("@deepseek-ai/dsh-launch-environment"))
    ).href,
    bundleDir: realpathSync(dirname(require.resolve("@deepseek-ai/dsh-sdk-minimal/package.json"))),
    launcherUrl: import.meta.url,
  }
  for (const path of [policy.rootConfig, policy.composition]) {
    if (!inside(path, policy.runtimeHome) || policy.stateRoots.some((root) => inside(path, root)))
      throw new Error("DeepSeek Harness configuration must remain in protected runtime code")
  }
  if (
    policy.stateRoots.some((root) => inside(policy.modules, root)) ||
    !inside(policy.bundleDir, policy.modules) ||
    !inside(fileURLToPath(policy.appBootUrl), policy.modules) ||
    !inside(fileURLToPath(policy.launchEnvironmentUrl), policy.modules)
  )
    throw new Error("DeepSeek Harness modules must come from the protected installation")
  // The upstream internal-loader addon otherwise copies executable bindings
  // into a shared writable temp cache. Load its installed prebuild directly.
  process.env.NARB_DISABLE_NATIVE_CACHE = "1"
  setEnvironmentData(MANAGED_MODULE_POLICY, policy)
  // Workers inheriting launcher execArgv install the closed runtime policy
  // before upstream resolution. Spawned tools do not inherit environment data.
  if (!process.execArgv.some((arg) => arg === import.meta.url))
    process.execArgv.push("--import", import.meta.url)
  installManagedModulePolicy(policy)
  return policy
}

const inheritedModulePolicy = getEnvironmentData(MANAGED_MODULE_POLICY)
if (inheritedModulePolicy) installManagedModulePolicy(inheritedModulePolicy)

function parseJson(raw, field) {
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`${field} must contain valid JSON`)
  }
}
function httpUrl(raw, field) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${field} must use an absolute HTTP(S) URL`)
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`${field} must use HTTP(S)`)
  return url
}

/** Same ACP-shaped descriptors on both transports; SDK mounts at process startup. */
export function resolveMcpConfigs(raw, workspace) {
  const servers = raw === undefined ? [] : parseJson(raw, "COGNIA_DSH_MCP_SERVERS")
  if (!Array.isArray(servers)) throw new Error("COGNIA_DSH_MCP_SERVERS must be an array")
  const seen = new Set()
  const entries = (values, header = false) => {
    if (!Array.isArray(values)) throw new Error("MCP environment/headers must be name/value arrays")
    const result = Object.create(null)
    const names = new Set()
    for (const entry of values) {
      if (
        !entry ||
        typeof entry.name !== "string" ||
        typeof entry.value !== "string" ||
        !entry.name ||
        /[=\0]/.test(entry.name) ||
        entry.value.includes("\0")
      )
        throw new Error("Invalid MCP environment/header entry")
      const identity = header ? entry.name.toLowerCase() : entry.name
      if (names.has(identity)) throw new Error("Duplicate MCP environment/header entry")
      names.add(identity)
      if (header) {
        try {
          new Headers([[entry.name, entry.value]])
        } catch {
          throw new Error("Invalid MCP header entry")
        }
      }
      result[entry.name] = entry.value
    }
    return result
  }
  return servers.map((server) => {
    if (
      !server ||
      typeof server.name !== "string" ||
      !server.name.trim() ||
      /[\u0000-\u001f\u007f]/.test(server.name)
    )
      throw new Error("Invalid MCP server name")
    const serverName = /^[A-Za-z0-9_-]{1,32}$/.test(server.name)
      ? server.name
      : `${
          server.name
            .normalize("NFKD")
            .replace(/[^A-Za-z0-9_-]+/g, "_")
            .replace(/^_+|_+$/g, "")
            .slice(0, 20) || "server"
        }_${createHash("sha256").update(server.name).digest("hex").slice(0, 8)}`.slice(0, 32)
    if (seen.has(serverName)) throw new Error("Duplicate MCP server namespace")
    seen.add(serverName)
    const shared = { serverName, failOnStartupError: true }
    if (!("type" in server)) {
      if (
        typeof server.command !== "string" ||
        !isAbsolute(server.command) ||
        !Array.isArray(server.args) ||
        server.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
      )
        throw new Error("MCP stdio requires an absolute command and string args")
      return {
        ...shared,
        transport: "stdio",
        command: server.command,
        args: server.args,
        env: entries(server.env ?? []),
        cwd: workspace,
      }
    }
    if (server.type !== "http") throw new Error("MCP transport must be stdio or HTTP")
    const url = httpUrl(server.url, "MCP endpoint")
    return {
      ...shared,
      transport: "streamable-http",
      url: url.href,
      headers: entries(server.headers ?? [], true),
    }
  })
}

export function resolveCogniaServices(env, workspace, profile) {
  const mcp = resolveMcpConfigs(env.COGNIA_DSH_MCP_SERVERS, workspace)
  if (profile === "cognia-acp" && mcp.length)
    throw new Error("ACP MCP servers must be scoped through session/new")
  for (const key of ["COGNIA_DSH_ALLOWED_TOOLS", "COGNIA_DSH_ADDITIONAL_DIRECTORIES"]) {
    if (env[key] === undefined) continue
    const values = parseJson(env[key], key)
    if (
      !Array.isArray(values) ||
      values.some((value) => typeof value !== "string" || !value || value.includes("\0"))
    )
      throw new Error(`${key} must be a string array`)
    if (key === "COGNIA_DSH_ADDITIONAL_DIRECTORIES" && values.some((value) => !isAbsolute(value)))
      throw new Error("Additional workspace directories must be absolute")
  }
  const provider = env.COGNIA_DSH_PROVIDER ?? "deepseek-official"
  if (!["deepseek-official", "cognia"].includes(provider))
    throw new Error("Unsupported managed model provider")
  let gateway
  if (provider === "cognia") {
    if (!env.COGNIA_DSH_GATEWAY_CONFIG || !env.COGNIA_DSH_GATEWAY_TOKEN)
      throw new Error("Cognia provider requires a managed gateway lease")
    gateway = parseJson(env.COGNIA_DSH_GATEWAY_CONFIG, "COGNIA_DSH_GATEWAY_CONFIG")
    const route = gateway?.providers?.cognia
    if (
      Object.keys(gateway?.providers ?? {}).length !== 1 ||
      route?.api !== "openai-completions" ||
      route.apiKeyEnv !== "COGNIA_DSH_GATEWAY_TOKEN" ||
      !Array.isArray(route.models) ||
      !route.models.some((model) => model.id === env.COGNIA_DSH_MODEL)
    )
      throw new Error("Cognia gateway route must name the selected model and managed credential")
    const endpoint = httpUrl(route.baseURL, "Cognia gateway endpoint")
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password)
      throw new Error("Invalid Cognia gateway endpoint")
  } else if (env.COGNIA_DSH_GATEWAY_CONFIG || env.COGNIA_DSH_GATEWAY_TOKEN)
    throw new Error("Cognia gateway lease requires the Cognia provider")
  return { mcp, gateway }
}

// This same digest-verified artifact is a Cordis plugin. Transports explicitly
// wait for its readiness service, so no prompt can race MCP discovery or route
// registration. Importing the plugin never executes the CLI entry below.
export const name = "cognia-services"
export const inject = ["tools", "llm", "fs"]
export async function apply(ctx) {
  const services = resolveCogniaServices(
    process.env,
    process.env.COGNIA_DSH_WORKSPACE,
    process.env.COGNIA_DSH_PROFILE
  )
  if (services.gateway) {
    const adapter = await import("@deepseek-ai/dsh-llm-pi-ai")
    await ctx.plugin(adapter, { providers: services.gateway.providers })
  }
  if (services.mcp.length) {
    const bridge = await import("@deepseek-ai/dsh-mcp-client")
    for (const config of services.mcp) await ctx.plugin(bridge, config)
  }
  const { mountManagedPlugins } = await import("./managed-plugins.mjs")
  await mountManagedPlugins(ctx)
  // allowedTools is preapproval, not a visibility mask. Broker authorization
  // owns those grants and extra roots; native tools keep the profile sandbox.
  ctx.provide("cogniaServicesReady", { ready: true })
}

export async function main() {
  const identity = process.env.COGNIA_DSH_PROCESS_LEASE
  const nonce = process.env.COGNIA_DSH_PROCESS_LEASE_NONCE
  // Do not let upstream tools or descendant sessions inherit this launch's
  // proof. Only its digest is retained in the read-only host record.
  delete process.env.COGNIA_DSH_PROCESS_LEASE
  delete process.env.COGNIA_DSH_PROCESS_LEASE_NONCE
  if (identity !== undefined || nonce !== undefined) {
    await waitForHostProcessLease(process.env.COGNIA_DSH_RUNTIME_HOME, identity, nonce)
  } else {
    // Exit status cannot establish that owned descendants have retired.
    // Leave the boot-scoped record for authoritative host maintenance checks.
    acquireRuntimeProcessLease(process.env.COGNIA_DSH_RUNTIME_HOME)
  }
  const launch = prepareLaunch(process.argv, process.env)
  const bin = resolveProductLauncher()
  prepareManagedModulePolicy(process.env.COGNIA_DSH_RUNTIME_HOME, launch)
  resolveCogniaServices(process.env, launch.workspace, launch.profile)
  process.env.COGNIA_DSH_PROFILE = launch.profile
  process.env.DSH_HOME = launch.home
  process.env.COGNIA_DSH_WORKSPACE = launch.workspace
  process.env.COGNIA_DSH_SESSION_ROOT = launch.sessionRoot
  process.env.DSH_TELEMETRY_DISABLED = "1"
  // The public CLI reads cwd/.env. Boot from the isolated home so workspace
  // credentials cannot bypass Cognia's scrubbed child environment. Both SDK
  // initialize and ACP session/new carry the actual workspace explicitly.
  process.chdir(launch.home)
  process.argv = [process.execPath, bin, "--profile", launch.profile, "--patch", launch.composition]
  const { runCli } = await import(pathToFileURL(bin).href)
  await runCli()
}

if (process.argv[1] && canonical(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    process.stderr.write(`[cognia-dsh] ${error?.message ?? String(error)}\n`)
    process.exitCode = 1
  })
}
