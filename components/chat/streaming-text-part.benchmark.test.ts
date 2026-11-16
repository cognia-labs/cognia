/**
 * @jest-environment node
 */
// Streaming Markdown benchmark (chat-surface overhaul, step 2). Jest mocks
// Streamdown, so the real renderers are bundled with esbuild and run in a
// separate Node process, the same way `markdown-renderer.heavy.test.ts` does.
// Skipped unless CHAT_BENCHMARK=1; run with `pnpm benchmark:chat`.
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const benchmarkEnabled = process.env.CHAT_BENCHMARK === "1"
const benchmarkDescribe = benchmarkEnabled ? describe : describe.skip

interface StreamingResult {
  deltas: number
  totalMs: number
  p50: number
  p95: number
  p50ByQuarter: number[]
  streamingDomBytes: number
}

benchmarkDescribe("streaming Markdown cost", () => {
  it("reports per-delta streaming cost, DOM size and finished render time", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "cognia-streaming-benchmark-"))
    const bundle = path.join(tempDir, "benchmark.cjs")
    let output = ""
    try {
      execFileSync(
        require.resolve("esbuild/bin/esbuild"),
        [
          "tests/integration/fixtures/streaming-markdown-benchmark.tsx",
          "--bundle",
          "--platform=node",
          "--format=cjs",
          "--log-level=error",
          // jsonc-parser's UMD build requires its files at runtime; take the ESM one.
          "--main-fields=module,main",
          '--define:process.env.NODE_ENV="production"',
          "--loader:.css=empty",
          "--external:jest-environment-jsdom",
          "--outfile=" + bundle,
        ],
        { encoding: "utf8" }
      )
      output = execFileSync(process.execPath, [bundle], {
        encoding: "utf8",
        timeout: 540_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, NODE_PATH: path.join(process.cwd(), "node_modules") },
      })
    } finally {
      rmSync(tempDir, { force: true, recursive: true })
    }
    const results = JSON.parse(output.split("\nSTREAMING_BENCHMARK_RESULT=").at(-1)!) as Record<
      string,
      { chars: number; finishedMs: number; streaming: StreamingResult }
    >
    console.info(`[chat-benchmark] streaming ${JSON.stringify(results)}`)
    expect(Object.keys(results)).toEqual(["short", "medium", "long", "code", "cjk"])
    for (const result of Object.values(results)) expect(result.streaming.deltas).toBeGreaterThan(0)
  }, 600_000)
})
