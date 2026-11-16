// Permission-mode values offered by the settings pickers (general, characters,
// presets/preset-editor). Labels are sourced from i18n
// (`settings.general.permission.*`).

import type { AppSettings } from "@cognia/agent-config-types"

// Mirrors the Claude Agent SDK's `PermissionMode` union (sdk 0.3.x:
// 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto').
// `dontAsk` denies anything not pre-approved without prompting; `auto` uses the
// SDK's model classifier to approve/deny permission prompts.
export const PERMISSION_MODE_VALUES: NonNullable<AppSettings["permissionMode"]>[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
  "auto",
]

export type PermissionModeValue = (typeof PERMISSION_MODE_VALUES)[number]
