/** Fixed backend adapters, deliberately independent of upstream bundle defaults. */
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { constants, readFileSync, realpathSync } from "node:fs"
import { mkdtemp, open, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { userInfo } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { installManagedModulePolicy } from "./launcher.mjs"

export const OPS_READERS = Object.freeze([
  "inspect_local_file",
  "read_files",
  "glob",
  "grep",
  "stat",
  "diff",
  "read_table",
  "read_docx",
  "read_pdf",
])
const LIMIT = 128 * 1024
const TIMEOUT = 30000
const VERSIONS = { "dsh-ops": "0.4.4", "@liustack/modlens": "3.27.2" }
const OPS_SOURCE = "fc11890f7668c9912fcde1df1ca89810e1cbc031"

function inside(path, root) {
  const rel = relative(root, path)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/** Open and read one admitted image without following a leaf OR ancestor swap. */
export async function readManagedImage(path, signal, maxBytes = 20 * 1024 * 1024) {
  signal?.throwIfAborted()
  if (!isAbsolute(path)) throw new Error("Managed image path must be absolute")
  let handle
  if (process.platform === "darwin") {
    // Darwin O_NOFOLLOW_ANY, xnu/bsd/sys/fcntl.h: no symlinks in ANY component.
    // Node does not expose this flag. Never degrade to leaf-only O_NOFOLLOW.
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | 0x20000000)
  } else if (process.platform === "linux") {
    // Linux exposes directory-descriptor-relative traversal through procfs.
    // Each next component is anchored to the held parent, even across rename.
    let parent = await open("/", constants.O_RDONLY | constants.O_DIRECTORY)
    try {
      const parts = path.split("/").filter(Boolean)
      for (const [index, part] of parts.entries()) {
        const flags =
          constants.O_RDONLY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK |
          (index < parts.length - 1 ? constants.O_DIRECTORY : 0)
        const next = await open(`/proc/self/fd/${parent.fd}/${part}`, flags)
        await parent.close()
        parent = next
      }
      handle = parent
      parent = undefined
    } finally {
      await parent?.close()
    }
  } else throw new Error("Managed image path opening is unavailable on this platform")
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > maxBytes)
      throw new Error("Managed image path must be a bounded regular file")
    const chunks = []
    let size = 0
    while (true) {
      signal?.throwIfAborted()
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - size))
      const { bytesRead } = await handle.read(buffer)
      size += bytesRead
      if (size > maxBytes) throw new Error("Managed image byte limit exceeded")
      if (bytesRead === 0) break
      chunks.push(buffer.subarray(0, bytesRead))
    }
    return Buffer.concat(chunks, size)
  } finally {
    await handle.close()
  }
}

function artifacts(runtimeHome) {
  const modules = realpathSync(join(runtimeHome, "node_modules"))
  const require = createRequire(join(runtimeHome, "package.json"))
  const roots = Object.fromEntries(
    Object.entries(VERSIONS).map(([name, version]) => {
      const manifest = realpathSync(require.resolve(`${name}/package.json`))
      if (
        !inside(manifest, modules) ||
        JSON.parse(readFileSync(manifest, "utf8")).version !== version
      )
        throw new Error("Managed DSH plugin installation does not match the certified release")
      return [name, dirname(manifest)]
    })
  )
  // Check every executable/JS artifact again immediately before use. Never
  // honor DSH_OPS_WORKER_BIN, binaryPath, MODLENS_DSH_CLI or source-tree builds.
  const protectedFile = (root, path) => {
    const file = realpathSync(join(root, path))
    if (!inside(file, root) || !inside(file, modules))
      throw new Error("Managed DSH plugin artifact escaped the protected installation")
    return file
  }
  return { modules, roots, protectedFile }
}

