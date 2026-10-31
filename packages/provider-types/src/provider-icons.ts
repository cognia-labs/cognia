/** Provider visual metadata. Resource identity is shared with every brand renderer. */
import { brandIconAsset } from "@cognia/brand-assets"
import { getBuiltInProviderCatalogEntry, isBuiltInProviderId } from "./built-in-provider-catalog"
import { resolveModelsDevProviderId } from "./models-dev-id-map"

export interface ProviderIconInfo {
  name: string
  /** Bundled resource path; empty when no local resource is available. */
  localIcon: string
  brandColor: string
  hasLocalIcon: boolean
}

const PROVIDER_BRAND_COLORS: Record<string, string> = {
  openai: "#10a37f",
  anthropic: "#d4a574",
  google: "#4285f4",
  deepseek: "#4d6bfe",
  groq: "#f55036",
  mistral: "#ff7000",
  xai: "#1da1f2",
  togetherai: "#6366f1",
  openrouter: "#6466f1",
  opencode: "#fab283",
  "opencode-go": "#fab283",
  cohere: "#39594d",
  fireworks: "#ff6b35",
  cerebras: "#ff4f00",
  sambanova: "#ff6600",
  zhipu: "#2563eb",
  minimax: "#0f766e",
  ollama: "#ffffff",
  lmstudio: "#6c63ff",
  vllm: "#7c3aed",
  llamacpp: "#ff8236",
  llamafile: "#e66000",
  localai: "#1e88e5",
  jan: "#1a1a2e",
  textgenwebui: "#4caf50",
  koboldcpp: "#8b5cf6",
  tabbyapi: "#f59e0b",
  cliproxyapi: "#3b82f6",
}

// These existing app labels intentionally differ from the catalog's longer names.
const DISPLAY_NAME_OVERRIDES: Record<string, string> = {
  xai: "xAI",
  fireworks: "Fireworks.ai",
  llamafile: "llamafile",
  textgenwebui: "Text Gen WebUI",
}

function ownValue(table: Record<string, string>, id: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(table, id) ? table[id] : undefined
}

export function getProviderIconInfo(providerId: string): ProviderIconInfo {
  const normalized = providerId.trim().toLowerCase()
  const asset = brandIconAsset(providerId)
  const catalog = isBuiltInProviderId(normalized)
    ? getBuiltInProviderCatalogEntry(normalized)
    : undefined
  return {
    name: ownValue(DISPLAY_NAME_OVERRIDES, normalized) ?? catalog?.name ?? providerId,
    localIcon: asset?.src ?? "",
    brandColor: ownValue(PROVIDER_BRAND_COLORS, normalized) ?? "#6b7280",
    hasLocalIcon: asset !== null,
  }
}

export function getProviderIconPath(providerId: string): string {
  const info = getProviderIconInfo(providerId)
  if (info.hasLocalIcon) return info.localIcon
  const normalized = providerId.trim().toLowerCase()
  const cdnId = resolveModelsDevProviderId(normalized) ?? normalized
  return `https://models.dev/logos/${cdnId}.svg`
}

export function getProviderBrandColor(providerId: string): string {
  return getProviderIconInfo(providerId).brandColor
}

export function getProviderDisplayName(providerId: string): string {
  return getProviderIconInfo(providerId).name
}

export function getProviderInitial(providerId: string): string {
  return getProviderDisplayName(providerId).charAt(0).toUpperCase()
}

export function hasLocalProviderIcon(providerId: string): boolean {
  return brandIconAsset(providerId) !== null
}

/** Preserve the registered metadata IDs and their order, rather than listing all brand aliases. */
export function getAllProviderIds(): string[] {
  return Object.keys(PROVIDER_BRAND_COLORS)
}
