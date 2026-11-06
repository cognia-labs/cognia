/** Strict, credential-free addresses for dock document tabs. */
import { BUILTIN_DOCUMENT_URLS } from "./providers/_document-urls"
import type { DocumentUrlScheme, RemoteDocKind, RemoteDocRef } from "./types"
import { isPluginDocsProviderId } from "./types"
import { getDocsProvider, listDocsProviders } from "./registry"

export interface CloudDocumentTarget {
  providerId: string
  resourceKind: RemoteDocKind
  resourceId: string
  url: string
  title?: string
  /** Legacy doc vs docx, for a provider whose scheme `keepsSourceType`. */
  sourceType?: "doc" | "docx"
}

/** The built-in provider's URL scheme, known before its module loads. */
export function builtinDocumentUrlScheme(providerId: string): DocumentUrlScheme | undefined {
  return BUILTIN_DOCUMENT_URLS.find((scheme) => scheme.providerId === providerId)
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
  for (const scheme of BUILTIN_DOCUMENT_URLS) {
    const target = scheme.target(url)
    if (target) return { providerId: scheme.providerId, ...target }
  }
  return pluginDocumentTarget(url)
}

export function cloudDocumentTargetFromRef(
  providerId: string,
  ref: RemoteDocRef
): CloudDocumentTarget | null {
  const scheme = builtinDocumentUrlScheme(providerId)
  if ((!scheme && !isPluginDocsProviderId(providerId)) || ref.providerId !== providerId || !ref.id)
    return null
  if (scheme?.kinds && !scheme.kinds.includes(ref.kind)) return null
  if (isPluginDocsProviderId(providerId)) {
    const provider = getDocsProvider(providerId)
    if (provider && !provider.kinds.includes(ref.kind)) return null
  }
  const canonical = ref.url || scheme?.canonicalUrl?.(ref.kind, ref.id)
  const parsed = canonical ? classifyCloudDocumentUrl(canonical) : null
  return {
    providerId,
    resourceKind: ref.kind,
    resourceId: ref.id,
    title: ref.title,
    ...(scheme?.keepsSourceType &&
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
