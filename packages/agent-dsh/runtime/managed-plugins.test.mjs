import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { createServer } from "node:http"
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { test } from "node:test"
import {
  mountManagedPlugins,
  OPS_READERS,
  readManagedImage,
  resolveVisionRoute,
  runPlugin,
} from "./managed-plugins.mjs"

const modules =
  process.env.COGNIA_DSH_TEST_MODULES ??
  dirname(dirname(dirname(createRequire(import.meta.url).resolve("@deepseek-ai/dsh/package.json"))))

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cognia-managed-plugins-")))
  const runtimeHome = join(root, "runtime")
  const workspace = join(root, "workspace")
  mkdirSync(runtimeHome)
  mkdirSync(workspace)
  symlinkSync(modules, join(runtimeHome, "node_modules"), "dir")
  writeFileSync(join(runtimeHome, "package.json"), '{"type":"module"}')
  for (const file of ["managed-plugins.mjs", "launcher.mjs", "ops-worker", "ops-worker.json"])
    copyFileSync(
      new URL(
        `./${file.replace(/^ops-worker/, `ops-worker-${process.platform}-${process.arch}`)}`,
        import.meta.url
      ),
      join(runtimeHome, file)
    )
  const tools = new Map()
  const ctx = {
    tools: {
      register: (tool) => {
        tools.set(tool.name, tool)
      },
    },
    fs: {
      resolve: async (path, { cwd = process.cwd() } = {}) => realpathSync(resolve(cwd, path)),
      contains: (parent, path) => {
        const rel = relative(parent, path)
        return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"))
      },
      processPath: (target) => target,
    },
  }
  const env = {
    COGNIA_DSH_RUNTIME_HOME: runtimeHome,
    COGNIA_DSH_WORKSPACE: workspace,
    DSH_HOME: join(runtimeHome, "dsh-home"),
    COGNIA_DSH_SESSION_ROOT: join(runtimeHome, "sessions"),
  }
  mkdirSync(env.DSH_HOME)
  const exec = {
    signal: new AbortController().signal,
    agent: { session: { id: "test-session", header: { cwd: workspace } } },
  }
  return {
    root,
    workspace,
    tools,
    ctx,
    env,
    exec,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

test("managed ops runs the pinned worker, with no mutations, storage or shell", async () => {
  const f = fixture()
  try {
    writeFileSync(join(f.workspace, "sample.txt"), "Cognia worker evidence\n")
    await mountManagedPlugins(f.ctx, f.env)
    assert.deepEqual(
      [...f.tools.keys()],
      [...OPS_READERS.map((name) => `ops_${name}`), "modlens_read_image"]
    )
    const result = await f.tools
      .get("ops_inspect_local_file")
      .execute({ path: "sample.txt" }, f.exec)
    assert.equal(result.status, "completed", JSON.stringify(result))
    assert.match(JSON.stringify(result), /Cognia worker evidence/)
    const table = join(f.workspace, "table.csv")
    writeFileSync(table, "name,value\nCognia,42\n")
    assert.match(
      JSON.stringify(await f.tools.get("ops_read_table").execute({ path: table }, f.exec)),
      /Cognia/
    )
    writeFileSync(
      join(f.workspace, "sample.docx"),
      Buffer.from(
        "UEsDBBQAAAAIALAFYl33S4B1wgAAAHYBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2QuQ7CMAyGX6XKiqgRAwOiLMAKDLyAlbptRC7FLsfbk3INCBjt//gsLw7XSFxcnPVcqU4kzgFYd+SQyxDJZ6UJyaHkMbUQUR+xJZhOJjPQwQt5GcvQoZaLNTXYWyk2l7xmE3ylEllWxephHFiVwhit0ShZh5OvPyjjJ6HMybuHOxN5lA0KvhIG5TfgmdudKCVTU7HHJFt02QXnkGqog+5dTpb/a77cGZrGaHrnh7aYgiZm41tny7fi0PjX/XB/9/IGUEsDBBQAAAAIALAFYl1hey9DiQAAAPIAAAALAAAAX3JlbHMvLnJlbHONzzsOAiEQBuCrEA6ws1pYGKCy2dZ4AQLDIy6PDBj19lJYrMbCcuaffH9GnHHVPZbcQqyNPdKam+Sh93oEaCZg0m0qFfNIXKGk+xjJQ9Xmqj3Cfp4PQFuDK7E12WIlp8XuOLs8K/5jF+eiwVMxt4S5/6j4uhiyJo9d8nshC/a9ngbLQQn4eFG9AFBLAwQUAAAACACwBWJduyEoPH0AAACoAAAAEQAAAHdvcmQvZG9jdW1lbnQueG1sRc5BDgIhDAXQq5A5gJ24cEGQjSdBqAzJ0JKCorcXxoWb99P8/KSm68D+mZGaeuedqu7XZWutaIDqN8yunrggje7Bkl0bp0ToLKEIe6w1Ucw7nNf1AtklWqzp+s7hM7NMZNLsjSMlp3qSsVD4SgHJo4HZTeWwHP728P/NfgFQSwECFAMUAAAACACwBWJd90uAdcIAAAB2AQAAEwAAAAAAAAAAAAAAgAEAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAxQAAAAIALAFYl1hey9DiQAAAPIAAAALAAAAAAAAAAAAAACAAfMAAABfcmVscy8ucmVsc1BLAQIUAxQAAAAIALAFYl27ISg8fQAAAKgAAAARAAAAAAAAAAAAAACAAaUBAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAAAwADALkAAABRAgAAAAA=",
        "base64"
      )
    )
    writeFileSync(
      join(f.workspace, "sample.pdf"),
      Buffer.from(
        "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgMzAwXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggNTQgPj4Kc3RyZWFtCkJUIC9GMSAxMiBUZiAyMCAyMDAgVGQgKENvZ25pYSB3aXJpbmcgZXZpZGVuY2UpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzMTEgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0MTQKJSVFT0YK",
        "base64"
      )
    )
    for (const [name, args] of [
      ["read_files", { files: [{ path: "sample.txt" }] }],
      ["glob", { pattern: ["**/*.txt"] }],
      ["grep", { pattern: "Cognia" }],
      ["stat", { path: "sample.txt" }],
      ["diff", { path: "sample.txt", content: "Other text" }],
      ["read_docx", { path: "sample.docx" }],
      ["read_pdf", { path: "sample.pdf" }],
    ]) {
      const value = await f.tools.get(`ops_${name}`).execute(args, f.exec)
      assert.equal(value.status, "completed", `${name}: ${JSON.stringify(value)}`)
      if (name === "read_docx" || name === "read_pdf")
        assert.match(JSON.stringify(value), /Cognia wiring evidence/)
    }
    assert.equal(readFileSync(join(f.workspace, "sample.txt"), "utf8"), "Cognia worker evidence\n")
    await assert.rejects(
      f.tools.get("ops_stat").execute({ path: "sample.txt", read_only: false }, f.exec),
      /argument/
    )
    await assert.rejects(
      f.tools.get("ops_stat").execute({ path: "sample.txt" }, { signal: f.exec.signal }),
      /session/
    )
  } finally {
    f.cleanup()
  }
})

test("the built native worker itself refuses mutation, unknown tools and outside paths", async () => {
  const f = fixture()
  try {
    for (const [tool, read_only, args, code] of [
      [
        "write_file",
        false,
        { path: join(f.workspace, "never.txt"), content: "blocked" },
        "POLICY_DENIED",
      ],
      ["bash", true, { command: "touch never.txt" }, "POLICY_DENIED"],
      ["stat", true, { path: join(f.root, "outside.txt") }, "PATH_RESTRICTED"],
    ]) {
      const value = await runPlugin([join(f.env.COGNIA_DSH_RUNTIME_HOME, "ops-worker")], {
        cwd: f.workspace,
        env: {},
        input: JSON.stringify({
          version: 1,
          requestId: "native-boundary",
          component: "file",
          budget: { timeoutMs: 30000, maxBytes: 131072 },
          request: { root: f.workspace, scope: "test", tool, args, read_only },
        }),
      })
      assert.equal(value.error.code, code, JSON.stringify(value))
    }
    assert.throws(() => readFileSync(join(f.workspace, "never.txt")), /ENOENT/)
  } finally {
    f.cleanup()
  }
})

test("plugin readers refuse outside roots, credentials and symlinks before execution", async () => {
  const f = fixture()
  try {
    writeFileSync(join(f.root, "private.png"), "private sentinel")
    writeFileSync(join(f.workspace, ".env"), "credential sentinel")
    writeFileSync(join(f.workspace, ".npmrc"), "credential sentinel")
    mkdirSync(join(f.workspace, ".aws"))
    writeFileSync(join(f.workspace, ".aws", "credentials"), "credential sentinel")
    mkdirSync(join(f.workspace, "nested"))
    writeFileSync(join(f.workspace, "nested", ".npmrc"), "credential sentinel")
    mkdirSync(join(f.workspace, "nested", ".docker"))
    writeFileSync(join(f.workspace, "nested", ".docker", "config.json"), "credential sentinel")
    mkdirSync(join(f.workspace, "nested", ".config", "gcloud"), { recursive: true })
    writeFileSync(
      join(f.workspace, "nested", ".config", "gcloud", "access_tokens.db"),
      "credential sentinel"
    )
    writeFileSync(
      join(f.workspace, "nested", ".config", "gcloud", "private.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        "base64"
      )
    )
    symlinkSync(join(f.root, "private.png"), join(f.workspace, "escape.png"))
    await mountManagedPlugins(f.ctx, f.env)
    for (const path of [
      "../private.png",
      "escape.png",
      ".env",
      ".npmrc",
      "nested/.npmrc",
      "nested/.docker/config.json",
      "nested/.config/gcloud/access_tokens.db",
      "nested/.config/gcloud/private.png",
      ".aws/credentials",
      "https://example.com/a.png",
    ]) {
      for (const name of ["ops_stat", "modlens_read_image"])
        await assert.rejects(
          f.tools.get(name).execute({ path }, f.exec),
          ["../private.png", "escape.png", "https://example.com/a.png"].includes(path)
            ? /path|workspace|local/i
            : /credential/i
        )
    }
    const grep = await f.tools
      .get("ops_grep")
      .execute({ path: "nested", pattern: "credential" }, f.exec)
    assert.ok(!JSON.stringify(grep).includes("credential sentinel"), JSON.stringify(grep))
    const glob = await f.tools
      .get("ops_glob")
      .execute({ path: "nested", pattern: ["**/*", "**/.*"] }, f.exec)
    assert.ok(!JSON.stringify(glob).includes(".npmrc"), JSON.stringify(glob))
    assert.ok(!JSON.stringify(glob).includes("access_tokens"), JSON.stringify(glob))
  } finally {
    f.cleanup()
  }
})

test("image descriptor refuses ancestor links and reads remain bounded", async () => {
  const f = fixture()
  try {
    mkdirSync(join(f.workspace, "nested"))
    writeFileSync(join(f.workspace, "nested", "image.png"), "safe")
    assert.equal(
      (await readManagedImage(join(f.workspace, "nested", "image.png"), undefined, 4)).toString(),
      "safe"
    )
    await assert.rejects(
      readManagedImage(join(f.workspace, "nested", "image.png"), undefined, 3),
      /bounded/
    )
    symlinkSync(join(f.workspace, "nested"), join(f.workspace, "alias"))
    await assert.rejects(readManagedImage(join(f.workspace, "alias", "image.png")), /ELOOP|ENOTDIR/)
  } finally {
    f.cleanup()
  }
})

test("ModLens requires an explicitly frozen image-capable Cognia route", () => {
  assert.throws(() => resolveVisionRoute({}), /vision/)
  const env = {
    COGNIA_DSH_PROVIDER: "cognia",
    COGNIA_DSH_GATEWAY_TOKEN: "lease",
    COGNIA_DSH_MODEL: "text",
    COGNIA_DSH_GATEWAY_CONFIG: JSON.stringify({
      visionModel: "vision",
      providers: {
        cognia: {
          api: "openai-completions",
          apiKeyEnv: "COGNIA_DSH_GATEWAY_TOKEN",
          baseURL: "http://127.0.0.1:9000/v1",
          models: [
            { id: "text", input: ["text"] },
            { id: "vision", input: ["text", "image"] },
          ],
        },
      },
    }),
  }
  assert.equal(resolveVisionRoute(env).model, "vision")
  assert.throws(
    () =>
      resolveVisionRoute({
        ...env,
        COGNIA_DSH_GATEWAY_CONFIG: env.COGNIA_DSH_GATEWAY_CONFIG.replace(
          '"text","image"',
          '"text"'
        ),
      }),
    /vision/
  )
})

test(
  "actual ModLens CLI uses only the managed vision route and propagates gateway denial/cancellation",
  { timeout: 15000 },
  async () => {
    const f = fixture()
    const evidence = {
      summary: "Managed vision evidence",
      ocr: { full_text: "Cognia", lines: [] },
      layout: { regions: [] },
      semantics: { scene: "test", entities: [] },
      visual: {},
      uncertainty: [],
    }
    const requests = []
    let denied = false
    let hold = false
    let redirect = false
    let sinkCalls = 0
    const sink = createServer((_req, res) => {
      sinkCalls++
      res.writeHead(200, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(evidence) }, finish_reason: "stop" }],
        })
      )
    })
    await new Promise((resolve) => sink.listen(0, "127.0.0.1", resolve))
    const server = createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks))
      requests.push({ body, authorization: req.headers.authorization })
      if (redirect) {
        res.writeHead(307, { location: `http://127.0.0.1:${sink.address().port}/unapproved` })
        res.end()
        return
      }
      if (hold) return
      res.writeHead(denied ? 403 : 200, { "content-type": "application/json" })
      res.end(
        JSON.stringify(
          denied
            ? { error: { message: "PII policy denied" } }
            : {
                choices: [
                  { message: { content: JSON.stringify(evidence) }, finish_reason: "stop" },
                ],
                usage: {},
              }
        )
      )
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      writeFileSync(
        join(f.workspace, "image.png"),
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
          "base64"
        )
      )
      f.env.COGNIA_DSH_PROVIDER = "cognia"
      f.env.COGNIA_DSH_GATEWAY_TOKEN = "call-scoped-lease"
      f.env.COGNIA_DSH_GATEWAY_CONFIG = JSON.stringify({
        visionModel: "approved-vision",
        providers: {
          cognia: {
            api: "openai-completions",
            apiKeyEnv: "COGNIA_DSH_GATEWAY_TOKEN",
            baseURL: `http://127.0.0.1:${server.address().port}/v1`,
            models: [{ id: "approved-vision", input: ["text", "image"] }],
          },
        },
      })
      Object.assign(f.env, {
        NODE_OPTIONS: "--import=/unmanaged/inject.mjs",
        MODLENS_DSH_CLI: "/unmanaged/cli.mjs",
        OPENAI_API_KEY: "ambient-key",
        DSH_OPS_WORKER_BIN: "/unmanaged/worker",
      })
      await mountManagedPlugins(f.ctx, f.env)
      const tool = f.tools.get("modlens_read_image")
      const result = await tool.execute({ path: "image.png", prompt: "read the title" }, f.exec)
      assert.deepEqual(result, evidence)
      assert.equal(requests[0].authorization, "Bearer call-scoped-lease")
      assert.equal(requests[0].body.model, "approved-vision")
      assert.match(JSON.stringify(requests[0].body), /data:image\/png;base64/)
      assert.match(JSON.stringify(requests[0].body), /read the title/)
      assert.ok(!JSON.stringify(result).includes("attempts"))
      denied = true
      await assert.rejects(
        tool.execute({ path: "image.png" }, f.exec),
        /no alternate executor or provider/
      )
      assert.equal(requests.length, 2, "gateway refusal must not fall back")
      denied = false
      redirect = true
      await assert.rejects(
        tool.execute({ path: "image.png" }, f.exec),
        /no alternate executor or provider/
      )
      assert.equal(sinkCalls, 0, "redirects must not forward the image to a second target")
      assert.equal(requests.length, 3)
      redirect = false
      hold = true
      const controller = new AbortController()
      const pending = tool.execute({ path: "image.png" }, { ...f.exec, signal: controller.signal })
      while (requests.length < 4) await new Promise((resolve) => setTimeout(resolve, 5))
      controller.abort(new Error("cancelled vision fixture"))
      await assert.rejects(pending, /cancelled vision fixture/)
      assert.equal(requests.length, 4)
      hold = false
      const privateImage = join(f.root, "private.png")
      writeFileSync(privateImage, readFileSync(join(f.workspace, "image.png")))
      f.ctx.fs.processPath = (target) => {
        if (target === join(f.workspace, "image.png")) {
          rmSync(target)
          symlinkSync(privateImage, target)
        }
        return target
      }
      await assert.rejects(tool.execute({ path: "image.png" }, f.exec), /ELOOP|path|symlink/)
      assert.equal(requests.length, 4, "a late symlink swap must not upload any image")
    } finally {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      sink.closeAllConnections()
      await new Promise((resolve) => sink.close(resolve))
      f.cleanup()
    }
  }
)
