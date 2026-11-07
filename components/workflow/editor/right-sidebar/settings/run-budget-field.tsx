"use client"

/**
 * The run budget input (`WorkflowSettings.maxCostUsd`, playbooks plan WP5).
 * Empty, zero or anything that is not a positive number means no limit. The
 * typed text is kept while it parses to the stored value, so "0." on the way
 * to "0.5" is not wiped; a value changed elsewhere (load, undo) replaces it.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"

import { Input } from "@/components/ui/input"

import { Field } from "../../inspector/forms/shared"

/** The budget a typed value sets; `undefined` = no limit. */
export function parseRunBudget(text: string): number | undefined {
  if (text.trim() === "") return undefined
  const value = Number(text)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

export function RunBudgetField({
  value,
  onChange,
}: {
  value: number | undefined
  onChange: (next: number | undefined) => void
}) {
  const t = useTranslations("workflowEditor.settings.maxCostUsd")
  const [draft, setDraft] = useState(() => (value === undefined ? "" : String(value)))
  const shown = parseRunBudget(draft) === value ? draft : value === undefined ? "" : String(value)

  return (
    <Field label={t("label")} htmlFor="wf-max-cost" hint={t("hint")}>
      <Input
        id="wf-max-cost"
        type="number"
        inputMode="decimal"
        min={0}
        step={0.01}
        placeholder={t("placeholder")}
        value={shown}
        onChange={(event) => {
          setDraft(event.target.value)
          onChange(parseRunBudget(event.target.value))
        }}
        data-testid="wf-max-cost"
      />
    </Field>
  )
}
