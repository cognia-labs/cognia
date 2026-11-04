import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
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
const mcpFixture = `import {createInterface} from 'node:readline'; import {appendFileSync} from 'node:fs';
createInterface({input:process.stdin}).on('line',line=>{
 const frame=JSON.parse(line);if(frame.id===undefined)return;
 let result;
 if(frame.method==='initialize') result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'cognia-test-broker',version:'1'}};
 else if(frame.method==='tools/list') result={tools:[{name:'inspect',description:'Inspect a file through the Cognia broker',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path']}}]};
 else if(frame.method==='tools/call') {const denied=frame.params.arguments.path==='forbidden';appendFileSync(process.env.CALL_LOG,JSON.stringify({name:frame.params.name,denied})+'\\n');result={content:[{type:'text',text:denied?'Cognia policy denied requested path':'Cognia broker inspection complete'}],isError:denied};}
 else result={};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:frame.id,result})+'\\n');
});`

for (const channel of ["sdk", "sdk-workspace", "acp"]) {
  test(
    `${channel} uses Cognia gateway and MCP tools with denied-call propagation`,
    { timeout: 30000 },
    async () => {
      const dataRoot = mkdtempSync(join(tmpdir(), "cognia-services-smoke-"))
      const root = join(dataRoot, "deepseek-harness")
      mkdirSync(root)
      const workspace = join(dataRoot, "workspace")
      mkdirSync(workspace)
      writeFileSync(join(workspace, "sample.txt"), "Managed ops worker reached Cognia.\n")
      writeFileSync(
        join(workspace, "image.png"),
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
          "base64"
        )
      )
      let child
      let turns = 0
      const fixture = await createMockDeepSeek({
        reply: (body) => {
          if (body.model === "cognia-vision") {
            assert.equal(body.stream, false)
            assert.match(JSON.stringify(body.messages), /data:image\/png;base64/)
            return {
              content: JSON.stringify({
                summary: "Managed ModLens evidence",
                ocr: { full_text: "Cognia", lines: [] },
                layout: { regions: [] },
                semantics: { scene: "test", entities: [] },
                visual: {},
                uncertainty: [],
              }),
            }
          }
          assert.equal(body.model, "cognia-proxy")
          const index = ++turns
          for (const name of [
            "ops_inspect_local_file",
            "ops_read_files",
            "ops_read_pdf",
            "modlens_read_image",
          ])
            assert.ok(
              body.tools.some((tool) => tool.function.name === name),
              name
            )
          for (const name of [
            "ops_bash",
            "ops_write_file",
            "ops_replace",
            "ops_discover_tools",
            "ops_ptc",
          ])
            assert.ok(!body.tools.some((tool) => tool.function.name === name), name)
          if (index <= 2)
            return {
              tool_calls: [
                {
                  index: 0,
                  id: `plugin-${index}`,
                  type: "function",
                  function: {
                    name: index === 1 ? "ops_inspect_local_file" : "modlens_read_image",
                    arguments: JSON.stringify({ path: index === 1 ? "sample.txt" : "image.png" }),
                  },
                },
              ],
            }
          const tool = body.tools.find(
            (tool) => tool.function.name === "mcp__cognia-tools__inspect"
          )
          assert.ok(tool, "Cognia tools must exist before the first request")
          return index <= 4
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: `tool-${index}`,
                    type: "function",
                    function: {
                      name: tool.function.name,
                      arguments: JSON.stringify({ path: index === 3 ? "allowed" : "forbidden" }),
                    },
                  },
                ],
              }
            : { content: "Cognia gateway and tools completed." }
        },
      })
      try {
        symlinkSync(modules, join(root, "node_modules"), "dir")
        const composition =
          channel === "acp"
            ? "host.acp.yml"
            : channel === "sdk-workspace"
              ? "host.sdk-workspace.yml"
              : "host.sdk-readonly.yml"
        for (const file of [
          "launcher.mjs",
          "managed-plugins.mjs",
          "ops-worker",
          "ops-worker.json",
          "host.root.yml",
          composition,
        ])
          copyFileSync(
            join(
              source,
              file.replace(/^ops-worker/, `ops-worker-${process.platform}-${process.arch}`)
            ),
            join(root, file)
          )
        const bridge = join(root, "mcp-fixture.mjs")
        writeFileSync(bridge, mcpFixture)
        const callLog = join(root, "calls.jsonl")
        const servers = [
          {
            name: "cognia-tools",
            command: process.execPath,
            args: [bridge],
            env: [{ name: "CALL_LOG", value: callLog }],
          },
        ]
        child = spawn(process.execPath, [join(root, "launcher.mjs"), join(root, composition)], {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            DSH_HOME: join(root, "dsh-home"),
            COGNIA_DSH_RUNTIME_HOME: root,
            COGNIA_DSH_WORKSPACE: workspace,
            COGNIA_DSH_PROVIDER: "cognia",
            COGNIA_DSH_MODEL: "cognia-proxy",
            COGNIA_DSH_GATEWAY_TOKEN: "fixture-gateway-lease",
            COGNIA_DSH_GATEWAY_CONFIG: JSON.stringify({
              visionModel: "cognia-vision",
              providers: {
                cognia: {
                  api: "openai-completions",
                  baseURL: fixture.baseURL,
                  apiKeyEnv: "COGNIA_DSH_GATEWAY_TOKEN",
                  models: [
                    {
                      id: "cognia-proxy",
                      name: "Cognia proxy",
                      contextWindow: 32768,
                      maxTokens: 4096,
                      input: ["text"],
                    },
                    {
                      id: "cognia-vision",
                      name: "Cognia vision",
                      contextWindow: 32768,
                      maxTokens: 4096,
                      input: ["text", "image"],
                    },
                  ],
                },
              },
            }),
            ...(channel !== "acp" ? { COGNIA_DSH_MCP_SERVERS: JSON.stringify(servers) } : {}),
          },
        })
        let stderr = ""
        child.stderr.on("data", (chunk) => (stderr += chunk))
        const frames = []
        createInterface({ input: child.stdout }).on("line", (line) => frames.push(JSON.parse(line)))
        const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)))
        async function until(predicate, label) {
          const deadline = Date.now() + 15000
          while (!predicate()) {
            if (Date.now() > deadline)
              throw new Error(`Timed out ${label}: ${stderr} ${JSON.stringify(frames)}`)
            await new Promise((resolve) => setTimeout(resolve, 10))
          }
        }
        async function request(id, method, params) {
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
          await until(() => frames.some((frame) => frame.id === id), method)
          const frame = frames.find((frame) => frame.id === id)
          assert.equal(frame.error, undefined, JSON.stringify(frame))
          return frame.result
        }
        if (channel !== "acp") {
          await request(1, "initialize", {
            cwd: workspace,
            provider: "cognia",
            model: "cognia-proxy",
          })
          await request(2, "session/prompt", {
            sessionId: "cognia-services",
            contentBlocks: [{ type: "text", text: "Use the Cognia tool for both paths." }],
          })
          await request(3, "session/wait", { sessionId: "cognia-services" })
          await until(
            () =>
              frames.some(
                (frame) => frame.method === "session.status" && frame.params.status === "idle"
              ),
            "idle"
          )
          await request(4, "shutdown", {})
        } else {
          await request(1, "initialize", {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: "cognia-smoke", version: "1" },
          })
          const session = await request(2, "session/new", { cwd: workspace, mcpServers: servers })
          await request(3, "session/prompt", {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "Use the Cognia tool for both paths." }],
          })
        }
        assert.ok(JSON.stringify(frames).includes("Cognia gateway and tools completed."))
        assert.deepEqual(
          readFileSync(callLog, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
          [
            { name: "inspect", denied: false },
            { name: "inspect", denied: true },
          ]
        )
        const messages = JSON.stringify(fixture.requests.map((request) => request.messages))
        assert.ok(messages.includes("Cognia policy denied"))
        assert.ok(messages.includes("Managed ops worker reached Cognia."), messages)
        assert.ok(messages.includes("Managed ModLens evidence"), messages)
        assert.equal(
          fixture.requests.filter((request) => request.model === "cognia-vision").length,
          1
        )
        assert.equal(
          frames.some((frame) => frame.method === "session/request_permission"),
          false,
          "Cognia broker owns MCP approval"
        )
        child.stdin.end()
        assert.equal(await exited, 0, stderr)
      } finally {
        child?.kill("SIGKILL")
        await fixture.close()
        rmSync(dataRoot, { recursive: true, force: true })
      }
    }
  )
}
