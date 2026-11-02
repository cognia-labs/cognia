/** Run from an installed copy of this runtime; no model calls or real key. */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createMockDeepSeek } from "./mock-deepseek.mjs"
import { DSH_VERSION, managedProfileManifest, resolveProductLauncher } from "./launcher.mjs"

const source = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
// Dependencies must come from the exact managed package installation.
const modules =
  process.env.COGNIA_DSH_TEST_MODULES ??
  join(dirname(dirname(dirname(require.resolve("@deepseek-ai/dsh/package.json")))))

test("installed dependency closure contains only the managed DSH release", () => {
  const installedRequire = createRequire(join(modules, "..", "package.json"))
  assert.ok(resolveProductLauncher(installedRequire).endsWith("/lib/bin.js"))
  const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"))
  const lock = JSON.parse(readFileSync(join(modules, "..", "package-lock.json"), "utf8"))
  const installed = new Set()
  for (const [path, pkg] of Object.entries(lock.packages)) {
    const name = path.match(/(?:^|\/)node_modules\/(@deepseek-ai\/dsh(?:-[^/]+)?)$/)?.[1]
    if (!name) continue
    assert.equal(pkg.version, DSH_VERSION, path)
    assert.ok(manifest.overrides[name], name + " must be covered by release overrides")
    installed.add(name)
  }
  assert.deepEqual([...installed].sort(), Object.keys(manifest.overrides).sort())
})