/** A bounded child with no shell, inherited options, environment or fallback. */
export async function runPlugin(argv, { cwd, env, input, signal, timeout = TIMEOUT }) {
  signal?.throwIfAborted()
  return new Promise((resolveResult, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ["pipe", "pipe", "pipe"] })
    let output = Buffer.alloc(0)
    let failure
    const stop = (error) => {
      failure ??= error
      child.kill("SIGKILL")
    }
    const abort = () => stop(signal.reason ?? new Error("Managed DSH plugin cancelled"))
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
    const timer = setTimeout(() => stop(new Error("Managed DSH plugin timed out")), timeout)
    child.stdout.on("data", (chunk) => {
      if (output.length + chunk.length > LIMIT)
        stop(new Error("Managed DSH plugin output limit exceeded"))
      else output = Buffer.concat([output, chunk])
    })
    // Drain diagnostics without reflecting private paths or credentials into
    // the model-visible error, and without retaining unbounded stderr.
    child.stderr.resume()
    child.stdin.on("error", () => {})
    child.once("error", (error) => {
      failure ??= error
    })
    child.once("close", (code) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      if (failure) reject(failure)
      else if (code !== 0)
        reject(
          new Error("Managed DSH plugin failed; no alternate executor or provider was attempted")
        )
      else {
        try {
          resolveResult(JSON.parse(output.toString("utf8")))
        } catch {
          reject(new Error("Managed DSH plugin returned invalid JSON"))
        }
      }
    })
    child.stdin.end(input ?? "")
  })
}

export function resolveVisionRoute(env) {
  if (env.COGNIA_DSH_PROVIDER !== "cognia" || !env.COGNIA_DSH_GATEWAY_TOKEN)
    throw new Error("ModLens requires a vision-capable Cognia model; configure aux.vision")
  const gateway = JSON.parse(env.COGNIA_DSH_GATEWAY_CONFIG ?? "null")
  const route = gateway?.providers?.cognia
  const model = gateway?.visionModel ?? env.COGNIA_DSH_MODEL
  if (
    route?.api !== "openai-completions" ||
    route.apiKeyEnv !== "COGNIA_DSH_GATEWAY_TOKEN" ||
    !route.models?.some((entry) => entry.id === model && entry.input?.includes("image"))
  )
    throw new Error("ModLens requires a frozen vision-capable Cognia model")
  const url = new URL(route.baseURL)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Invalid managed vision gateway endpoint")
  return { model, baseURL: url.href, token: env.COGNIA_DSH_GATEWAY_TOKEN }
}

