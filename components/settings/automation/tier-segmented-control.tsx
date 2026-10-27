"use client"

/**
 * A single-choice segmented control for an automation tier (or any small set
 * of mutually exclusive values next to it).
 *
 * Replaces three free-standing buttons that read as three actions rather than
 * one choice. Radix's single toggle group lets the user deselect the pressed
 * item, which would hand the caller an empty string; that is swallowed here so
 * a policy can never be written as "".
 */

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"

export interface SegmentOption<V extends string> {
  value: V
  label: string
}

export interface TierSegmentedControlProps<V extends string> {
  /** `null` renders with nothing pressed, for a stored value no option names. */
  value: V | null
  options: readonly SegmentOption<V>[]
  onChange: (value: V) => void
  ariaLabel: string
  disabled?: boolean
  className?: string
  testid?: string
}

export function TierSegmentedControl<V extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  className,
  testid,
}: TierSegmentedControlProps<V>) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      aria-label={ariaLabel}
      value={value ?? ""}
      disabled={disabled}
      className={cn("max-w-full flex-wrap", className)}
      data-testid={testid}
      onValueChange={(next) => {
        const match = options.find((option) => option.value === next)
        if (match && match.value !== value) onChange(match.value)
      }}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          className="text-xs data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
          data-testid={testid ? `${testid}-${option.value}` : undefined}
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
