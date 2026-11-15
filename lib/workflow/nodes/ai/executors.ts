import { registerNodeExecutor } from "../registry"
import { generateTextEmbedding } from "@cognia/provider-embedding/multimodal-embedding"
// ── AI structured-output helpers (shared by ai.prompt / ai.extract) ─────────
// parseStructured / buildJsonInstruction live in ./structured so the
// ai.prompt module can share them without a circular import.
import { buildJsonInstruction, parseStructured } from "./structured"
import { coerceToType, nonRetryable, resolveNodeApiKey } from "../shared/executor-support"
import { runAiPromptFusionAction } from "./fusion-action"
import { resolvePromptAsync } from "@/lib/prompts/resolve"
import { definePrompt, type PromptResolutionContext } from "@/lib/prompts/types"

// ── Shipped node instructions (ADR-0236) ──────────────────────────────────
// `ai.classify` and `ai.extract` build their system prompt from the node's
// labels / schema and its own `hint`; the wording around them is editable.
// The node's configuration stays the node's: it is rendered as values, and
// the hint is appended after the shipped text exactly as before.

/** Labels, schemas and hints are node configuration; this only guards. */
const NODE_VALUE_MAX = 200_000

export const CLASSIFY_NODE_PROMPT = definePrompt({
  id: "developer.workflow.classify.system",
  contractVersion: 1,
  kind: "feature-template",
  group: "developer",
  operation: "replace-template",
  scopes: ["account", "workspace"],
  activation: "next-operation",
  // The reply is matched against the labels to pick the branch that runs.
  risk: "protocol",
  hosts: ["app", "cli"],
  maxChars: 4_000,
  variables: [
    { name: "labels", required: true, maxChars: NODE_VALUE_MAX },
    { name: "guidance", required: false, maxChars: NODE_VALUE_MAX },
  ],
  outputContract:
    'The first label whose lowercase form appears in the reply becomes the node\'s decision (the first label when none does). {{labels}} is one "- label" line per label; {{guidance}} is the node\'s hint after a blank line and "Guidance:", or empty.',
  consumers: ["lib/workflow/nodes/ai/executors.ts"],
  defaultBody:
    `You are a strict text classifier. ` +
    `Return EXACTLY ONE of the following labels with no extra text:\n{{labels}}{{guidance}}`,
})

export const EXTRACT_NODE_PROMPT = definePrompt({
  id: "developer.workflow.extract.system",
  contractVersion: 1,
  kind: "feature-template",
  group: "developer",
  operation: "replace-template",
  scopes: ["account", "workspace"],
  activation: "next-operation",
  // The reply is parsed as a JSON object and coerced to the schema's hints.
  risk: "protocol",
  hosts: ["app", "cli"],
  maxChars: 4_000,
  variables: [
    { name: "fields", required: true, maxChars: NODE_VALUE_MAX },
    { name: "guidance", required: false, maxChars: NODE_VALUE_MAX },
  ],
  requiredFragments: ["JSON"],
  outputContract:
    'Parsed as one JSON object; fields are coerced to their type hints and required fields decide `valid`. {{fields}} is one `"key": hint` line per schema field; {{guidance}} is the node\'s hint after a blank line and "Guidance:", or empty.',
  consumers: ["lib/workflow/nodes/ai/executors.ts"],
  defaultBody:
    `Extract data from the user message. Reply with ONLY a JSON object ` +
    `matching this shape:\n{\n{{fields}}\n}{{guidance}}`,
})

/** A run's workspace, so its customized node wording applies. */
function nodePromptContext(ctx: { projectId?: string }): PromptResolutionContext {
  return ctx.projectId ? { workspaceId: ctx.projectId } : {}
}

// ── ai.prompt ─────────────────────────────────────────────────────────────
// Explicit mode (direct provider/model/credentials, with a clearly-marked echo
// stub when no credentials resolve) or routed mode (ADR-0043 provider-routing
// engine + fallback chains), behind the PII gate, with live output streaming
// and per-step usage/cost reporting. Full logic lives in ./ai-prompt so it's
// independently testable.
registerNodeExecutor({
  kind: "ai.prompt",
  typeVersion: 2,
  execute: async (ctx) => {
    // The action is decided before the executor's own mode
    // (`explicit` / `routed`), because a fusion run replaces the call rather
    // than changing how one call is routed.
    const fusionStep = await runAiPromptFusionAction(ctx)
    if (fusionStep) return fusionStep
    return (await import("./ai-prompt")).executeAiPrompt(ctx)
  },
})

// ── ai.council ────────────────────────────────────────────────────────────
// Multi-model consensus: fan the prompt out to several councillor models (by
// routing alias) in parallel, then a synthesizer model merges them into one
// answer with a confidence rating. Not retryable (it already runs N provider
// calls; a blanket retry would multiply cost). Logic in ./ai/ai-council.
registerNodeExecutor({
  kind: "ai.council",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx) => (await import("./ai-council")).executeAiCouncil(ctx),
})

