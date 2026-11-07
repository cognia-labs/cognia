/**
 * The code-owned prompt catalog (ADR-0236).
 *
 * A list of references to definitions that live with their owners; it is not
 * a second home for any prompt text. Every entry here has a real consumer
 * that resolves it (see each definition's `consumers`), and the catalog test
 * fails on a duplicate id, a default that does not validate against its own
 * contract, or a definition nothing resolves.
 *
 * Imported by the Prompt Center and the CLI `prompts` command only, never on
 * a send path: consumers import their own definition directly. Slots that
 * enabled plugins register (`plugin-prompts.ts`) are merged into the lookups.
 *
 * A feature module's prompts are not imported here: its manifest contributes
 * them (`prompts`, ADR-0250 §14 M3) and they arrive through the generated
 * registry `lib/modules/generated/prompts.ts`, lazily. `loadPromptCatalog()`
 * loads them; the lookups list them once it has resolved, so every entry
 * point that reads the catalog awaits it first.
 */

import { builtinAgents } from "@/lib/agent/builtin-catalog/catalog"
import { BUILT_IN_MODE_PROMPTS } from "@/lib/agent/modes/built-ins"
import { BRIEF_MODE_PROMPT } from "@/lib/agent/prompts/brief-mode"
import { CLI_BASE_IDENTITY_PROMPT } from "@/lib/agent/prompts/cli-base"
import { PLAN_MODE_PROMPT, PLAN_MODE_STRUCTURED_STEPS_PROMPT } from "@/lib/agent/prompts/plan-mode"
import { ASIDE_READ_ONLY_PROMPT, ASIDE_SYSTEM_PROMPT } from "@/lib/agent/prompts/side-chat"
import { CANVAS_ACTION_PROMPTS } from "@/lib/ai/generation/canvas-actions"
import { SELECTION_SUMMARY_PROMPT } from "@/lib/ai/generation/summarize-material"
import { CONVERSATION_SUMMARY_PROMPT } from "@/lib/ai/generation/summarizer"
import { COMMAND_JUDGE_PROMPT } from "@/lib/claude/permissions/command-judge"
import { DIFFICULTY_JUDGE_PROMPT } from "@/lib/ai/routing/difficulty-judge"
import { ROUTER_FUSION_ROLE_PROMPTS } from "@/lib/router-fusion/prompts/role-prompts"
import { TITLE_CHAT_PROMPT, TITLE_WORK_PROMPT } from "@/lib/ai/generation/title"
import { ENHANCE_STYLE_PROMPTS, ENHANCE_SYSTEM_PROMPT } from "@/lib/chat/completion/enhance"
import { GHOST_TEXT_PROMPT } from "@/lib/chat/completion/ghost-prompt"
import {
  FOLLOW_UP_SUGGESTIONS_PROMPT,
  STARTER_SUGGESTIONS_PROMPT,
} from "@/lib/chat/completion/suggestions"
import { DIFF_REVIEW_PROMPT } from "@/lib/git/ai-review"
import {
  ISSUE_DRAFT_PROMPT,
  ISSUE_IMPROVE_PROMPT,
  ISSUE_METADATA_PROMPT,
  ISSUE_RELATIONS_PROMPT,
  ISSUE_TITLE_PROMPT,
} from "@/lib/issues/ai-issue-assist"
import { TERMINAL_COMPLETION_PROMPT } from "@/lib/terminal/completion/prompt"
import { AI_SHELL_PLAN_PROMPT } from "@/lib/terminal/ai-shell/plan-generator"
import { AI_SHELL_ERROR_ADVISOR_PROMPT } from "@/lib/terminal/ai-shell/error-advisor"
import {
  ENTITY_MERGE_AGENT_PROMPT,
  EVALUATOR_PROMPT,
  KNOWLEDGE_AGENT_PROMPT,
  PLAYBOOK_AGENT_PROMPT,
  STYLE_AGENT_PROMPT,
  SYNTHESIZER_PROMPT,
} from "@/lib/twin/distill/prompts"
import { WIKI_SYSTEM_VOICE_PROMPT } from "@/lib/wiki/prompts"
import {
  COMPACT_HANDOFF_PROMPT,
  POST_COMPACTION_RECOVERY_PROMPT,
} from "@/lib/claude/compact-instructions"
import {
  PLAN_DECOMPOSE_PROMPT,
  PLAN_DECOMPOSE_REQUEST_PROMPT,
  PLAN_REFINE_PROMPT,
  PLAN_REFINE_REQUEST_PROMPT,
} from "@/lib/agent/plan/planner"
import { PLAN_STEP_MESSAGE_PROMPT, PLAN_SYSTEM_SECTION_PROMPT } from "@/lib/agent/plan/prompts"
import {
  VERIFICATION_REQUEST_PROMPT,
  VERIFIER_PROMPT,
} from "@/lib/agent/composition/verified-fresh-agent"
import { SUBAGENT_CONTRACT_PROMPT } from "@/lib/agent/prompts/subagent-frame"
import { EXECUTOR_FALLBACK_PROMPT } from "@/lib/agent/prompts/executor"
import { COUNCIL_SYNTHESIS_PROMPT } from "@/lib/ai/council/run-council"
import {
  TEMPLATE_ASSIST_GENERATE_PROMPT,
  TEMPLATE_ASSIST_IMPROVE_PROMPT,
  TEMPLATE_ASSIST_SUGGEST_PARAMS_PROMPT,
} from "@/lib/ai/generation/template-assist"
import { TURN_LABEL_PROMPT } from "@/lib/ai/generation/turn-label"
import { VISUAL_OUTPUT_PROMPTS } from "@/lib/ai/prompts/visual-output-prompts"
import { LLM_RERANK_REQUEST_PROMPT, LLM_RERANK_SYSTEM_PROMPT } from "@/lib/twin/runtime/reranker"
import { TWIN_SYSTEM_TEMPLATE_PROMPTS } from "@/lib/twin/runtime/system-prompt-template"
import {
  RUN_RETROSPECTIVE_PROMPT,
  RUN_RETROSPECTIVE_REPLY_FORMAT_PROMPT,
} from "@/lib/execution/run-retrospective"
import {
  CREATOR_PLAN_PROMPT,
  CREATOR_REVIEW_PROMPT,
  CREATOR_SURVEY_PROMPT,
} from "@/lib/creator/agent-ports"
import { CONNECTOR_CAPABILITY_PROMPTS } from "@/lib/connectors/a2ui-bridge/capability-evaluator"
import {
  SELECTION_EXPLAIN_PROMPT,
  SELECTION_TRANSLATE_PROMPT,
} from "@/lib/chat/selection/run-selection-action"
import { REMOVE_BACKGROUND_PROMPT } from "@/lib/chat/image-edit/prompts"
import { SESSION_PEER_FRAME_PROMPT } from "@/lib/chat/session-peer-delivery"
import {
  COMMIT_AGENT_CLAUSE_PROMPT,
  COMMIT_CONVENTIONAL_FORMAT_PROMPT,
  COMMIT_FREEFORM_FORMAT_PROMPT,
  COMMIT_SYSTEM_PROMPT,
} from "@/lib/git/ai-commit"
import { DIFF_EXPLAIN_PROMPT } from "@/lib/git/ai-explain"
import { CHILDREN_DONE_INSTRUCTION_PROMPT } from "@/lib/issues/wakeups/model"
import { BOOTSTRAP_SYSTEM_PROMPTS } from "@/lib/project-environment/bootstrap-prompts"
import { LOOP_ITERATION_PROMPT } from "@/lib/loop/prompts"
import { A2UI_PROTOCOL_PROMPT } from "@/lib/a2ui/prompts"
import { A2UI_CREATE_APP_PROMPT, A2UI_EDIT_APP_PROMPT } from "@/lib/a2ui/generate-prompts"
import { EXECUTION_ENHANCE_PROMPT } from "@/lib/a2ui/from-execution/enhance"
import { CANVAS_REVIEW_PROMPT, CANVAS_SUGGESTIONS_PROMPT } from "@/lib/canvas/ai/suggestion-prompts"
import {
  PLAN_APPROVED_EDITED_PROMPT,
  PLAN_APPROVED_PROMPT,
} from "@/lib/agent/plan/approval-prompts"
import {
  EPISODIC_DISTILL_REQUEST_PROMPT,
  EPISODIC_DISTILL_SYSTEM_PROMPT,
} from "@/lib/memory/write/run-episodic-distill"
import {
  REPLY_COPILOT_DRAFT_PROMPT,
  REPLY_COPILOT_DRAFT_REQUEST_PROMPT,
  REPLY_COPILOT_UNATTRIBUTED_NOTE_PROMPT,
} from "@/lib/reply-copilot/draft-candidates"
import { COPILOT_QUESTION_PROMPTS } from "@/lib/reply-copilot/questions"
import { FETCH_EXTRACT_PROMPT } from "@/lib/web/web-tools-core"
import { READER_DISTILL_PROMPT } from "@/lib/web/reader/configured-reader"
import {
  SKILL_AI_INTENT_PROMPTS,
  SKILL_AI_REQUEST_PROMPT,
  SKILL_AI_SYSTEM_PROMPT,
} from "@/lib/skills/ai-prompts"
import { SKILL_RECORDING_PROMPT } from "@/lib/skills/recording/generation-envelope"
import {
  ENSEMBLE_SYNTHESIZER_PROMPT,
  ENSEMBLE_SYNTHESIZER_REQUEST_PROMPT,
} from "@/lib/workflow/nodes/ai/ai-ensemble"
import { CLASSIFY_NODE_PROMPT, EXTRACT_NODE_PROMPT } from "@/lib/workflow/nodes/ai/executors"
import { JSON_OUTPUT_PROMPT, JSON_OUTPUT_SHAPE_PROMPT } from "@/lib/workflow/nodes/ai/structured"
import { SCHEMA_REPAIR_PROMPT } from "@/lib/workflow/nodes/ai/schema-validate"
import { WORKFLOW_COPILOT_PROMPT } from "@/lib/workflow/editor/copilot-prompts"
import { WORKFLOW_QUICK_ACTION_PROMPTS } from "@/lib/workflow/editor/quick-action-prompts"
import { WORKFLOW_SLASH_PROMPTS } from "@/lib/slash-commands/actions/workflow"
import {
  CLI_BASH_ANALYSIS_PROMPT,
  CLI_COMMIT_MESSAGE_PROMPT,
  CLI_FIX_TESTS_PROMPT,
  CLI_HANDOFF_PROMPT,
  CLI_INIT_REWRITE_PROMPT,
  CLI_OCR_VISION_PROMPT,
  CLI_OUTPUT_STYLE_PROMPTS,
  CLI_PLAN_REFINE_PROMPT,
  CLI_PR_SUMMARY_PROMPT,
  CLI_REVIEW_PROMPT,
} from "@/lib/agent/prompts/cli-prompts"
import { RAG_HYDE_PROMPT, RAG_STEP_BACK_PROMPT } from "@/lib/ai/retrieval/expansion-prompts"
import { MEMORY_RERANK_PROMPT } from "@/lib/memory/runtime/rerank-prompt"
import {
  MEMORY_CONSOLIDATE_PROMPT,
  MEMORY_EXTRACT_PROMPT,
} from "@/lib/memory/write/run-memory-extraction"
import { MEMORY_PROJECT_EXTRACT_PROMPT } from "@/lib/memory/write/run-project-mining"
import { STANDALONE_SEARCH_ANSWER_PROMPT } from "@/lib/search/standalone-answer-prompt"
import { MODULE_PROMPTS } from "@/lib/modules/generated/prompts"
import type { ModulePromptsEntry } from "@/lib/modules/manifest-types"
import { getPluginPromptEntry, listPluginPromptEntries } from "./plugin-prompts"
import type { PromptDefinitionV1 } from "./types"

