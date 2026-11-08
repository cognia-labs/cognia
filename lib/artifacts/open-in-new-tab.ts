/** A scriptless host document; executable artifact bytes live only in its opaque frame. */
import type { Artifact } from "@/types"
import { injectFrameCsp, serializeFrameCsp } from "@/lib/security/frame-csp"
import { compileInteractiveHtml } from "./interactive-html"
import { isInteractiveHtmlGranted } from "./interactive-grant"
import { escapeHtml, sanitizeHTML, renderSVG } from "./preview-utils"

// Keep these bytes constant: only this bootstrap is authorized to run inline.
// Artifact code becomes Blob scripts in the opaque frame's own realm.
const INTERACTIVE_TAB_BOOTSTRAP = `(() => {
  const scripts = JSON.parse(document.currentScript.previousElementSibling.textContent);
  const urls = new Set();
  const revoke = (url) => {
    if (urls.delete(url)) URL.revokeObjectURL(url);
  };
  addEventListener("pagehide", () => urls.forEach(revoke), { once: true });
  try {
    for (const { code, module } of scripts) {
      const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      urls.add(url);
      const script = document.createElement("script");
      if (module) script.type = "module";
      else script.async = false;
      script.src = url;
      script.addEventListener("load", () => revoke(url), { once: true });
      script.addEventListener("error", () => revoke(url), { once: true });
      document.head.appendChild(script);
    }
  } catch (error) {
    urls.forEach(revoke);
    throw error;
  }
})()`
const INTERACTIVE_TAB_BOOTSTRAP_HASH = "'sha256-AhWn/sBMr1SlVqQedBcflRaYgRu7CQxrbJM02ZUXa8g='"

export function createArtifactTabDocument(
  artifact: Pick<Artifact, "id" | "type" | "title" | "content">,
  interactiveHtmlEnabled: boolean
): { html: string; dispose: () => void } {
  const interactive = isInteractiveHtmlGranted(artifact, interactiveHtmlEnabled)
  let content: string
  if (interactive) {
    const program = compileInteractiveHtml(artifact.content)
    // Escaping every '<' prevents both script terminators and HTML comments
    // from changing the JSON data block's parsing context.
    const data = JSON.stringify(program.scripts).replaceAll("<", "\\u003c")
    const scripts = `<script type="application/json">${data}</script><script>${INTERACTIVE_TAB_BOOTSTRAP}</script>`
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
    ["script-src", interactive ? `${INTERACTIVE_TAB_BOOTSTRAP_HASH} blob:` : "'none'"],
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
