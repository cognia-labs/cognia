/** Standalone tab execution without the dock shell's postMessage protocol. */
import type { ArtifactShellScript } from "./artifact-shell-entry"

export function runArtifactTabScripts(
  scope: Pick<Window, "document" | "addEventListener"> & {
    URL: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">
    Blob: typeof Blob
  }
): void {
  const scripts = JSON.parse(
    scope.document.currentScript?.previousElementSibling?.textContent ?? "[]"
  ) as ArtifactShellScript[]
  const urls = new Set<string>()
  const revoke = (url: string) => {
    if (urls.delete(url)) scope.URL.revokeObjectURL(url)
  }
  scope.addEventListener("pagehide", () => urls.forEach(revoke), { once: true })
  try {
    for (const { code, module } of scripts) {
      const url = scope.URL.createObjectURL(new scope.Blob([code], { type: "text/javascript" }))
      urls.add(url)
      const script = scope.document.createElement("script")
      if (module) script.type = "module"
      else script.async = false
      script.src = url
      script.addEventListener("load", () => revoke(url), { once: true })
      script.addEventListener("error", () => revoke(url), { once: true })
      scope.document.head.appendChild(script)
    }
  } catch (error) {
    urls.forEach(revoke)
    throw error
  }
}