for (const mutation of ["module", "configuration-race", "late-dotenv"])
  test(
    `profile-local ${mutation} cannot replace the certified SDK application`,
    { timeout: 30000 },
    async () => {
      const dataRoot = mkdtempSync(join(tmpdir(), "cognia-dsh-profile-shadow-"))
      const root = join(dataRoot, "deepseek-harness")
      mkdirSync(root)
      let child
      let stderr = ""
      let mutationObserved = false
      try {
        symlinkSync(modules, join(root, "node_modules"), "dir")
        for (const file of [
          "launcher.mjs",
          "managed-plugins.mjs",
          "ops-worker",
          "ops-worker.json",
          "host.root.yml",
          "host.sdk-readonly.yml",
        ])
          copyFileSync(
            join(
              source,
              file.replace(/^ops-worker/, `ops-worker-${process.platform}-${process.arch}`)
            ),
            join(root, file)
          )
        const profile = join(root, "dsh-home", "profiles", "cognia-sdk-readonly")
        const shadow = join(profile, "node_modules", "@deepseek-ai", "dsh-sdk-app")
        mkdirSync(shadow, { recursive: true })
        writeFileSync(
          join(profile, "package.json"),
          JSON.stringify(managedProfileManifest("cognia-sdk-readonly"))
        )
        writeFileSync(
          join(shadow, "package.json"),
          JSON.stringify({
            name: "@deepseek-ai/dsh-sdk-app",
            version: DSH_VERSION,
            type: "module",
            exports: "./index.js",
          })
        )
        writeFileSync(
          join(shadow, "index.js"),
          "throw new Error('COGNIA_UNTRUSTED_PROFILE_PLUGIN_EXECUTED');\n"
        )
        const bootstrap = join(root, "fixture-bootstrap.mjs")
        if (mutation !== "module")
          writeFileSync(
            bootstrap,
            `
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        import { main } from ${JSON.stringify(pathToFileURL(join(root, "launcher.mjs")).href)};
        const write = fs.writeFileSync;
        ${
          mutation === "configuration-race"
            ? `
        fs.writeFileSync = (file, ...args) => {
          const result = write(file, ...args);
          if (String(file).endsWith('/cordis.yml') && fs.realpathSync(file) === fs.realpathSync(${JSON.stringify(join(profile, "cordis.yml"))})) {
            write(file, '[ invalid profile configuration\\n');
            write(${JSON.stringify(join(profile, "cordis.patch.yml"))}, '[ invalid mutable patch\\n');
            process.stdout.write(JSON.stringify({ testMutation: true }) + '\\n');
          }
          return result;
        };
        `
            : `
        const realpath = fs.realpathSync;
        let mutated = false;
        fs.realpathSync = (file, ...args) => {
          const result = realpath(file, ...args);
          if (!mutated && String(file).endsWith('/host.root.yml')) {
            mutated = true;
            write(${JSON.stringify(join(root, "dsh-home", ".env"))}, 'COGNIA_DSH_MCP_SERVERS=invalid-untrusted-json\\n');
            process.stdout.write(JSON.stringify({ testMutation: true }) + '\\n');
          }
          return result;
        };
        fs.realpathSync.native = realpath.native;
        `
        }
        syncBuiltinESMExports();
        process.argv = [process.execPath, ${JSON.stringify(join(root, "launcher.mjs"))}, ${JSON.stringify(join(root, "host.sdk-readonly.yml"))}];
        await main();
      `
          )
        child = spawn(
          process.execPath,
          mutation !== "module"
            ? [bootstrap]
            : [join(root, "launcher.mjs"), join(root, "host.sdk-readonly.yml")],
          {
            cwd: root,
            env: {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              DSH_HOME: join(root, "dsh-home"),
              COGNIA_DSH_RUNTIME_HOME: root,
              COGNIA_DSH_WORKSPACE: root,
              DEEPSEEK_API_KEY: "fixture-not-a-credential",
              DEEPSEEK_BASE_URL: "http://127.0.0.1:1",
            },
            stdio: ["pipe", "pipe", "pipe"],
          }
        )
        child.stderr.on("data", (chunk) => {
          stderr += chunk
        })
        const initialized = new Promise((resolve, reject) => {
          const lines = createInterface({ input: child.stdout })
          lines.on("line", (line) => {
            let frame
            try {
              frame = JSON.parse(line)
            } catch {
              return
            }
            if (frame.testMutation === true) mutationObserved = true
            if (frame.id === 1) {
              if (frame.error) reject(new Error(JSON.stringify(frame.error)))
              else resolve(frame.result)
            }
          })
          child.once("error", reject)
          child.once("exit", (code, signal) =>
            reject(new Error(`DSH exited ${code}/${signal}: ${stderr}`))
          )
        })
        child.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { cwd: root, provider: "deepseek-official", model: "deepseek-flash" },
          }) + "\n"
        )
        const result = await initialized
        assert.ok(result.serverInfo)
        assert.doesNotMatch(stderr, /COGNIA_UNTRUSTED_PROFILE_PLUGIN_EXECUTED/)
        if (mutation !== "module") assert.equal(mutationObserved, true)
        assert.equal(readFileSync(join(root, "host.root.yml"), "utf8"), "[]\n")
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
          const exited = new Promise((resolve) => child.once("exit", resolve))
          child.kill("SIGKILL")
          await exited
        }
        rmSync(dataRoot, { recursive: true, force: true })
      }
    }
  )