export const PROMPT_DEFINITIONS: readonly PromptDefinitionV1[] = [
  // chat
  BRIEF_MODE_PROMPT,
  COMPACT_HANDOFF_PROMPT,
  POST_COMPACTION_RECOVERY_PROMPT,
  CLI_BASE_IDENTITY_PROMPT,
  ASIDE_SYSTEM_PROMPT,
  ASIDE_READ_ONLY_PROMPT,
  ...VISUAL_OUTPUT_PROMPTS,
  ...Object.values(CONNECTOR_CAPABILITY_PROMPTS),
  SELECTION_EXPLAIN_PROMPT,
  SELECTION_TRANSLATE_PROMPT,
  SESSION_PEER_FRAME_PROMPT,
  A2UI_PROTOCOL_PROMPT,
  REPLY_COPILOT_DRAFT_PROMPT,
  REPLY_COPILOT_UNATTRIBUTED_NOTE_PROMPT,
  REPLY_COPILOT_DRAFT_REQUEST_PROMPT,
  ...Object.values(COPILOT_QUESTION_PROMPTS.full),
  ...Object.values(COPILOT_QUESTION_PROMPTS.compact),
  ...Object.values(CLI_OUTPUT_STYLE_PROMPTS),
  CLI_HANDOFF_PROMPT,
  // agents
  ...builtinAgents().map((entry) => entry.identity),
  ...BUILT_IN_MODE_PROMPTS.values(),
  PLAN_MODE_PROMPT,
  PLAN_MODE_STRUCTURED_STEPS_PROMPT,
  PLAN_DECOMPOSE_PROMPT,
  PLAN_DECOMPOSE_REQUEST_PROMPT,
  PLAN_REFINE_PROMPT,
  PLAN_REFINE_REQUEST_PROMPT,
  PLAN_SYSTEM_SECTION_PROMPT,
  PLAN_STEP_MESSAGE_PROMPT,
  VERIFIER_PROMPT,
  VERIFICATION_REQUEST_PROMPT,
  SUBAGENT_CONTRACT_PROMPT,
  EXECUTOR_FALLBACK_PROMPT,
  RUN_RETROSPECTIVE_PROMPT,
  RUN_RETROSPECTIVE_REPLY_FORMAT_PROMPT,
  PLAN_APPROVED_PROMPT,
  PLAN_APPROVED_EDITED_PROMPT,
  LOOP_ITERATION_PROMPT,
  CLI_PLAN_REFINE_PROMPT,
  // generation
  TITLE_CHAT_PROMPT,
  TITLE_WORK_PROMPT,
  CONVERSATION_SUMMARY_PROMPT,
  SELECTION_SUMMARY_PROMPT,
  COUNCIL_SYNTHESIS_PROMPT,
  TEMPLATE_ASSIST_GENERATE_PROMPT,
  TEMPLATE_ASSIST_IMPROVE_PROMPT,
  TEMPLATE_ASSIST_SUGGEST_PARAMS_PROMPT,
  TURN_LABEL_PROMPT,
  ...Object.values(CANVAS_ACTION_PROMPTS),
  CANVAS_SUGGESTIONS_PROMPT,
  CANVAS_REVIEW_PROMPT,
  REMOVE_BACKGROUND_PROMPT,
  A2UI_CREATE_APP_PROMPT,
  A2UI_EDIT_APP_PROMPT,
  EXECUTION_ENHANCE_PROMPT,
  // completion
  GHOST_TEXT_PROMPT,
  STARTER_SUGGESTIONS_PROMPT,
  FOLLOW_UP_SUGGESTIONS_PROMPT,
  ENHANCE_SYSTEM_PROMPT,
  ...Object.values(ENHANCE_STYLE_PROMPTS),
  TERMINAL_COMPLETION_PROMPT,
  // twin
  STYLE_AGENT_PROMPT,
  PLAYBOOK_AGENT_PROMPT,
  KNOWLEDGE_AGENT_PROMPT,
  SYNTHESIZER_PROMPT,
  EVALUATOR_PROMPT,
  ENTITY_MERGE_AGENT_PROMPT,
  LLM_RERANK_SYSTEM_PROMPT,
  LLM_RERANK_REQUEST_PROMPT,
  ...Object.values(TWIN_SYSTEM_TEMPLATE_PROMPTS),
  // knowledge
  WIKI_SYSTEM_VOICE_PROMPT,
  EPISODIC_DISTILL_SYSTEM_PROMPT,
  EPISODIC_DISTILL_REQUEST_PROMPT,
  MEMORY_EXTRACT_PROMPT,
  MEMORY_PROJECT_EXTRACT_PROMPT,
  MEMORY_CONSOLIDATE_PROMPT,
  MEMORY_RERANK_PROMPT,
  FETCH_EXTRACT_PROMPT,
  READER_DISTILL_PROMPT,
  STANDALONE_SEARCH_ANSWER_PROMPT,
  RAG_HYDE_PROMPT,
  RAG_STEP_BACK_PROMPT,
  CLI_OCR_VISION_PROMPT,
  // developer
  AI_SHELL_PLAN_PROMPT,
  AI_SHELL_ERROR_ADVISOR_PROMPT,
  DIFF_REVIEW_PROMPT,
  CREATOR_SURVEY_PROMPT,
  CREATOR_PLAN_PROMPT,
  CREATOR_REVIEW_PROMPT,
  ISSUE_DRAFT_PROMPT,
  ISSUE_IMPROVE_PROMPT,
  ISSUE_METADATA_PROMPT,
  ISSUE_TITLE_PROMPT,
  ISSUE_RELATIONS_PROMPT,
  CHILDREN_DONE_INSTRUCTION_PROMPT,
  COMMIT_SYSTEM_PROMPT,
  COMMIT_CONVENTIONAL_FORMAT_PROMPT,
  COMMIT_FREEFORM_FORMAT_PROMPT,
  COMMIT_AGENT_CLAUSE_PROMPT,
  DIFF_EXPLAIN_PROMPT,
  SKILL_AI_SYSTEM_PROMPT,
  ...Object.values(SKILL_AI_INTENT_PROMPTS),
  SKILL_AI_REQUEST_PROMPT,
  SKILL_RECORDING_PROMPT,
  ENSEMBLE_SYNTHESIZER_PROMPT,
  ENSEMBLE_SYNTHESIZER_REQUEST_PROMPT,
  CLASSIFY_NODE_PROMPT,
  EXTRACT_NODE_PROMPT,
  JSON_OUTPUT_PROMPT,
  JSON_OUTPUT_SHAPE_PROMPT,
  SCHEMA_REPAIR_PROMPT,
  WORKFLOW_COPILOT_PROMPT,
  ...Object.values(WORKFLOW_QUICK_ACTION_PROMPTS),
  ...Object.values(WORKFLOW_SLASH_PROMPTS),
  CLI_COMMIT_MESSAGE_PROMPT,
  CLI_PR_SUMMARY_PROMPT,
  CLI_FIX_TESTS_PROMPT,
  CLI_INIT_REWRITE_PROMPT,
  CLI_BASH_ANALYSIS_PROMPT,
  CLI_REVIEW_PROMPT,
  ...Object.values(BOOTSTRAP_SYSTEM_PROMPTS),
  // permissions
  COMMAND_JUDGE_PROMPT,
  // routing
  DIFFICULTY_JUDGE_PROMPT,
  ...Object.values(ROUTER_FUSION_ROLE_PROMPTS),
]

