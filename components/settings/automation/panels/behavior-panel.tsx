"use client"

/**
 * UI Automation → Behavior: how the engine looks at and types into the screen.
 *
 * The screen-off block sits here, not on the overview, because it changes how
 * capture works rather than whether automation is healthy. It only renders on a
 * platform with a screen-off backend (`screenOffSupported`); elsewhere a whole
 * block existed only to say "Windows only".
 */

import { SettingsStack } from "@/components/settings/common/settings-block"
import { screenOffSupported } from "@/lib/automation/screen-off-support"
import type { Capabilities } from "@/lib/automation/types"

import { BehaviorCard } from "../behavior-card"
import { ScreenOffCard } from "../screen-off-card"

export interface BehaviorPanelProps {
  /** `undefined` while the capability probe runs, `null` when it failed. */
  caps: Capabilities | null | undefined
}

export function BehaviorPanel({ caps }: BehaviorPanelProps) {
  return (
    <SettingsStack>
      <BehaviorCard />
      {caps && screenOffSupported(caps.platform) ? (
        <ScreenOffCard platform={caps.platform} />
      ) : null}
    </SettingsStack>
  )
}
