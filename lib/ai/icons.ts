/** Provider metadata compatibility exports plus app model-display helpers. */
export {
  getProviderIconInfo,
  getProviderIconPath,
  getProviderBrandColor,
  getProviderDisplayName,
  getProviderInitial,
  hasLocalProviderIcon,
  getAllProviderIds,
  type ProviderIconInfo,
} from "@cognia/provider-types/provider-icons"

// ============================================================================
// Model → Provider Resolution
// ============================================================================

/**
 * Model ID prefix patterns mapped to provider IDs.
 * Used to infer provider from model ID when provider is unknown.
 */
const MODEL_PROVIDER_PATTERNS: Array<{ pattern: RegExp; provider: string }> = [
  { pattern: /^(gpt-|o1-|o3-|dall-e|text-|whisper|tts-)/i, provider: "openai" },
  { pattern: /^(claude-)/i, provider: "anthropic" },
  { pattern: /^(gemini-|gemma)/i, provider: "google" },
  { pattern: /^(deepseek-)/i, provider: "deepseek" },
  { pattern: /^(grok-)/i, provider: "xai" },
  { pattern: /^(mistral-|mixtral|codestral|pixtral|ministral)/i, provider: "mistral" },
  { pattern: /^(llama-|llama3|meta-llama)/i, provider: "meta" },
  { pattern: /^(command-)/i, provider: "cohere" },
  { pattern: /^(qwen)/i, provider: "alibaba" },
]

/**
 * Attempt to resolve the provider from a model ID string.
 * Returns the provider ID or null if unknown.
 */
export function resolveProviderFromModel(modelId: string): string | null {
  for (const { pattern, provider } of MODEL_PROVIDER_PATTERNS) {
    if (pattern.test(modelId)) {
      return provider
    }
  }
  return null
}

// ============================================================================
// Model Display Names
// ============================================================================

/**
 * Common model ID → display name mappings for cleaner UI display.
 */
const MODEL_DISPLAY_NAMES: Record<string, string> = {
  "gpt-4o": "GPT-4o",
  "gpt-4o-mini": "GPT-4o Mini",
  "gpt-4-turbo": "GPT-4 Turbo",
  "gpt-4": "GPT-4",
  "gpt-3.5-turbo": "GPT-3.5 Turbo",
  "o1-preview": "o1 Preview",
  "o1-mini": "o1 Mini",
  "claude-fable-5": "Claude Fable 5",
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-opus-4-7": "Claude Opus 4.7",
  "claude-opus-4-6": "Claude Opus 4.6",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "claude-sonnet-4-20250514": "Claude Sonnet 4",
  "claude-opus-4-20250514": "Claude Opus 4",
  "claude-haiku-4-20250514": "Claude Haiku 4",
  "claude-3-5-sonnet-20241022": "Claude 3.5 Sonnet",
  "claude-3-5-haiku-20241022": "Claude 3.5 Haiku",
  "gemini-2.0-flash-exp": "Gemini 2.0 Flash",
  "gemini-1.5-pro": "Gemini 1.5 Pro",
  "gemini-1.5-flash": "Gemini 1.5 Flash",
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "deepseek-chat": "DeepSeek Chat",
  "deepseek-coder": "DeepSeek Coder",
  "deepseek-reasoner": "DeepSeek Reasoner",
  "grok-3": "Grok 3",
  "grok-3-mini": "Grok 3 Mini",
  "llama-3.3-70b-versatile": "Llama 3.3 70B",
  "mixtral-8x7b-32768": "Mixtral 8x7B",
  "mistral-large-latest": "Mistral Large",
  "mistral-small-latest": "Mistral Small",
  "codestral-latest": "Codestral",
  "command-r-plus": "Command R+",
  "command-r": "Command R",
}

/**
 * Get the human-friendly display name for a model.
 * Falls back to the raw model ID if no mapping exists.
 */
export function getModelDisplayName(modelId: string): string {
  return MODEL_DISPLAY_NAMES[modelId] || modelId
}
