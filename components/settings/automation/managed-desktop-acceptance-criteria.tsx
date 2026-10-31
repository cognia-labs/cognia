"use client"

import { useId } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  validManagedDesktopCriteria,
  type ManagedDesktopAcceptanceCriterion,
} from "@/lib/automation/managed-desktop-handoff-client"

export function ManagedDesktopAcceptanceCriteria({
  value,
  onChange,
}: {
  value: ManagedDesktopAcceptanceCriterion[]
  onChange: (value: ManagedDesktopAcceptanceCriterion[]) => void
}) {
  const t = useTranslations("managedAcceptance.criteria")
  const id = useId()
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{t("title")}</legend>
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        {t("help")}
      </p>
      {value.map((row, index) => (
        <div key={index} className="space-y-1 rounded border p-2">
          <Label htmlFor={`${id}-${index}`}>{t("description", { number: index + 1 })}</Label>
          <Input
            id={`${id}-${index}`}
            value={row.description}
            aria-describedby={`${id}-help`}
            onChange={(event) =>
              onChange(
                value.map((item, i) =>
                  i === index ? { ...item, description: event.target.value } : item
                )
              )
            }
          />
          <div className="flex items-center gap-2">
            <Checkbox
              id={`${id}-${index}-screenshot`}
              checked={row.screenshotRequired}
              onCheckedChange={(checked) =>
                onChange(
                  value.map((item, i) =>
                    i === index ? { ...item, screenshotRequired: checked === true } : item
                  )
                )
              }
            />
            <Label htmlFor={`${id}-${index}-screenshot`}>
              {t("screenshot", { number: index + 1 })}
            </Label>
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={t("remove", { number: index + 1 })}
            onClick={() => onChange(value.filter((_, i) => i !== index))}
          >
            {t("remove", { number: index + 1 })}
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={value.length >= 50}
        onClick={() => onChange([...value, { description: "", screenshotRequired: false }])}
      >
        {t("add")}
      </Button>
      {!validManagedDesktopCriteria(value) ? (
        <p role="alert" className="text-xs text-destructive">
          {t("invalid")}
        </p>
      ) : null}
    </fieldset>
  )
}
