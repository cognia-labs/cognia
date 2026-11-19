// Real Chromium and current bundled adapter; all servers bind loopback, no external traffic.
const assert = require("node:assert/strict")
const http = require("node:http")
const { createRequire } = require("node:module")
const rootRequire = createRequire(process.cwd() + "/package.json")
const { chromium } = rootRequire("@playwright/test")
const { build } = rootRequire("esbuild")

;(async () => {
  const result = await build({
    stdin: {
      contents: `import { generateLocalOpenAICompatibleTTS } from "./packages/tts/src/providers/local-openai-compatible.ts";
        import { setTtsHost } from "./packages/tts/src/host.ts";
        setTtsHost({});
        window.runProbe = (baseUrl) => generateLocalOpenAICompatibleTTS("AUDIT_SYNTHETIC_ONLY", { baseUrl, model: "synthetic", voice: "synthetic" });`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    logLevel: "silent",
  })
  const received = []
  let port
  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "content-type")
    if (req.method === "OPTIONS") {
      res.writeHead(204)
      res.end()
      return
    }
    if (req.url === "/") {
      res.setHeader("Content-Type", "text/html")
      res.end("<!doctype html><title>Local voice transport probe</title>")
      return
    }
    if (req.url === "/v1/audio/speech") {
      res.writeHead(307, { Location: `http://voice-sink.test:${port}/sink` })
      res.end()
      return
    }
    if (req.url === "/sink") {
      let body = ""
      for await (const part of req) body += part
      received.push({ host: req.headers.host, method: req.method, body })
      res.setHeader("Content-Type", "audio/mpeg")
      res.end(Buffer.from([1, 2, 3]))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = server.address().port
  let browser
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.VOICE_AUDIT_BROWSER || chromium.executablePath(),
      args: ["--no-proxy-server", "--host-resolver-rules=MAP voice-sink.test 127.0.0.1"],
    })
    const context = await browser.newContext()
    // Allow only the two test origins. Both resolve to the single loopback server.
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url())
      return ["127.0.0.1", "voice-sink.test"].includes(url.hostname) && url.port === String(port)
        ? route.continue()
        : route.abort()
    })
    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:${port}/`)
    await page.addScriptTag({ content: result.outputFiles[0].text })
    const output = await page.evaluate(
      (baseUrl) => window.runProbe(baseUrl),
      `http://127.0.0.1:${port}/v1`
    )
    assert.equal(output.success, true)
    assert.equal(received.length, 1)
    assert.equal(received[0].host, `voice-sink.test:${port}`)
    assert.equal(JSON.parse(received[0].body).input, "AUDIT_SYNTHETIC_ONLY")
    const strict = await page.evaluate(async (url) => {
      try {
        await fetch(url, {
          method: "POST",
          redirect: "error",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: "CONTROL" }),
        })
        return "followed"
      } catch {
        return "blocked"
      }
    }, `http://127.0.0.1:${port}/v1/audio/speech`)
    assert.equal(strict, "blocked")
    assert.equal(received.length, 1)
    console.log(
      JSON.stringify({
        probe: "browser-local-adapter-follows-off-loopback-hostname",
        chromium: browser.version(),
        success: output.success,
        sinkHost: "voice-sink.test",
        receivedSyntheticBody: JSON.parse(received[0].body).input,
        strictRedirectControl: strict,
        physicalNetwork: "loopback only; hostname mapped to 127.0.0.1",
      })
    )
  } finally {
    await browser?.close()
    await new Promise((resolve) => server.close(resolve))
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
