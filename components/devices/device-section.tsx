"use client"

/**
 * One chapter of the device dashboard.
 *
 * Chapters, not cards: every section here describes the same machine, and a
 * grid of eleven framed panels read as eleven objects, with more border and
 * fill on screen than data. They are now the frameless `sheet` variant (a
 * heading over a hairline rule), so the masthead is the only frame and the
 * sections read as one record under it.
 *
 * The frame itself now lives in `components/surface/console-section.tsx`:
 * nothing about it was device-specific, and `/workspace` was building the same
 * card out of bare `<section>` elements. This file stays as the device-facing
 * name so the `device-section-*` anchors and test ids keep working, and so a
 * caller here cannot forget to pass `pane="device-pane"`.
 *
 * No `wide`: the record is one column of chapters (see `device-detail.tsx`),
 * so every chapter already has the full width, and a span hint would only be
 * a claim nothing honours.
 */

import { ConsoleSection } from "@/components/surface/console-section"

export interface DeviceSectionProps {
  /** Anchor id, also the `data-testid` suffix. */
  id: string
  title: string
  icon?: React.ComponentProps<typeof ConsoleSection>["icon"]
  /** Right-aligned counter or status, kept to a few characters. */
  meta?: React.ReactNode
  /** One line under the title, for a section whose scope is not obvious. */
  description?: string
  children: React.ReactNode
  className?: string
}

export function DeviceSection(props: DeviceSectionProps) {
  return <ConsoleSection {...props} pane="device-pane" idPrefix="device-section" variant="sheet" />
}