export async function mountManagedPlugins(ctx, env = process.env) {
  const runtimeHome = realpathSync(env.COGNIA_DSH_RUNTIME_HOME)
  const workspace = await ctx.fs.resolve(env.COGNIA_DSH_WORKSPACE)
  const { roots, protectedFile } = artifacts(runtimeHome)
  const opsRoot = roots["dsh-ops"]
  const { credentialPath, credentialRoots, CREDENTIAL_SUFFIXES } = await import(
    pathToFileURL(protectedFile(opsRoot, "lib/credential-policy.js")).href
  )
  const { definition } = await import(
    pathToFileURL(protectedFile(opsRoot, "lib/file/contract.js")).href
  )
  const forbiddenRoots = [runtimeHome, env.DSH_HOME, env.COGNIA_DSH_SESSION_ROOT].filter(Boolean)
  // HOME is intentionally redirected by the managed launch. Credential
  // exclusions must still cover the OS user and repository-local stores.
  const credentialHomes = [
    ...new Set([userInfo().homedir, ctx.fs.processPath(workspace), env.HOME].filter(Boolean)),
  ]
  const deniedCredentials = credentialHomes.flatMap((home) => credentialRoots({ home, env }))
  const credentialSuffixes = CREDENTIAL_SUFFIXES.map((suffix) => `/${suffix.toLowerCase()}/`)

  function session(exec) {
    exec?.signal?.throwIfAborted()
    const value = exec?.agent?.session
    if (!value?.id || typeof value.header?.cwd !== "string" || !isAbsolute(value.header.cwd))
      throw new Error("Managed plugin tools require an authoritative session")
    return value
  }
  async function readPath(path, exec) {
    if (
      typeof path !== "string" ||
      !path.trim() ||
      path.includes("\0") ||
      /^[a-z][a-z0-9+.-]*:/i.test(path)
    )
      throw new Error("Managed plugin tools require a local workspace path")
    const current = session(exec)
    const cwd = await ctx.fs.resolve(current.header.cwd)
    if (!ctx.fs.contains(workspace, cwd))
      throw new Error("Managed plugin session escaped its workspace")
    const target = await ctx.fs.resolve(path, { cwd: current.header.cwd, signal: exec.signal })
    const processPath = ctx.fs.processPath(target)
    if (
      !ctx.fs.contains(workspace, target) ||
      forbiddenRoots.some((root) => inside(processPath, root))
    )
      throw new Error("Managed plugin path is outside the readable workspace")
    const components = `/${processPath.split(/[\\/]/).filter(Boolean).join("/").toLowerCase()}/`
    if (
      credentialSuffixes.some((suffix) => components.includes(suffix)) ||
      credentialHomes.some((home) => credentialPath(processPath, { home, env }).denied)
    )
      throw new Error("Managed plugin credential path refused")
    return processPath
  }

  // No upstream replacement, dynamic tool registration, PTC, mutation or shell
  // component is mounted. The published worker has no Linux ARM64 payload.
  if (["darwin-arm64", "darwin-x64", "linux-x64"].includes(`${process.platform}-${process.arch}`)) {
    for (const rawName of OPS_READERS) {
      const tool = definition(rawName, async (args, exec) => {
        const current = session(exec)
        if (
          !args ||
          typeof args !== "object" ||
          Array.isArray(args) ||
          Object.keys(args).some((key) => !Object.hasOwn(tool.parameters.properties, key))
        )
          throw new Error("Invalid managed ops argument")
        let selected
        if (rawName === "read_files") {
          if (!Array.isArray(args.files) || args.files.length < 1 || args.files.length > 32)
            throw new Error("Invalid managed ops file batch argument")
          selected = {
            ...args,
            files: await Promise.all(
              args.files.map(async (file) => {
                if (
                  !file ||
                  Object.keys(file).some((key) => !["path", "offset", "limit"].includes(key))
                )
                  throw new Error("Invalid managed ops file argument")
                return { ...file, path: await readPath(file.path, exec) }
              })
            ),
          }
        } else selected = { ...args, path: await readPath(args.path ?? ".", exec) }
        artifacts(runtimeHome)
        const target = `${process.platform}-${process.arch}`
        const worker = realpathSync(join(runtimeHome, "ops-worker"))
        const receiptPath = realpathSync(join(runtimeHome, "ops-worker.json"))
        if (
          worker !== join(runtimeHome, "ops-worker") ||
          receiptPath !== join(runtimeHome, "ops-worker.json")
        )
          throw new Error("Managed ops worker must remain in protected runtime code")
        const receipt = JSON.parse(readFileSync(receiptPath, "utf8"))
        if (
          receipt.version !== VERSIONS["dsh-ops"] ||
          receipt.target !== target ||
          receipt.sourceRevision !== OPS_SOURCE ||
          receipt.cogniaPatchVersion !== 1 ||
          receipt.sha256 !== createHash("sha256").update(readFileSync(worker)).digest("hex")
        )
          throw new Error("Managed dsh-ops worker provenance mismatch")
        // A trusted, data-only reader, like native ctx.fs. The host's OS
        // sandbox is inherited unchanged; macOS forbids nesting sandbox-exec.
        // This is not a general subprocess service or a failed-sandbox fallback.
        return runPlugin([worker], {
          cwd: ctx.fs.processPath(workspace),
          env: {},
          signal: exec.signal,
          input: JSON.stringify({
            version: 1,
            requestId: randomUUID(),
            component: "file",
            budget: { timeoutMs: TIMEOUT, maxBytes: LIMIT },
            request: {
              root: ctx.fs.processPath(workspace),
              scope: String(current.id),
              tool: rawName,
              args: selected,
              read_only: true,
              write_roots: [],
              deny_roots: [...deniedCredentials, ...forbiddenRoots],
              deny_credential_names: true,
            },
          }),
        })
      })
      ctx.tools.register(tool)
    }
  } else console.error("[cognia-dsh] dsh-ops is unavailable: no published worker for this platform")

  const modlensRoot = roots["@liustack/modlens"]
  ctx.tools.register({
    name: "modlens_read_image",
    description:
      "Read a local workspace image into structured OCR, layout and semantic evidence through the task's Cognia vision model. No URLs, external CLI logins or automatic provider fallback. Configure the ModLens vision model role when the primary model cannot read images.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, prompt: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    output: {
      schema: JSON.parse(
        readFileSync(protectedFile(modlensRoot, "dsh/vision-schema.json"), "utf8")
      ),
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      session(exec)
      if (
        !args ||
        Object.keys(args).some((key) => !["path", "prompt"].includes(key)) ||
        (args.prompt !== undefined && typeof args.prompt !== "string")
      )
        throw new Error("Invalid managed ModLens argument")
      const selected = await readPath(args.path, exec)
      const route = resolveVisionRoute(env)
      const bytes = await readManagedImage(selected, exec.signal)
      const home = await mkdtemp(join(env.DSH_HOME, "cognia-modlens-"))
      try {
        const image = join(home, "input.png")
        await writeFile(image, bytes, { mode: 0o600, flag: "wx" })
        const installed = artifacts(runtimeHome)
        const bridge = realpathSync(join(runtimeHome, "managed-plugins.mjs"))
        const response = await runPlugin(
          [
            process.execPath,
            "--permission",
            `--allow-fs-read=${installed.modules}`,
            `--allow-fs-read=${join(runtimeHome, "node_modules")}`,
            `--allow-fs-read=${join(runtimeHome, "package.json")}`,
            `--allow-fs-read=${bridge}`,
            `--allow-fs-read=${join(dirname(bridge), "launcher.mjs")}`,
            `--allow-fs-read=${home}`,
            `--allow-fs-write=${home}`,
            "--allow-net",
            bridge,
            "--input",
            image,
            "--model",
            route.model,
            "--prompt",
            args.prompt ?? "",
          ],
          {
            cwd: home,
            signal: exec.signal,
            timeout: TIMEOUT + 5000,
            env: {
              HOME: home,
              TMPDIR: home,
              OPENAI_BASE_URL: route.baseURL,
              OPENAI_API_KEY: route.token,
              COGNIA_DSH_PLUGIN_RUNTIME: runtimeHome,
              COGNIA_DSH_PLUGIN_STATE_ROOTS: JSON.stringify(
                [env.DSH_HOME, env.COGNIA_DSH_SESSION_ROOT, home].filter(Boolean)
              ),
            },
          }
        )
        if (!response?.result || typeof response.result.summary !== "string")
          throw new Error("Managed ModLens returned invalid evidence")
        return response.result
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    },
  })
}

// The fixed ModLens helper admits installed code only. Node permissions deny
// child processes, addons, workers and reads outside this call's staged image.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runtimeHome = process.env.COGNIA_DSH_PLUGIN_RUNTIME
  const installed = artifacts(runtimeHome)
  const cli = installed.protectedFile(installed.roots["@liustack/modlens"], "dist/main.js")
  const require = createRequire(cli)
  installManagedModulePolicy({
    runtimeHome,
    modules: installed.modules,
    stateRoots: JSON.parse(process.env.COGNIA_DSH_PLUGIN_STATE_ROOTS),
    launcherUrl: pathToFileURL(join(runtimeHome, "launcher.mjs")).href,
    modlensCliUrl: pathToFileURL(cli).href,
    undiciUrl: pathToFileURL(realpathSync(require.resolve("undici"))).href,
  })
  process.argv = [
    process.execPath,
    cli,
    "analyze",
    "--provider",
    "openai",
    "--timeout",
    String(TIMEOUT),
    ...process.argv.slice(2),
  ]
  await import(pathToFileURL(cli).href)
}
