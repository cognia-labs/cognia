/** Google Workspace document addresses for dock tabs (`lib/docs-providers/document-url.ts`). */
import type { DocumentUrlScheme } from "@/lib/docs-providers/types"
import { googleDocUrl, parseGoogleDocUrl } from "./url"

export const googleDocumentUrls: DocumentUrlScheme = {
  providerId: "google",
  kinds: ["doc", "sheet"],
  target(url) {
    if (url.hostname !== "docs.google.com") return null
    const ref = parseGoogleDocUrl(url.href)
    if (!ref) return null
    const canonical = new URL(googleDocUrl(ref.kind, ref.id))
    // Keep the one tab or sheet selector the link pointed at, nothing else.
    const key = ref.kind === "sheet" ? "gid" : "tab"
    const pattern = key === "gid" ? /^\d{1,20}$/ : /^[A-Za-z0-9_.-]{1,128}$/
    const value = [url.searchParams.get(key), new URLSearchParams(url.hash.slice(1)).get(key)].find(
      (candidate) => candidate && pattern.test(candidate)
    )
    if (value) canonical.searchParams.set(key, value)
    return { resourceKind: ref.kind, resourceId: ref.id, url: canonical.href }
  },
  canonicalUrl: googleDocUrl,
}
