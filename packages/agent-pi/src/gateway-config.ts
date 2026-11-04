import type {
  GatewayRuntimeProfile,
  GatewayLaunchContext,
} from "@cognia/agent-contracts/gateway-task"
import { GATEWAY_TOKEN_ENV, admittedNativeModel } from "@cognia/agent-runtime-kit/gateway-task"
import { piSubagentSupport, piSubagentModelBindings, piModelBinding } from "./subagent-snapshot"
import { isMap, parseDocument } from "yaml"

export const piGatewayProfile: GatewayRuntimeProfile = {
  runtime: "pi",
  traits: { ingress: "openai-chat", continuity: "native-resume" },
  slots: (config) => {
    const plugin = piSubagentSupport(config)
    return plugin
      ? [
          {
            id: "subagent.default",
            kind: "child-default",
            evidence: plugin.family + " v" + plugin.version,
          },
        ]
      : []
  },
  nativeModels: piSubagentModelBindings,

  accepts(config, entry) {
    if (!config.process || config.network?.endpoint || !entry || !["pi"].includes(entry.runtimeId))
      return false
    return (
      Boolean(config.process.command) &&
      entry.protocol === config.protocol &&
      config.transport === "stdio"
    )
  },
  arguments: (_config, _entry) => ({
    values: [
      "--skill",
      "--prompt-template",
      "--system-prompt",
      "--append-system-prompt",
      "--thinking",
      "--extension",
      "-e",
      "--tools",
      "-t",
      "--exclude-tools",
      "-xt",
    ],
    switches: [
      "--no-context-files",
      "-nc",
      "--no-extensions",
      "-ne",
      "--no-skills",
      "-ns",
      "--no-prompt-templates",
      "-np",
      "--no-tools",
      "-nt",
      "--no-builtin-tools",
      "-nbt",
      "--no-approve",
      "-na",
      "--offline",
    ],
  }),
  environment: {},
  project(ctx: GatewayLaunchContext) {
    const { config, binding, model, endpoint, meta, modelPlan } = ctx
    const subagent = modelPlan?.slots["subagent.default"]
    const files: Record<string, string> = {}
    const env: Record<string, string> = {}
    const launchArgs: string[] = []
    let selectedModel: string | undefined = model

    selectedModel = `cognia/${model}`
    const plugin = piSubagentSupport(config)
    const ids = [...new Set([model, ...(modelPlan?.models ?? [])])]
    if (subagent && !plugin)
      throw new Error("Pi child models require a supported installed subagent package")
    const provider = {
      baseUrl: endpoint,
      api: "openai-completions",
      apiKey: `$${GATEWAY_TOKEN_ENV}`,
      models: ids.map((id) => {
        const facts =
          ctx.modelMetadataById?.[id] ?? (id === model ? meta : ctx.modelMetadataFor(id))
        return {
          id,
          name: id,
          ...(facts.contextLength
            ? {
                contextWindow: Math.min(
                  facts.contextLength,
                  facts.maxInputTokens ?? facts.contextLength
                ),
              }
            : {}),
          ...(facts.maxOutputTokens ? { maxTokens: facts.maxOutputTokens } : {}),
          ...(facts.supportsReasoning !== undefined ? { reasoning: facts.supportsReasoning } : {}),
          input: facts.supportsVision ? ["text", "image"] : ["text"],
        }
      }),
    }
    files["pi/models.json"] = JSON.stringify({
      providers: { cognia: provider, ...(plugin ? { [binding.providerId]: provider } : {}) },
    })
    const childDefault = `cognia/${subagent?.modelId ?? modelPlan?.slots["pi.default"]?.modelId ?? model}`
    const overridden: Record<string, string> = {}
    for (const [name, selection] of Object.entries(plugin?.modelOverrides ?? {})) {
      const explicit = piModelBinding(selection, binding)
      if (plugin?.agents[name]?.model !== undefined) continue
      const selector = admittedNativeModel(
        modelPlan,
        `pi.agent.${name}`,
        explicit,
        binding.providerId,
        ids
      )
      overridden[name] = selection === "inherit" ? "inherit" : `cognia/${selector}`
    }
    files["pi/settings.json"] = JSON.stringify({
      defaultProvider: "cognia",
      defaultModel: model,
      enabledModels: ids.map((id) => `cognia/${id}`),
      ...(plugin?.family === "nico"
        ? {
            subagents: {
              defaultModel: childDefault,
              agentOverrides: Object.fromEntries(
                Object.entries(overridden).map(([name, selection]) => [name, { model: selection }])
              ),
              modelScope: {
                enforce: true,
                strict: true,
                allow: ids
                  .map((id) => `cognia/${id}`)
                  .concat(ids.map((id) => `${binding.providerId}/${id}`)),
              },
            },
          }
        : {}),
    })
    if (plugin) {
      const agents: Record<string, string | null> = { ...overridden }
      const sources: Record<string, string> = {}
      for (const [name, definition] of Object.entries(plugin.agents)) {
        agents[name] = null
        const { data, body } = ctx.parseFrontmatter(definition.content)
        let selected: string | undefined
        if (definition.model !== undefined) {
          const explicit = piModelBinding(definition.model, binding)
          const selector = admittedNativeModel(
            modelPlan,
            `pi.agent.${name}`,
            explicit,
            binding.providerId,
            ids
          )
          selected = `cognia/${selector}`
          if (definition.model === "inherit") selected = "inherit"
          agents[name] = selected
        }
        sources[definition.path] = definition.digest
        // Retain scalar/flow styles: Nico's native parser reads flat header
        // lines, so reserializing unrelated lists as block YAML changes tools.
        const header =
          /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(definition.content)?.[1] ?? ""
        const document = parseDocument(header)
        if (isMap(document.contents)) document.contents.flow = false
        if (plugin.family === "nico") {
          document.set("name", name)
          document.set("description", data.description ?? name)
        }
        if (selected !== undefined) document.set("model", selected)
        files[`pi/agents/${name}.md`] = `---\n${document.toString()}---\n${body}\n`
      }
      env.COGNIA_TOOLHOST_PI_SUBAGENT_MODELS = JSON.stringify({
        family: plugin.family,
        packageDir: plugin.packageDir,
        agents,
        sources,
        defaultModel: childDefault,
        allowedModels: ids.map((id) => `cognia/${id}`),
        providerId: binding.providerId,
        cwd: config.process?.cwd,
      })
    }

    return { model: selectedModel, env, files, args: launchArgs }
  },
}
