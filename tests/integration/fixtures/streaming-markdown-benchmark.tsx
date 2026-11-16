// Streaming Markdown benchmark (chat-surface overhaul, step 2). Bundled and run
// by `components/chat/streaming-text-part.benchmark.test.ts`.
//
// Renders the real `StreamingTextPart` (Streamdown, incremental block parser,
// ink animation) into a persistent jsdom root, one synchronous commit per
// 20-character delta, and the real `MarkdownRenderer` once for the finished
// text. CPU only: no layout or paint. Prints one JSON line.
import "./streaming-markdown-benchmark.setup"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { NextIntlClientProvider } from "next-intl"
import type { ReactNode } from "react"

import messages from "@/i18n/messages/en.json"
import { TooltipProvider } from "@/components/ui/tooltip"
import { StreamingTextPart } from "@/components/chat/streaming-text-part"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"

const DELTA = 20

function prose(seed: number, words = 60): string {
  const vocabulary = "the model reads each file and writes a short plan before it edits code".split(
    " "
  )
  return Array.from({ length: words }, (_, i) => {
    const word = vocabulary[(seed * 7 + i) % vocabulary.length]!
    return i % 17 === 3 ? `**${word}**` : i % 13 === 5 ? `\`${word}\`` : word
  }).join(" ")
}

function table(rows: number): string {
  return [
    "| Name | Kind | Size |",
    "| --- | --- | ---: |",
    ...Array.from({ length: rows }, (_, i) => `| item-${i} | file | ${i * 128} |`),
  ].join("\n")
}

function fence(lang: string, lines: number): string {
  const body = Array.from({ length: lines }, (_, i) =>
    lang === "rust"
      ? `    let value_${i} = compute(${i}).unwrap_or_default();`
      : lang === "json"
        ? `  "key_${i}": ${i},`
        : `  const value${i} = await compute(${i}) // step ${i}`
  ).join("\n")
  return `\`\`\`${lang}\n${body}\n\`\`\``
}

function sized(target: number, build: (i: number) => string): string {
  const parts: string[] = []
  let length = 0
  for (let i = 0; length < target; i++) {
    const part = build(i)
    parts.push(part)
    length += part.length + 2
  }
  return parts.join("\n\n")
}

const cjkLine =
  "模型先阅读相关文件，再写出简短的计划，然后逐步修改代码并运行测试，确认结果符合预期。"

const corpus: Record<string, string> = {
  short: sized(400, (i) => prose(i, 30)),
  medium: sized(5_000, (i) =>
    i % 5 === 2 ? table(6) : i % 5 === 4 ? `- ${prose(i, 12)}\n- ${prose(i + 1, 12)}` : prose(i)
  ),
  long: sized(50_000, (i) =>
    i % 12 === 3
      ? fence(["ts", "rust", "json"][i % 3]!, 30)
      : i % 12 === 7
        ? `$$\n\\sum_{k=0}^{${i}} k^2 = \\frac{n(n+1)(2n+1)}{6}\n$$`
        : i % 6 === 5
          ? table(8)
          : prose(i)
  ),
  code: fence("ts", 400),
  cjk: sized(5_000, (i) =>
    i % 4 === 3 ? `- ${cjkLine}\n- ${cjkLine}` : i % 6 === 5 ? table(5) : `${cjkLine}${cjkLine}`
  ),
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <TooltipProvider>{children}</TooltipProvider>
    </NextIntlClientProvider>
  )
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0
}

const round = (value: number) => Math.round(value * 1000) / 1000

async function streamDoc(name: string, text: string) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  const samples: number[] = []
  for (let end = DELTA; end < text.length + DELTA; end += DELTA) {
    const slice = text.slice(0, Math.min(end, text.length))
    const t0 = performance.now()
    flushSync(() =>
      root.render(
        <Providers>
          <StreamingTextPart messageId={`bench-${name}`} text={slice} isStreaming />
        </Providers>
      )
    )
    samples.push(performance.now() - t0)
    // Let async highlight and effect callbacks land between deltas.
    await new Promise((resolve) => setImmediate(resolve))
  }
  const domBytes = container.innerHTML.length
  const quarter = Math.floor(samples.length / 4)
  const byQuarter = [0, 1, 2, 3].map((q) =>
    round(percentile(samples.slice(q * quarter, (q + 1) * quarter || undefined), 50))
  )
  root.unmount()
  container.remove()
  return {
    deltas: samples.length,
    totalMs: round(samples.reduce((sum, value) => sum + value, 0)),
    p50: round(percentile(samples, 50)),
    p95: round(percentile(samples, 95)),
    p50ByQuarter: byQuarter,
    streamingDomBytes: domBytes,
  }
}

function finishedRender(text: string) {
  const runs: number[] = []
  for (let i = 0; i < 12; i++) {
    const t0 = performance.now()
    renderToString(
      <Providers>
        <MarkdownRenderer content={text} />
      </Providers>
    )
    if (i >= 2) runs.push(performance.now() - t0)
  }
  return round(percentile(runs, 50))
}

async function main() {
  // Warm the module graph and JIT.
  await streamDoc("warmup", corpus.short!)
  const results: Record<string, unknown> = {}
  for (const [name, text] of Object.entries(corpus)) {
    results[name] = {
      chars: text.length,
      finishedMs: finishedRender(text),
      streaming: await streamDoc(name, text),
    }
  }
  process.stdout.write(`\nSTREAMING_BENCHMARK_RESULT=${JSON.stringify(results)}\n`)
  process.exit(0)
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exit(1)
})