for (const profile of ["sdk-readonly", "sdk-workspace", "acp"]) {
  test(
    `official product launcher initializes ${profile} and exits on disconnect`,
    { timeout: 30000 },
    async () => {
      const dataRoot = mkdtempSync(join(tmpdir(), "cognia-dsh-smoke-"))
      const root = join(dataRoot, "deepseek-harness")
      mkdirSync(root)
      let child
      let backend
      const requests = []
      try {
        backend = await createMockDeepSeek({
          reply: (input, index) => {
            requests.push(input)
            return (profile === "sdk-readonly" && index <= 2) ||
              (profile !== "sdk-readonly" && index === 1)
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: `write-${index}`,
                      type: "function",
                      function: {
                        name: "write",
                        arguments: JSON.stringify({
                          file_path: join(root, "must-not-exist.txt"),
                          content: "forbidden",
                          ...(profile === "acp"
                            ? {
                                sandbox_permissions: "danger-full-access",
                                justification: "Smoke permission must be rejected",
                              }
                            : index === 2
                              ? {
                                  sandbox_permissions: "workspace-write",
                                  justification: "Smoke escalation must fail",
                                }
                              : {}),
                        }),
                      },
                    },
                  ],
                }
              : { content: "Cognia smoke completed." }
          },
        })
        symlinkSync(modules, join(root, "node_modules"), "dir")
        for (const file of [
          "launcher.mjs",
          "managed-plugins.mjs",
          "ops-worker",
          "ops-worker.json",
          "host.root.yml",
          `host.${profile}.yml`,
        ])
          copyFileSync(
            join(
              source,
              file.replace(/^ops-worker/, `ops-worker-${process.platform}-${process.arch}`)
            ),
            join(root, file)
          )
        // This must never be read by the product CLI; launcher boots inside DSH_HOME.
        writeFileSync(join(root, ".env"), "DSH_HOME=/unmanaged-home\n")
        child = spawn(
          process.execPath,
          [join(root, "launcher.mjs"), join(root, `host.${profile}.yml`)],
          {
            cwd: root,
            env: {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              DSH_HOME: join(root, "dsh-home"),
              COGNIA_DSH_RUNTIME_HOME: root,
              COGNIA_DSH_WORKSPACE: root,
              DEEPSEEK_API_KEY: "cognia-smoke-placeholder",
              DEEPSEEK_BASE_URL: backend.baseURL,
              ...(profile === "acp"
                ? {
                    COGNIA_DSH_REASONING_EFFORT: "low",
                    COGNIA_DSH_MAX_TOKENS: "1234",
                  }
                : {}),
            },
            stdio: ["pipe", "pipe", "pipe"],
          }
        )
        let stderr = ""
        child.stderr.on("data", (chunk) => {
          stderr += chunk
        })
        const exited = new Promise((resolve) =>
          child.once("exit", (code, signal) => resolve({ code, signal }))
        )
        const lines = createInterface({ input: child.stdout })
        const frames = []
        const responses = new Map()
        const waiting = new Map()
        lines.on("line", (line) => {
          let frame
          try {
            frame = JSON.parse(line)
          } catch {
            assert.fail(`Non-protocol stdout: ${line}`)
          }
          frames.push(frame)
          if (frame.method === "session/request_permission") {
            child.stdin.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: frame.id,
                result: {
                  outcome: {
                    outcome: "selected",
                    optionId: frame.params.options.find((option) => option.kind === "reject_once")
                      .optionId,
                  },
                },
              }) + "\n"
            )
          }
          if (frame.id !== undefined) {
            responses.set(frame.id, frame)
            waiting.get(frame.id)?.(frame)
          }
        })
        async function request(id, method, params) {
          const reply = new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error(`No ${method} response: ${stderr}`)),
              20000
            )
            waiting.set(id, (value) => {
              clearTimeout(timer)
              resolve(value)
            })
            exited.then((status) => {
              clearTimeout(timer)
              reject(new Error(`Exited before ${method}: ${JSON.stringify(status)} ${stderr}`))
            })
          })
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
          return await reply
        }
        const params =
          profile === "acp"
            ? {
                protocolVersion: 1,
                clientCapabilities: {},
                clientInfo: { name: "cognia-smoke", version: "1" },
              }
            : {
                cwd: root,
                provider: "deepseek-official",
                model: "deepseek-flash",
              }
        const initialized = await request(1, "initialize", params)
        assert.equal(initialized.error, undefined, JSON.stringify(initialized))
        if (profile === "acp") {
          assert.equal(initialized.result.protocolVersion, 1)
          const session = await request(2, "session/new", { cwd: root, mcpServers: [] })
          assert.equal(session.error, undefined, JSON.stringify(session))
          assert.equal(typeof session.result.sessionId, "string")
          const prompt = await request(3, "session/prompt", {
            sessionId: session.result.sessionId,
            prompt: [{ type: "text", text: "Perform the smoke test." }],
          })
          assert.equal(prompt.error, undefined, JSON.stringify(prompt))
          assert.ok(
            frames.some((frame) => frame.method === "session/request_permission"),
            JSON.stringify(frames)
          )
          assert.equal(existsSync(join(root, "must-not-exist.txt")), false)
          assert.ok(JSON.stringify(frames).includes("Cognia smoke completed."))
          assert.equal(requests[0].max_tokens, 1234)
          assert.equal(requests[0].output_config.effort, "low")
        } else {
          assert.equal(initialized.result.serverInfo.name, "deepseek-harness-sdk-runtime")
          const stale = await request(2, "session.prompt", {})
          assert.ok(stale.error, "legacy dotted method must not be accepted")
          const changedDirectory = join(root, "working-directory")
          mkdirSync(changedDirectory)
          const changed = await request(7, "session/working-directory/set", {
            sessionId: "cognia-smoke",
            path: changedDirectory,
          })
          assert.equal(changed.error, undefined, JSON.stringify(changed))
          assert.equal(changed.result.cwd, realpathSync(changedDirectory))
          const invalidDirectory = await request(8, "session/working-directory/set", {
            sessionId: "cognia-smoke",
            path: join(root, "missing-directory"),
          })
          assert.ok(invalidDirectory.error, "a missing working directory must be rejected")
          const receipt = await request(3, "session/prompt", {
            sessionId: "cognia-smoke",
            contentBlocks: [
              { type: "text", text: "Perform the smoke test." },
              ...(profile === "sdk-workspace"
                ? [
                    {
                      type: "image",
                      mimeType: "image/png",
                      data: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADklEQVQImWP4DwYMEAoAU7oL9W/sIDEAAAAASUVORK5CYII=",
                    },
                  ]
                : []),
            ],
          })
          assert.equal(receipt.error, undefined, JSON.stringify(receipt))
          assert.equal(typeof receipt.result.messageId, "string")
          const waited = await request(4, "session/wait", { sessionId: "cognia-smoke" })
          assert.deepEqual(waited.result, {})
          assert.equal(waited.error, undefined, JSON.stringify(waited))
          const directory = await request(5, "session/working-directory/get", {
            sessionId: "cognia-smoke",
          })
          assert.equal(directory.result.cwd, changed.result.cwd)
          assert.ok(
            frames.some((frame) => frame.params?.event?.type === "working-directory/change"),
            "directory changes must be durable SDK events"
          )
          assert.ok(JSON.stringify(requests[0].messages).includes(changed.result.cwd))
          const deadline = Date.now() + 15000
          while (
            !frames.some(
              (frame) => frame.method === "session.status" && frame.params.status === "idle"
            )
          ) {
            if (Date.now() >= deadline)
              assert.fail(`No idle status: ${JSON.stringify(frames)} ${stderr}`)
            await new Promise((resolve) => setTimeout(resolve, 20))
          }
          assert.ok(frames.some((frame) => frame.method === "session.event"))
          assert.ok(JSON.stringify(frames).includes("Cognia smoke completed."))
          if (profile === "sdk-readonly") {
            assert.equal(requests.length, 3)
            assert.ok(
              JSON.stringify(requests[1].messages).includes("read-only"),
              JSON.stringify(requests[1].messages)
            )
            assert.ok(
              JSON.stringify(requests[2].messages).includes("approval"),
              JSON.stringify(requests[2].messages)
            )
            assert.equal(existsSync(join(root, "must-not-exist.txt")), false)
          }
          if (profile === "sdk-workspace") {
            assert.equal(readFileSync(join(root, "must-not-exist.txt"), "utf8"), "forbidden")
            assert.ok(
              JSON.stringify(requests[0].messages).includes("base64"),
              JSON.stringify(requests[0].messages)
            )
          }
          const shutdown = await request(6, "shutdown", {})
          assert.equal(shutdown.error, undefined)
        }
        const activePackages = new Set(
          requests[0].dsh_plugin_packages.packages.map((pkg) => pkg.name)
        )
        // Independently inspect real Loader composition rather than package.json:
        // installed dependencies alone cannot establish that a plugin is active.
        for (const name of [
          "dsh-fs-sandbox",
          "dsh-attachment-local",
          "dsh-tool-fs",
          "dsh-working-directory",
          "dsh-tool-working-directory",
          "dsh-session-projection",
          "dsh-token-meter",
          "dsh-compaction-tool-result-pruner",
          "dsh-tool-todo",
          "dsh-compaction-basic",
          "dsh-compaction-image-offload",
          "dsh-sandbox-policy",
          "dsh-session-persistence-jsonl",
          "dsh-llm-deepseek-api-key",
        ]) {
          assert.ok(activePackages.has(`@deepseek-ai/${name}`), `${profile}: missing ${name}`)
        }
        for (const name of [
          "dsh-subprocess-local",
          "dsh-terminal",
          // The disabled PowerShell row shares this package with active Bash.
          "dsh-terminal-bash",
          "dsh-tool-bash-persistent",
          "dsh-jobs-local",
        ]) {
          assert.equal(
            activePackages.has(`@deepseek-ai/${name}`),
            profile === "sdk-workspace",
            `${profile}: unexpected shell/job activation ${name}`
          )
        }
        for (const name of ["dsh-sdk-app", "dsh-sdk-jsonrpc-server"]) {
          assert.equal(
            activePackages.has(`@deepseek-ai/${name}`),
            profile !== "acp",
            `${profile}: ${name}`
          )
        }
        for (const name of ["dsh-acp-app", "dsh-acp", "dsh-user-approval"]) {
          assert.equal(
            activePackages.has(`@deepseek-ai/${name}`),
            profile === "acp",
            `${profile}: ${name}`
          )
        }
        for (const name of [
          "dsh-fs-local",
          "dsh-tool-pwsh-persistent",
          "dsh-llm-pi-ai",
          "dsh-mcp-client",
          "dsh-subagent",
          "dsh-subagent-fork-in-process",
          "dsh-subagent-spawn-in-process",
          "dsh-tool-subagent",
          "dsh-tool-subagent-control",
          "dsh-skill",
          "dsh-skill-filesystem",
          "dsh-tool-skill",
          "dsh-tool-fs-search",
          "dsh-web-search-deepseek",
          "dsh-goal",
          "dsh-goal-round-driver",
          "dsh-tool-goal",
          "dsh-ptc-runtime",
          "dsh-ptc-runtime-node",
          "dsh-workflow-ptc",
          "dsh-agent-instructions",
          "dsh-plugin-manager",
          "dsh-client-ui-plugin-manager",
        ]) {
          assert.equal(
            activePackages.has(`@deepseek-ai/${name}`),
            false,
            `${profile}: unexpectedly active ${name}`
          )
        }
        child.stdin.end()
        const status = await exited
        assert.equal(status.code, 0, stderr)
        assert.equal(status.signal, null)
        const ownershipDirectory = join(dataRoot, ".deepseek-harness-control", "processes")
        const ownershipFiles = readdirSync(ownershipDirectory)
        assert.equal(ownershipFiles.length, 1, "normal exit cannot prove descendant retirement")
        const ownership = JSON.parse(
          readFileSync(join(ownershipDirectory, ownershipFiles[0]), "utf8")
        )
        assert.equal(ownership.schemaVersion, 2)
        assert.equal(ownership.retirementRequired, true)
        assert.equal(ownership.retired, false)
        assert.equal(readFileSync(join(root, "host.root.yml"), "utf8"), "[]\n")
        const sessionRoot = join(root, "sessions")
        const logs = readdirSync(sessionRoot, { recursive: true }).filter((path) =>
          path.endsWith(".jsonl")
        )
        assert.ok(logs.length > 0, "session persistence must produce a durable log")
        const header = JSON.parse(readFileSync(join(sessionRoot, logs[0]), "utf8").split("\n")[0])
        assert.equal(header.version, 4)
      } finally {
        child?.kill("SIGKILL")
        await backend?.close()
        rmSync(dataRoot, { recursive: true, force: true })
      }
    }
  )
}