// ── ai.ensemble ────────────────────────────────────────────────────────────
// Run one target (inline agent.turn OR a sub-workflow) N times with optional
// per-sample lenses, then apply a bundled aggregation policy (majority-vote /
// threshold / best-of / synthesize). The signature N-vote / adversarial-verify
// harness. Not retryable (it already runs N calls). Logic in ./ai/ai-ensemble.
registerNodeExecutor({
  kind: "ai.ensemble",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx) => (await import("./ai-ensemble")).executeAiEnsemble(ctx),
})

// ── ai.classify ───────────────────────────────────────────────────────────
// Reuses the `ai.prompt` executor under the hood with a constrained system
// prompt. The output is normalized to the matched label so downstream
// `flow.branch` / `flow.switch` nodes can route on it directly.
registerNodeExecutor({
  kind: "ai.classify",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      provider?: string
      model?: string
      apiKey?: string
      baseURL?: string
      apiFlavor?: import("@cognia/provider-types/provider").ApiFlavor
      headers?: Record<string, string>
      input?: string
      labels?: string[]
      hint?: string
      mode?: "explicit" | "routed"
      modelAlias?: string
      piiGate?: "off" | "block" | "redact"
    }
    const labels = (params.labels ?? []).map((l) => l.trim()).filter(Boolean)
    if (labels.length === 0) {
      throw nonRetryable("ai.classify requires at least one entry in 'labels'")
    }
    const input = params.input ?? ""
    if (!input) throw nonRetryable("ai.classify requires non-empty 'input'")
    const labelList = labels.map((l) => `- ${l}`).join("\n")
    const systemPrompt = (
      await resolvePromptAsync(CLASSIFY_NODE_PROMPT, {
        context: nodePromptContext(ctx),
        values: {
          labels: labelList,
          guidance: params.hint ? `\n\nGuidance: ${params.hint}` : "",
        },
      })
    ).text
    ctx.signal?.throwIfAborted()
    // Delegate to ai.prompt's explicit mode (same provider handling + stub
    // fallback); routed mode and the PII gate apply when those params are set
    // on the classify node.
    const aiPrompt = (await import("../registry")).getExecutor("ai.prompt", 2)
    if (!aiPrompt) throw new Error("ai.classify: ai.prompt executor unavailable")
    const inner = await aiPrompt.execute({
      ...ctx,
      params: {
        provider: params.provider,
        model: params.model,
        apiKey: params.apiKey,
        baseURL: params.baseURL,
        apiFlavor: params.apiFlavor,
        headers: params.headers,
        systemPrompt,
        userPrompt: input,
        temperature: 0,
        mode: params.mode,
        modelAlias: params.modelAlias,
        piiGate: params.piiGate,
      } as Record<string, unknown>,
    })
    const completion = String(
      (inner.output as { completion?: string } | undefined)?.completion ?? ""
    ).trim()
    // Pick the first label whose lowercase form appears in the completion.
    // If nothing matches we fall back to the first label so downstream
    // branches always receive a known value.
    const lower = completion.toLowerCase()
    const matched = labels.find((l) => lower.includes(l.toLowerCase())) ?? labels[0]
    return {
      output: {
        label: matched,
        completion,
        confident: matched.toLowerCase() === lower,
      },
      // Route like a Question Classifier: the orchestrator follows only the
      // outgoing edge whose label / sourceHandle matches the chosen category;
      // other category branches are skipped. Edges are labeled with the
      // category names in the editor.
      decision: matched,
    }
  },
})

