/** Audit-only reproduction: exact current managed workspace + loopback, then PTY isolation. */
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..")
const auditRoot = join(repositoryRoot, ".cache/dsh-support-20261114")
const { createMockDeepSeek } = await import(
  new URL("../../.cache/dsh-support-20261114/current-runtime/mock-deepseek.mjs", import.meta.url)
)
assert.equal(
  process.platform,
  "darwin",
  "This probe certifies only the audited macOS system Bash path"
)
const source = join(auditRoot, "current-runtime")
const outputPath = join(auditRoot, "bash-reconciled.json")
const probeWaitMs = 18000
const toolPath = join(source, "node_modules/@deepseek-ai/dsh-tool-bash-persistent/lib/index.js")
const toolSource = readFileSync(toolPath, "utf8")
const bundleSource = readFileSync(
  join(source, "node_modules/@deepseek-ai/dsh-sdk-minimal/cordis.patch.yml"),
  "utf8"
)
const toolVersion = JSON.parse(
  readFileSync(
    join(source, "node_modules/@deepseek-ai/dsh-tool-bash-persistent/package.json"),
    "utf8"
  )
).version
assert.equal(toolVersion, "0.2.1-rc.2")
assert.match(bundleSource, /id: persistent-bash[\s\S]*?timeoutMs: 300000/)
assert.match(toolSource, /text: "stty -echo"/)
const control = "echo '<doctype html>' > page.html; cat page.html; echo 'it'; echo hi"
const candidate = "echo '<!doctype html>' > page.html; cat page.html; echo 'it'; echo hi!!"
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function managedCase(label, command) {
  const temporary = mkdtempSync(join(auditRoot, "adversarial-composition-temporary-"))
  const root = join(temporary, "deepseek-harness")
  const workspace = join(temporary, "workspace")
  mkdirSync(root)
  mkdirSync(workspace)
  let child,
    stderr = "",
    requestError
  const frames = []
  const fixture = await createMockDeepSeek({
    reply: (_body, index) =>
      index === 1
        ? {
            tool_calls: [
              {
                index: 0,
                id: `bash-${label}`,
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({ command }),
                },
              },
            ],
          }
        : { content: "Shell probe complete." },
  })
  const startedAt = Date.now()
  try {
    symlinkSync(join(source, "node_modules"), join(root, "node_modules"), "dir")
    for (const file of [
      "launcher.mjs",
      "managed-plugins.mjs",
      "ops-worker",
      "ops-worker.json",
      "host.root.yml",
      "host.sdk-workspace.yml",
    ])
      copyFileSync(
        join(source, file.replace(/^ops-worker/, `ops-worker-${process.platform}-${process.arch}`)),
        join(root, file)
      )
    child = spawn(
      process.execPath,
      [join(root, "launcher.mjs"), join(root, "host.sdk-workspace.yml")],
      {
        cwd: workspace,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          DSH_HOME: join(root, "dsh-home"),
          COGNIA_DSH_RUNTIME_HOME: root,
          COGNIA_DSH_WORKSPACE: workspace,
          DEEPSEEK_API_KEY: "fixture-placeholder",
          DEEPSEEK_BASE_URL: fixture.baseURL,
        },
        stdio: ["pipe", "pipe", "pipe"],
      }
    )
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        frames.push(JSON.parse(line))
      } catch {
        /* Preserve only protocol frames. */
      }
    })
    async function request(id, method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
      const deadline = Date.now() + probeWaitMs
      while (!frames.some((frame) => frame.id === id)) {
        if (Date.now() > deadline)
          throw new Error(`Probe timed out ${method} after ${probeWaitMs}ms`)
        await sleep(20)
      }
      const frame = frames.find((frame) => frame.id === id)
      if (frame.error) throw new Error(JSON.stringify(frame.error))
      return frame.result
    }
    await request(1, "initialize", {
      cwd: workspace,
      provider: "deepseek-official",
      model: "deepseek-flash",
    })
    await request(2, "session/prompt", {
      sessionId: `bash-${label}`,
      contentBlocks: [{ type: "text", text: "Run the shell probe." }],
    })
    await request(3, "session/wait", { sessionId: `bash-${label}` })
    await request(4, "shutdown", {})
  } catch (error) {
    requestError = String(error)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve))
      child.kill("SIGKILL")
      await exited
    }
    await fixture.close()
  }
  const events = frames
    .filter((frame) => frame.method === "session.event")
    .map((frame) => frame.params.event)
  const result = {
    label,
    command,
    elapsedMs: Date.now() - startedAt,
    requestError,
    modelRequests: fixture.requests.length,
    advertisedBash: fixture.requests[0]?.tools?.some(
      (tool) => (tool.function?.name ?? tool.name) === "bash"
    ),
    fileExists: existsSync(join(workspace, "page.html")),
    fileText: existsSync(join(workspace, "page.html"))
      ? readFileSync(join(workspace, "page.html"), "utf8")
      : null,
    eventTypes: events.map((event) => event.type),
    toolCalls: events.filter((event) => event.type === "tool/call").map((event) => event.data),
    toolResults: events.filter((event) => event.type === "tool/result").map((event) => event.data),
    stderr,
  }
  rmSync(temporary, { recursive: true, force: true })
  return result
}

