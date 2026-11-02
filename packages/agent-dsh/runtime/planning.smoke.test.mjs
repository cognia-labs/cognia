/** Exact installed plugins, real pressure, durable history and both protocol projections. */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { createMockDeepSeek } from "./mock-deepseek.mjs"

const source = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const modules =
  process.env.COGNIA_DSH_TEST_MODULES ??
  dirname(dirname(dirname(require.resolve("@deepseek-ai/dsh/package.json"))))
const original =
  "PRUNER_HEAD\n" +
  "0123456789abcdef".repeat(12000) +
  "MIDDLE_ORIGINAL_ONLY" +
  "fedcba9876543210".repeat(12000) +
  "\nPRUNER_TAIL"
const todos = [
  { content: "Inspect", status: "in_progress" },
  { content: "Verify", status: "pending" },
]
const mcp = `import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{const f=JSON.parse(line);if(f.id===undefined)return;
const result=f.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'planning',version:'1'}}:
f.method==='tools/list'?{tools:[{name:'large',description:'Read a large fixture',inputSchema:{type:'object',properties:{}}}]}:
f.method==='tools/call'?{content:[{type:'text',text:${JSON.stringify(original)}}]}:{};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:f.id,result})+'\\n');});`

for (const profile of ["sdk-readonly", "sdk-workspace", "acp"]) {
  test(
    `${profile} prunes real model context while retaining original results and owned Todo`,
    { timeout: 60000 },
    async () => {
      const data = mkdtempSync(join(tmpdir(), "cognia-dsh-planning-"))
      const root = join(data, "deepseek-harness")
      const workspace = join(data, "workspace")
      mkdirSync(root)
      mkdirSync(workspace)
      let child
      let exit
      let calls = 0
      let stderr = ""
      let callbackError
      const frames = []
      const backend = await createMockDeepSeek({
        reply: (body) => {
          try {
            assert.equal(body.model, "planning-model", "No secondary summary/model authority")
            const index = ++calls
            assert.ok(body.tools.some((tool) => tool.function.name === "todo_write"))
            const call = (name, args) => ({
              tool_calls: [
                {
                  index: 0,
                  id: `planning-${index}`,
                  type: "function",
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            })
            if (index === 1) return call("todo_write", { todos })
            if (index === 2)
              return call("todo_write", {
                todos: todos.map((todo) => ({ ...todo, status: "in_progress" })),
              })
            if (index === 3) {
              assert.match(JSON.stringify(body.messages), /at most one task may be in_progress/)
              assert.ok(
                body.tools.some((tool) => tool.function.name === "mcp__cognia-tools__large"),
                "Fixture MCP tool must be mounted"
              )
              return call("mcp__cognia-tools__large", {})
            }
            if (index === 4) {
              const input = JSON.stringify(body.messages)
              if (!input.includes("tool result middle pruned"))
                assert.fail(
                  "Expected real pruning: " +
                    JSON.stringify(
                      body.messages.map((message) => {
                        const content = JSON.stringify(message.content)
                        return {
                          role: message.role,
                          chars: content.length,
                          start: content.slice(0, 180),
                        }
                      })
                    )
                )
              assert.match(input, /PRUNER_HEAD/)
              assert.match(input, /PRUNER_TAIL/)
              assert.ok(!input.includes("MIDDLE_ORIGINAL_ONLY"), "Only the model view is trimmed")
              return call("todo_write", {
                todos: todos.map((todo) => ({ ...todo, status: "completed" })),
              })
            }
            return { content: "Planning acceptance completed." }
          } catch (error) {
            callbackError = error
            throw error
          }
        },
      })
      try {
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
        const bridge = join(root, "planning-mcp.mjs")
        writeFileSync(bridge, mcp)
        const servers = [
          { name: "cognia-tools", command: process.execPath, args: [bridge], env: [] },
        ]
        child = spawn(
          process.execPath,
          [join(root, "launcher.mjs"), join(root, `host.${profile}.yml`)],
          {
            cwd: root,
            env: {
              PATH: process.env.PATH,
              HOME: root,
              DSH_HOME: join(root, "dsh-home"),
              COGNIA_DSH_RUNTIME_HOME: root,
              COGNIA_DSH_WORKSPACE: workspace,
              COGNIA_DSH_CONTEXT_WINDOW: "32768",
              COGNIA_DSH_PROVIDER: "cognia",
              COGNIA_DSH_MODEL: "planning-model",
              COGNIA_DSH_GATEWAY_TOKEN: "loopback-planning-lease",
              COGNIA_DSH_GATEWAY_CONFIG: JSON.stringify({
                providers: {
                  cognia: {
                    api: "openai-completions",
                    apiKeyEnv: "COGNIA_DSH_GATEWAY_TOKEN",
                    baseURL: backend.baseURL,
                    models: [
                      {
                        id: "planning-model",
                        name: "Planning",
                        contextWindow: 32768,
                        maxTokens: 4096,
                        input: ["text"],
                      },
                    ],
                  },
                },
              }),
              ...(profile === "acp" ? {} : { COGNIA_DSH_MCP_SERVERS: JSON.stringify(servers) }),
            },
            stdio: ["pipe", "pipe", "pipe"],
          }
        )
        child.stderr.on("data", (chunk) => {
          stderr += chunk
        })
        const replies = new Map()
        createInterface({ input: child.stdout }).on("line", (line) => {
          const frame = JSON.parse(line)
          frames.push(frame)
          if (frame.id !== undefined) replies.set(frame.id, frame)
        })
        exit = new Promise((resolve) =>
          child.once("exit", (code, signal) => resolve({ code, signal }))
        )
        let seq = 0
        async function request(method, params) {
          const id = ++seq
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
          const deadline = Date.now() + 20000
          while (!replies.has(id)) {
            if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline)
              throw new Error(`${method} did not settle: ${stderr}`)
            await new Promise((resolve) => setTimeout(resolve, 10))
          }
          const reply = replies.get(id)
          replies.delete(id)
          assert.equal(reply.error, undefined, JSON.stringify(reply))
          return reply.result
        }
        let sessionId = "planning-session"
        if (profile === "acp") {
          await request("initialize", {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: "planning", version: "1" },
          })
          sessionId = (await request("session/new", { cwd: workspace, mcpServers: servers }))
            .sessionId
        } else
          await request("initialize", {
            cwd: workspace,
            provider: "cognia",
            model: "planning-model",
          })
        const prompt = async (id) => {
          await request(
            "session/prompt",
            profile === "acp"
              ? { sessionId: id, prompt: [{ type: "text", text: "Run planning checks." }] }
              : { sessionId: id, contentBlocks: [{ type: "text", text: "Run planning checks." }] }
          )
          if (profile !== "acp") await request("session/wait", { sessionId: id })
        }
        await prompt(sessionId)
        assert.ifError(callbackError)
        assert.equal(calls, 5)
        if (profile === "acp") {
          const updates = frames
            .filter((frame) => frame.method === "session/update")
            .map((frame) => frame.params)
          const plans = updates.filter(
            (frame) => frame.sessionId === sessionId && frame.update.sessionUpdate === "plan"
          )
          assert.deepEqual(
            plans.map((frame) => frame.update.entries.map((todo) => todo.status)),
            [[], ["in_progress", "pending"], ["completed", "completed"]]
          )
          const completions = updates.filter(
            (frame) =>
              frame.update.sessionUpdate === "tool_call_update" &&
              frame.update.toolCallId === "planning-3"
          )
          assert.equal(completions.length, 1, "A model replacement is not another completion")
          assert.ok(JSON.stringify(completions[0]).includes("MIDDLE_ORIGINAL_ONLY"))
          const other = (await request("session/new", { cwd: workspace, mcpServers: servers }))
            .sessionId
          await prompt(other)
          assert.equal(
            frames
              .filter(
                (frame) =>
                  frame.params?.sessionId === other &&
                  frame.params?.update?.sessionUpdate === "plan"
              )
              .every((frame) => frame.params.update.entries.length === 0),
            true
          )
          await request("session/close", { sessionId })
          const before = frames.length
          await request("session/resume", { sessionId, cwd: workspace, mcpServers: servers })
          assert.ok(
            frames
              .slice(before)
              .some(
                (frame) =>
                  frame.params?.sessionId === sessionId &&
                  frame.params?.update?.sessionUpdate === "plan" &&
                  frame.params.update.entries.length === 2
              ),
            "Resume projects the current native Todo state"
          )
          const reset = frames.length
          await prompt(sessionId)
          assert.ok(
            frames
              .slice(reset)
              .some(
                (frame) =>
                  frame.params?.sessionId === sessionId &&
                  frame.params?.update?.sessionUpdate === "plan" &&
                  frame.params.update.entries.length === 0
              )
          )
        } else {
          const events = frames
            .filter((frame) => frame.method === "session.event")
            .map((frame) => frame.params.event)
          assert.equal(
            events.filter((event) => event.type === "todo/write").length,
            2,
            "Invalid Todo did not append state"
          )
          assert.ok(events.some((event) => event.type === "compaction/prune"))
          const outputs = events.filter(
            (event) =>
              event.type === "tool/result" && event.data.message.source.callId === "planning-3"
          )
          assert.equal(
            outputs.length,
            2,
            "SDK carries the original and one model-context replacement"
          )
          assert.ok(JSON.stringify(outputs[0]).includes("MIDDLE_ORIGINAL_ONLY"))
          assert.equal(outputs[0].surfaceOp?.op === "replace", false)
          assert.equal(outputs[1].surfaceOp.op, "replace")
          assert.ok(
            !JSON.stringify(outputs[1].data.message.content).includes("MIDDLE_ORIGINAL_ONLY")
          )
          await prompt(sessionId)
          await request("shutdown", {})
        }
        child.stdin.end()
        assert.deepEqual(await exit, { code: 0, signal: null }, stderr)
        const logs = readdirSync(join(root, "sessions"), { recursive: true })
          .filter((file) => file.endsWith(".jsonl"))
          .map((file) => readFileSync(join(root, "sessions", file), "utf8"))
          .join("\n")
        assert.ok(
          logs.includes("MIDDLE_ORIGINAL_ONLY"),
          "Full original persists after context replacement"
        )
        assert.ok(logs.includes("compaction/prune"))
        assert.ok(logs.includes("todo/write"))
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL")
          await exit
        }
        await backend.close()
        rmSync(data, { recursive: true, force: true })
      }
    }
  )
}