const BY_ID = new Map<string, PromptDefinitionV1>()
for (const def of PROMPT_DEFINITIONS) {
  if (BY_ID.has(def.id)) throw new Error(`duplicate prompt definition id: ${def.id}`)
  BY_ID.set(def.id, def)
}

/** Each module's contributed definitions, once its `prompts` file has loaded. */
const MODULE_DEFINITIONS = new Map<string, readonly PromptDefinitionV1[]>()
const MODULE_BY_ID = new Map<string, PromptDefinitionV1>()
const moduleLoads = new Map<string, Promise<void>>()

/** A module whose prompts did not join the catalog, and why. */
export interface PromptCatalogFailure {
  module: string
  error: unknown
}

async function loadModulePrompts(entry: ModulePromptsEntry): Promise<void> {
  const { prompts } = await entry.load()
  const ids = new Set<string>()
  for (const def of prompts) {
    const taken = BY_ID.has(def.id) || MODULE_BY_ID.has(def.id) || ids.has(def.id)
    if (taken) throw new Error(`duplicate prompt definition id: ${def.id}`)
    ids.add(def.id)
  }
  MODULE_DEFINITIONS.set(entry.module, prompts)
  for (const def of prompts) MODULE_BY_ID.set(def.id, def)
}

/**
 * Load the prompts every active module contributes (an `experimental` one
 * contributes none), in module id order. A module already loaded is not
 * loaded again, and concurrent calls share one load. A module whose file does
 * not load, or that repeats a taken id, is reported (and warned about) and
 * contributes nothing; the others still join, and the next call retries it.
 */