// ── ai.extract ────────────────────────────────────────────────────────────
// Structured JSON extraction. The executor instructs the LLM to emit JSON
// matching the `schema` object's shape, then attempts to parse it.
registerNodeExecutor({
  kind: "ai.extract",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      provider?: string
      model?: string
      apiKey?: string
      baseURL?: string
      apiFlavor?: import("@cognia/provider-types/provider").ApiFlavor
      headers?: Record<string, string>
      input?: string
      schema?: Record<string, string>
      /** Field names that must be present + non-null for `valid` to be true. */
      required?: string[]
      hint?: string
      mode?: "explicit" | "routed"
      modelAlias?: string
      piiGate?: "off" | "block" | "redact"
    }
    const input = params.input ?? ""
    if (!input) throw nonRetryable("ai.extract requires non-empty 'input'")
    const schema = params.schema ?? {}
    const fieldList = Object.entries(schema)
      .map(([k, v]) => `  "${k}": ${v}`)
      .join(",\n")
    const systemPrompt = (
      await resolvePromptAsync(EXTRACT_NODE_PROMPT, {
        context: nodePromptContext(ctx),
        values: {
          fields: fieldList,
          guidance: params.hint ? `\n\nGuidance: ${params.hint}` : "",
        },
      })
    ).text
    ctx.signal?.throwIfAborted()
    // Lift the REQUIRED field names into a presence-only JSON object schema so
    // the inner v2 turn validates the completion and auto-fixes ONCE when a
    // required field is missing (D3). Deliberately presence-only: this node
    // coerces type hints AFTER parsing (`coerceToType`), so a model returning
    // `"42"` for a number hint is fine — a type-strict schema would burn the
    // retry on completions the coercion already handles. `soft` mode on
    // purpose: this node's own `valid` / `missing` output is the caller-facing
    // contract, so a persistent violation degrades to the legacy best-effort
    // parse instead of failing the step.
    const required = Array.isArray(params.required) ? params.required : []
    const innerOutputSchema =
      required.length > 0
        ? {
            type: "object",
            properties: Object.fromEntries(Object.keys(schema).map((k) => [k, {}])),
            required,
          }
        : undefined
    // Delegate to ai.prompt v2 (see ai.classify above for the rationale).
    const aiPrompt = (await import("../registry")).getExecutor("ai.prompt", 2)
    if (!aiPrompt) throw new Error("ai.extract: ai.prompt executor unavailable")
    const inner = await aiPrompt.execute({
      ...ctx,
      params: {
        provider: params.provider,
        model: params.model,
        apiKey: params.apiKey,
        baseURL: params.baseURL,
        apiFlavor: params.apiFlavor,
        headers: params.headers,
        systemPrompt,
        userPrompt: input,
        temperature: 0,
        mode: params.mode,
        modelAlias: params.modelAlias,
        piiGate: params.piiGate,
        ...(innerOutputSchema
          ? {
              responseFormat: "json",
              outputSchema: innerOutputSchema,
              onSchemaViolation: "soft",
            }
          : {}),
      } as Record<string, unknown>,
    })
    const completion = String(
      (inner.output as { completion?: string } | undefined)?.completion ?? ""
    )
    // Robust parse (handles fenced blocks + surrounding prose) into a typed
    // parameter struct — this is the "Parameter Extractor" behavior.
    const parsed = parseStructured(completion)
    let extracted: unknown = parsed.value
    const parseError = parsed.error

    // Coerce declared fields to their type hints (best-effort) so downstream
    // nodes get numbers/booleans rather than stringified values.
    if (extracted && typeof extracted === "object" && !Array.isArray(extracted)) {
      const obj = extracted as Record<string, unknown>
      for (const [key, typeHint] of Object.entries(schema)) {
        if (key in obj) obj[key] = coerceToType(obj[key], String(typeHint))
      }
      extracted = obj
    }

    const present =
      extracted && typeof extracted === "object" && !Array.isArray(extracted)
        ? (extracted as Record<string, unknown>)
        : {}
    const missing = required.filter((k) => present[k] === undefined || present[k] === null)
    const valid = !parseError && missing.length === 0

    return {
      output: {
        extracted,
        missing,
        valid,
        parseError,
        completion,
      },
    }
  },
})

// ── ai.embed ──────────────────────────────────────────────────────────────
// Phase 1 ships the deterministic hash-based embedder from
// `lib/ai/embedding/multimodal-embedding`. It's not a real semantic
// embedding — it's stable across runs, useful for testing and for
// downstream "did this text change?" checks. Real semantic embeddings
// land when the orchestrator can supply a configured embedding provider
// via secret refs (Phase 9 polish).
registerNodeExecutor({
  kind: "ai.embed",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      input?: string
      dimension?: number
      provider?: string
      model?: string
      apiKey?: string
    }
    const text = params.input ?? ""
    if (!text) throw nonRetryable("ai.embed requires non-empty 'input'")
    const dimension =
      typeof params.dimension === "number" && params.dimension > 0
        ? Math.floor(params.dimension)
        : 384

    const apiKey = await resolveNodeApiKey(ctx, params.apiKey)

    // Real semantic embedding when a provider + model (+ key if required) are
    // configured; otherwise fall back to the deterministic hash so workflows
    // authored before credentials still run end-to-end.
    if (params.provider && params.model) {
      try {
        const { generateEmbedding } = await import("@cognia/vector/embedding")
        const result = await generateEmbedding(
          text,
          {
            provider: params.provider,
            model: params.model,
            dimensions: dimension,
          } as Parameters<typeof generateEmbedding>[1],
          apiKey ?? ""
        )
        return {
          output: {
            vector: result.embedding,
            dimension: result.embedding.length,
            provider: result.provider,
            model: result.model,
            kind: "semantic",
          },
        }
      } catch (err) {
        ctx.log(
          "warn",
          `ai.embed: semantic embedding failed (${err instanceof Error ? err.message : String(err)}) — falling back to deterministic hash.`
        )
      }
    }

    const vector = generateTextEmbedding(text, { dimension })
    return {
      output: {
        vector,
        dimension: vector.length,
        // Hash-based embedder is deterministic but NOT semantic. Surface
        // that fact so downstream consumers don't accidentally trust it
        // for similarity search outside test scenarios.
        kind: "deterministic-hash",
      },
    }
  },
})
