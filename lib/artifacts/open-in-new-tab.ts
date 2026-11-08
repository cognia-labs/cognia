/** A scriptless host document; executable artifact bytes live only in its opaque frame. */
import type { Artifact } from "@/types"
import { injectFrameCsp, serializeFrameCsp } from "@/lib/security/frame-csp"
import { compileInteractiveHtml } from "./interactive-html"
import { isInteractiveHtmlGranted } from "./interactive-grant"
import { escapeHtml, sanitizeHTML, renderSVG } from "./preview-utils"

export function createArtifactTabDocument(
  artifact: Pick<Artifact, "id" | "type" | "title" | "content">,
  interactiveHtmlEnabled: boolean,
  baseUrl: string = window.location.href
): { html: string; dispose: () => void } {
  const interactive = isInteractiveHtmlGranted(artifact, interactiveHtmlEnabled)
  const bootstrapUrl = new URL("/artifact-runtime/artifact-tab-bootstrap.js", baseUrl)
  // URL.origin is "null" for Tauri's custom scheme; CSP needs the actual host.
  const scriptOrigin = `${bootstrapUrl.protocol}//${bootstrapUrl.host}`
  let content: string
  if (interactive) {
    const program = compileInteractiveHtml(artifact.content)
    // Escaping every '<' prevents both script terminators and HTML comments
    // from changing the JSON data block's parsing context.
    const data = JSON.stringify(program.scripts).replaceAll("<", "\\u003c")
    const scripts = `<script type="application/json">${data}</script><script src="${escapeHtml(bootstrapUrl.href)}"></script>`
    content = program.html.replace(/<\/body>/i, () => `${scripts}</body>`)
  } else {
    if (artifact.type === "svg") {
      const doc = document.implementation.createHTMLDocument()
      renderSVG(doc, artifact.content)
      content = doc.documentElement.outerHTML
    } else {
      content = sanitizeHTML(artifact.content)
    }
  }
  const policy = serializeFrameCsp([
    ["default-src", "'none'"],
    ["script-src", interactive ? `${scriptOrigin} blob:` : "'none'"],
    ["style-src", "'unsafe-inline'"],
    ["img-src", "data: blob:"],
    ["font-src", "data:"],
    ["frame-src", "about:"],
    ["connect-src", "'none'"],
    ["form-action", "'none'"],
    ["object-src", "'none'"],
    ["base-uri", "'none'"],
  ])
  const html = injectFrameCsp(
    `<!doctype html><html><head><title>${escapeHtml(artifact.title)}</title>
<style>html,body{margin:0;height:100%}iframe{display:block;width:100%;height:100%;border:0}</style>
</head><body><iframe title="${escapeHtml(artifact.title)}" sandbox="${interactive ? "allow-scripts" : ""}" srcdoc="${escapeHtml(injectFrameCsp(content, policy))}"></iframe></body></html>`,
    policy
  )
  // Script URLs are owned and released by the inner frame, never the app.
  return { html, dispose: () => {} }
}