export async function loadPromptCatalog(
  entries: readonly ModulePromptsEntry[] = MODULE_PROMPTS
): Promise<{ failures: PromptCatalogFailure[] }> {
  const active = entries.filter((entry) => entry.stage !== "experimental")
  const settled = await Promise.allSettled(
    active.map((entry) => {
      if (MODULE_DEFINITIONS.has(entry.module)) return Promise.resolve()
      let load = moduleLoads.get(entry.module)
      if (!load) {
        load = loadModulePrompts(entry).finally(() => moduleLoads.delete(entry.module))
        moduleLoads.set(entry.module, load)
      }
      return load
    })
  )
  const failures: PromptCatalogFailure[] = []
  settled.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") return
    const failure = { module: active[index].module, error: outcome.reason }
    console.warn(`prompt catalog: module "${failure.module}" contributed no prompts`, failure.error)
    failures.push(failure)
  })
  return { failures }
}

/** Test helper: forget every module's contributed prompts. */
export function __resetModulePromptsForTests(): void {
  MODULE_DEFINITIONS.clear()
  MODULE_BY_ID.clear()
  moduleLoads.clear()
}

/** Module definitions loaded so far, in module id order. */
function moduleDefinitions(): PromptDefinitionV1[] {
  return [...MODULE_DEFINITIONS.keys()]
    .sort((a, b) => a.localeCompare(b))
    .flatMap((module) => MODULE_DEFINITIONS.get(module) ?? [])
}

/**
 * A shipped definition, one a module contributed (once `loadPromptCatalog()`
 * has loaded it), or the slot an enabled plugin registered under `plugin:<id>/…`.
 */
export function getPromptDefinition(id: string): PromptDefinitionV1 | undefined {
  return BY_ID.get(id) ?? MODULE_BY_ID.get(id) ?? getPluginPromptEntry(id)?.def
}

/** Shipped definitions, those modules contributed, then those of the plugins enabled right now. */
export function listPromptDefinitions(): readonly PromptDefinitionV1[] {
  const modules = moduleDefinitions()
  const plugin = listPluginPromptEntries()
  return modules.length === 0 && plugin.length === 0
    ? PROMPT_DEFINITIONS
    : [...PROMPT_DEFINITIONS, ...modules, ...plugin.map((entry) => entry.def)]
}
