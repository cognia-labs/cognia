import { mkdirSync, writeFileSync } from "node:fs"
import {
  PROMPT_DEFINITIONS,
  loadPromptCatalog,
  listPromptDefinitions,
} from "../../lib/prompts/catalog.ts"
import { MODULE_PROMPTS } from "../../lib/modules/generated/prompts.ts"
import { validatePromptBody } from "../../lib/prompts/template.ts"

async function main() {
  const loaded = await loadPromptCatalog()
  const definitions = listPromptDefinitions()
  const count = (key) =>
    Object.fromEntries(
      [...new Set(definitions.map((x) => x[key]))].map((value) => [
        value,
        definitions.filter((x) => x[key] === value).length,
      ])
    )
  const result = {
    core: PROMPT_DEFINITIONS.length,
    total: definitions.length,
    failures: loaded.failures.map((x) => ({ module: x.module, error: String(x.error) })),
    group: count("group"),
    operation: count("operation"),
    risk: count("risk"),
    activation: count("activation"),
    hostCombinations: Object.fromEntries(
      [...new Set(definitions.map((x) => x.hosts.join(",")))].map((value) => [
        value,
        definitions.filter((x) => x.hosts.join(",") === value).length,
      ])
    ),
    modules: await Promise.all(
      MODULE_PROMPTS.map(async (item) => ({
        module: item.module,
        count: (await item.load()).prompts.length,
      }))
    ),
    invalidDefaults: definitions
      .filter((x) => x.operation !== "inspect-only")
      .flatMap((x) => validatePromptBody(x, x.defaultBody).map((issue) => ({ id: x.id, issue }))),
    definitions,
  }
  mkdirSync(".cache/prompts-audit", { recursive: true })
  writeFileSync(".cache/prompts-audit/catalog.json", JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ ...result, definitions: undefined }, null, 2))
}
void main()
