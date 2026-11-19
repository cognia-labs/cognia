import { build } from "esbuild"
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs"
import JSZip from "jszip"
import mammoth from "mammoth"

const root = process.cwd()
const dir = `${root}/.cache/document-export-adversarial`
await fs.mkdir(dir, { recursive: true })
await build({
  entryPoints: [
    `${root}/docs/evidence/2026-11-18-document-parsing-export-gap-audit.probes/export-entry.ts`,
  ],
  outfile: `${dir}/compiled.cjs`,
  bundle: true,
  platform: "node",
  format: "cjs",
  packages: "external",
  logLevel: "silent",
  plugins: [
    {
      name: "only-side-effect-stubs",
      setup(build) {
        build.onResolve({ filter: /^@\/lib\/files\/save-export$/ }, () => ({
          path: "save",
          namespace: "audit",
        }))
        build.onResolve({ filter: /^@\/lib\/artifacts\/export$/ }, () => ({
          path: "artifact",
          namespace: "audit",
        }))
        build.onResolve({ filter: /^@cognia\/logging$/ }, () => ({
          path: "logging",
          namespace: "audit",
        }))
        build.onResolve({ filter: /^\.\/raster$/ }, () => ({ path: "raster", namespace: "audit" }))
        build.onLoad({ filter: /.*/, namespace: "audit" }, ({ path }) => ({
          contents:
            path === "save"
              ? `export async function saveExport(opts){globalThis.__auditSaveCalls.push(opts);return {kind:'saved',location:opts.filename}}`
              : path === "artifact"
                ? `export async function exportArtifact(a,f){globalThis.__auditArtifactCalls.push({a,f});return {kind:'saved'}};export function artifactExportFilename(a,f){return a.title+'.'+f}`
                : path === "raster"
                  ? `export const readAsDataUrl = ()=>{throw Error('visual branch not used')};export const renderArtifactToPngBlob=readAsDataUrl;`
                  : `export const loggers = new Proxy({}, {get(){return new Proxy({}, {get(){return ()=>{}}})}})`,
          loader: "js",
        }))
      },
    },
  ],
})
globalThis.__auditSaveCalls = []
globalThis.__auditArtifactCalls = []
const require = createRequire(import.meta.url)
const { JSDOM, VirtualConsole } = createRequire(require.resolve("jest-environment-jsdom"))("jsdom")
const { createCanvas } = createRequire(require.resolve("pdfjs-dist/legacy/build/pdf.mjs"))(
  "@napi-rs/canvas"
)
const {
  generateDocument,
  parseMarkdownBlocks,
  getCanvasExportFormats,
  exportCanvasDocument,
  exportToBeautifulHtml,
  THEMES,
  renderArtifactToPdfBlob,
} = require(`${dir}/compiled.cjs`)
const result = {}
for (const language of ["python", "json", "markdown"]) {
  const doc = {
    id: `doc-${language}`,
    sessionId: "s",
    title: "Audit",
    content: "hello",
    language,
    type: language === "markdown" ? "text" : "code",
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  result[`canvas_${language}`] = {
    offered: getCanvasExportFormats(doc),
    pdfResult: await exportCanvasDocument(doc, "pdf"),
  }
}
result.canvasSaveCalls = globalThis.__auditSaveCalls.length
result.canvasArtifactCalls = globalThis.__auditArtifactCalls.map((x) => x.a.type)

const input = "ASCII hello\n\n中文文档测试\n\n日本語テスト\n\nEmoji 😀"
const pdf = await generateDocument({ title: "Unicode", markdown: input, format: "pdf" })
const pdfBytes = new Uint8Array(await pdf.data.arrayBuffer())
await fs.writeFile(`${dir}/unicode.pdf`, pdfBytes)
const loadingTask = getDocument({ data: pdfBytes, useSystemFonts: true })
const parsed = await loadingTask.promise
const page = await parsed.getPage(1)
const content = await page.getTextContent()
result.pdfUnicode = {
  input,
  extracted: content.items.map((x) => x.str).filter(Boolean),
  preservesChinese: content.items.some((x) => x.str.includes("中文")),
}
const viewport = page.getViewport({ scale: 1.5 })
const canvas = createCanvas(viewport.width, viewport.height)
await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise
await fs.writeFile(`${dir}/unicode.png`, canvas.toBuffer("image/png"))
await loadingTask.destroy()

const code = "```python\nif ready:\n    first()\n    second()\n```"
const docx = await generateDocument({ title: "Code", markdown: code, format: "docx" })
const docxBytes = new Uint8Array(await docx.data.arrayBuffer())
await fs.writeFile(`${dir}/code.docx`, docxBytes)
const zip = await JSZip.loadAsync(docxBytes)
const xml = await zip.file("word/document.xml").async("string")
result.docxCode = {
  xmlCode: xml.match(/<w:r><w:rPr><w:rFonts[^]*?<\/w:r>/)?.[0],
  explicitBreakCount: (xml.match(/<w:br/g) || []).length,
  plain: (await mammoth.extractRawText({ buffer: Buffer.from(docxBytes) })).value,
  html: (await mammoth.convertToHtml({ buffer: Buffer.from(docxBytes) })).value,
}

const rawCode = "def calculate():\n    value = 42\n    return value"
result.rawCodeBlocks = parseMarkdownBlocks(rawCode)
const codePdf = await renderArtifactToPdfBlob({
  id: "code",
  type: "code",
  title: "Python",
  content: rawCode,
})
const codePdfBytes = new Uint8Array(await codePdf.arrayBuffer())
await fs.writeFile(`${dir}/raw-code.pdf`, codePdfBytes)
const codePdfTask = getDocument({ data: codePdfBytes, useSystemFonts: true })
const codePdfDoc = await codePdfTask.promise
const codePdfPage = await codePdfDoc.getPage(1)
result.codeArtifactPdf = {
  input: rawCode,
  extracted: (await codePdfPage.getTextContent()).items.map((x) => ({
    text: x.str,
    y: x.transform?.[5],
  })),
}
await codePdfTask.destroy()
const markdown =
  "## Rich\n\n**bold** [link](https://example.com)\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n![diagram](data:image/png;base64,iVBORw0KGgo=)"
const richDocx = await generateDocument({ title: "Rich", markdown, format: "docx" })
const richZip = await JSZip.loadAsync(await richDocx.data.arrayBuffer())
const richXml = await richZip.file("word/document.xml").async("string")
result.richDocx = {
  blocks: parseMarkdownBlocks(markdown),
  tableCount: (richXml.match(/<w:tbl>/g) || []).length,
  imageCount: Object.keys(richZip.files).filter((p) => p.startsWith("word/media/")).length,
  hyperlinkCount: (richXml.match(/<w:hyperlink/g) || []).length,
}

const labels = {
  locale: "en",
  role: (r) => r,
  footer: () => "footer",
  parts: { notExported: () => "not exported" },
}
const opts = {
  session: { id: "s", title: "Audit", createdAt: 0 },
  messages: [],
  exportedAt: new Date(0),
  labels,
  includeMetadata: false,
}
const html = exportToBeautifulHtml({
  ...opts,
  customTheme: {
    ...THEMES.light,
    bg: "</style><script>window.__auditInjected = 42</script><style>",
  },
})
await fs.writeFile(`${dir}/theme-injection.html`, html)
const dom = new JSDOM(html, { runScripts: "dangerously", virtualConsole: new VirtualConsole() })
result.htmlCustomThemeInjection = {
  scriptCount: dom.window.document.scripts.length,
  executedValue: dom.window.__auditInjected,
}
dom.window.close()

await fs.writeFile(`${dir}/results.json`, JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