async function isolateHistory(disableHistory) {
  const require = createRequire(join(source, "package.json"))
  const pty = require("node-pty")
  // Use the exact installed wrapper functions; no substitute quoting implementation.
  const functions = toolSource.slice(
    toolSource.indexOf("function quoteForBash"),
    toolSource.indexOf("function trimTrailingNewline")
  )
  const wrapCommand = new Function(`${functions}; return wrapCommand`)()
  const temporary = mkdtempSync(join(auditRoot, "adversarial-composition-pty-"))
  const shell = pty.spawn("/bin/bash", ["--noprofile", "--norc", "-i"], {
    name: "xterm",
    cols: 160,
    rows: 24,
    cwd: temporary,
    env: { PATH: process.env.PATH, HOME: temporary, PS1: "dsh> ", HISTFILE: "/dev/null" },
  })
  let output = ""
  shell.onData((chunk) => {
    output += chunk
  })
  try {
    await sleep(250)
    shell.write(`stty -echo${disableHistory ? "; set +H" : ""}\r`)
    await sleep(250)
    shell.write(
      wrapCommand("echo '<!doctype html>'; echo 'it'; echo hi!!", { start: "START", end: "END" }) +
        "\r"
    )
    await sleep(500)
    shell.write("set -o | /usr/bin/grep histexpand\r")
    await sleep(250)
    return { disableHistory, output }
  } finally {
    shell.kill()
    rmSync(temporary, { recursive: true, force: true })
  }
}

const result = {
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  bashVersion: spawnSync("/bin/bash", ["--version"], { encoding: "utf8" }).stdout.split("\n")[0],
  toolVersion,
  profile: "cognia-sdk-workspace",
  runtimeToolTimeoutMs: 300000,
  probeWaitMs,
  timeoutScope:
    "18000ms is this audit probe's JSON-RPC response wait; runtime tool retains its unmodified 300000ms timeout.",
  hostOsSandboxWrapper: false,
  control: await managedCase("control", control),
  candidate: await managedCase("candidate", candidate),
  historyOn: await isolateHistory(false),
  historyOff: await isolateHistory(true),
}
writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n")
console.log(JSON.stringify(result, null, 2))
assert.equal(result.control.fileText, "<doctype html>\n")
assert.equal(result.control.requestError, undefined)
assert.equal(result.candidate.fileExists, false)
assert.match(result.candidate.requestError, /Probe timed out session\/wait/)
assert.ok(result.candidate.eventTypes.includes("tool/call"))
assert.ok(!result.candidate.eventTypes.includes("tool/result"))
assert.match(result.historyOn.output, /!doctype: event not found/)
assert.ok(!result.historyOn.output.includes("START\r\n"))
assert.match(result.historyOff.output, /START\r\n<!doctype html>\r\nit\r\nhi!!\r\nEND0/)
