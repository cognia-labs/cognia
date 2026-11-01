/** Strict, credential-free addresses for dock document tabs. */
import { LARK_HOST_SUFFIXES, parseLarkResourceUrl } from "@/lib/twin/ingest/lark-url"
import { googleDocUrl, parseGoogleDocUrl } from "./providers/google/url"
import type { RemoteDocKind, RemoteDocRef } from "./types"
import { isPluginDocsProviderId } from "./types"
import { getDocsProvider, listDocsProviders } from "./registry"

export interface CloudDocumentTarget {
  providerId: string
  resourceKind: RemoteDocKind
  resourceId: string
  url: string
  title?: string
  /** Lark folds legacy docs and docx into `doc`; opaque picker tokens need this hint. */
  sourceType?: "doc" | "docx"
}

function pluginDocumentTarget(url: URL): CloudDocumentTarget | null {
  for (const provider of listDocsProviders()) {
    if (!isPluginDocsProviderId(provider.id) || !provider.urlOrigins?.includes(url.origin)) continue
    try {
      const ref = provider.matchRef(url.href)
      if (!ref || !provider.kinds.includes(ref.kind) || !ref.id) continue
      const canonical = ref.url ? new URL(ref.url) : url
      if (
        canonical.protocol !== "https:" ||
        canonical.username ||
        canonical.password ||
        !provider.urlOrigins.includes(canonical.origin)
      )
        continue
      return {
        providerId: provider.id,
        resourceKind: ref.kind,
        resourceId: ref.id,
        url: canonical.href,
      }
    } catch {
      // One malformed plugin match cannot prevent recognition by another provider.
    }
  }
  return null
}

export function classifyCloudDocumentUrl(raw: string): CloudDocumentTarget | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    /^https:\/\/[^/?#]*@/i.test(raw.trim())
  )
    return null
  if (url.port) return pluginDocumentTarget(url)
  if (url.hostname === "docs.google.com") {
    const ref = parseGoogleDocUrl(url.href)
    if (!ref) return pluginDocumentTarget(url)
    const canonical = new URL(googleDocUrl(ref.kind, ref.id))
    const key = ref.kind === "sheet" ? "gid" : "tab"
    const pattern = key === "gid" ? /^\d{1,20}$/ : /^[A-Za-z0-9_.-]{1,128}$/
    const value = [url.searchParams.get(key), new URLSearchParams(url.hash.slice(1)).get(key)].find(
      (candidate) => candidate && pattern.test(candidate)
    )
    if (value) {
      canonical.searchParams.set(key, value)
    }
    return { providerId: "google", resourceKind: ref.kind, resourceId: ref.id, url: canonical.href }
  }
  if (
    !LARK_HOST_SUFFIXES.some(
      (suffix) => url.hostname === suffix.slice(1) || url.hostname.endsWith(suffix)
    )
  )
    return pluginDocumentTarget(url)
  const ref = parseLarkResourceUrl(url.href)
  if (!ref || ref.lowConfidence) return pluginDocumentTarget(url)
  return {
    providerId: "lark",
    resourceKind: ref.kind === "docx" ? "doc" : ref.kind,
    resourceId: ref.token,
    url: `${url.origin}${url.pathname}`,
  }
}

export function cloudDocumentTargetFromRef(
  providerId: string,
  ref: RemoteDocRef
): CloudDocumentTarget | null {
  if (
    (providerId !== "lark" && providerId !== "google" && !isPluginDocsProviderId(providerId)) ||
    ref.providerId !== providerId ||
    !ref.id
  )
    return null
  if (providerId === "google" && !["doc", "sheet"].includes(ref.kind)) return null
  if (isPluginDocsProviderId(providerId)) {
    const provider = getDocsProvider(providerId)
    if (provider && !provider.kinds.includes(ref.kind)) return null
  }
  const parsed = ref.url
    ? classifyCloudDocumentUrl(ref.url)
    : providerId === "google"
      ? classifyCloudDocumentUrl(googleDocUrl(ref.kind, ref.id))
      : null
  return {
    providerId,
    resourceKind: ref.kind,
    resourceId: ref.id,
    title: ref.title,
    ...(providerId === "lark" &&
    ref.kind === "doc" &&
    (ref.sourceType === "doc" || ref.sourceType === "docx")
      ? { sourceType: ref.sourceType }
      : {}),
    url:
      parsed?.providerId === providerId &&
      parsed.resourceKind === ref.kind &&
      parsed.resourceId === ref.id
        ? parsed.url
        : "",
  }
}
