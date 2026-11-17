"use client"

import type { ComposerInnerProps } from "../../composer"
import { usePluginSlashCommands } from "@/hooks/chat/use-plugin-slash-commands"
import { BUILTIN_SLASH_COMMANDS, type SlashCommand } from "@/lib/slash-commands/builtin"
import { mergeSlashCommands } from "@/lib/slash-commands/merge"
import { type useTranslations } from "next-intl"
import { useCallback, useMemo } from "react"

export interface ComposerSlashCommandsInput {
  customCommands: SlashCommand[]
  tBestOfN: ReturnType<typeof useTranslations<"bestOfNEntry">>
  props: Pick<ComposerInnerProps, "session">
}

/**
 * The `/` picker's commands (built-in, workspace and plugin, deduped) and the
 * name map submit-time dispatch resolves against.
 */
export function useComposerSlashCommands(input: ComposerSlashCommandsInput) {
  const { customCommands, tBestOfN, props } = input

  // Plugin-contributed slash commands (registered in the unified registry but
  // historically never surfaced in the chat `/` picker). Reactive: a plugin
  // enabling/disabling adds/removes its commands live.
  const pluginCommands = usePluginSlashCommands()

  const isAside = props.session?.kind === "resource-workbench"
  const slashCommands = useMemo(
    // Deduped by name — `record-skill` is declared by both the builtin table
    // and the skill-recorder plugin; the picker keys rows `slash-${name}`, so
    // an undeduped merge rendered duplicate React keys (and two identical
    // rows). Last-wins matches `commandMap`'s submit-time precedence below.
    () =>
      mergeSlashCommands(BUILTIN_SLASH_COMMANDS, customCommands, pluginCommands)
        .map((command) =>
          command.name === "best-of-n"
            ? { ...command, description: tBestOfN("description") }
            : command
        )
        .filter((command) => !isAside || !["btw", "side"].includes(command.name)),
    [customCommands, pluginCommands, isAside, tBestOfN]
  )

  // Name → command map for submit-time multi-command dispatch. Built from the
  // UNFILTERED list (includes `hiddenFromPicker` commands) so a typed command
  // still resolves even when it's not shown in the picker.
  const commandMap = useMemo(
    () =>
      new Map(
        [...BUILTIN_SLASH_COMMANDS, ...customCommands, ...pluginCommands]
          .filter((command) => !isAside || !["btw", "side"].includes(command.name))
          .map((c) => [c.name, c])
      ),
    [customCommands, pluginCommands, isAside]
  )
  // Name → provenance for the chip overlay's pill tint. A callback (not the
  // map) so the overlay never holds the command objects, only the answer.
  const commandScope = useCallback((name: string) => commandMap.get(name)?.scope, [commandMap])
  return { commandMap, slashCommands, commandScope }
}
