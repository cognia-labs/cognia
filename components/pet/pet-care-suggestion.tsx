// "Most needed now": the one line the console's Home and the desktop popup
// open on, naming the pet's lowest need and offering the care that answers it
// as the primary button. When every need is comfortable it says so instead, so
// the reader knows there is nothing to catch up on.
//
// The choice is `suggestPetCare` (pure, ranked from the controller's own
// effect table); this file only draws it. The button runs the same care
// callback as the action grid below it and reads the same cooldown, so the two
// never disagree about what can run.

"use client"

import { useTranslations } from "next-intl"
import { CheckCircle2Icon, SparklesIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useActionCooldown } from "@/hooks/pet/use-action-cooldown"
import { suggestPetCare, type PetCareTone } from "@/lib/pet/care/suggest-care"
import type { PetInteractionKind } from "@/lib/pet/needs/decay"
import type { PetNeeds } from "@/types/pet"
import { cn } from "@/lib/utils"

/** The visible label of each suggestable care action (`pet.actions.*`). */
const ACTION_LABEL_KEYS: Record<PetInteractionKind, string> = {
  fed: "actions.feed",
  played: "actions.play",
  petted: "actions.pet",
  talked: "actions.talk",
  slept: "actions.sleep",
  cleaned: "actions.clean",
  treated: "actions.treat",
}

const TONE_CLASS: Record<PetCareTone, string> = {
  urgent: "text-destructive",
  attention: "text-foreground",
  suggest: "text-muted-foreground",
}

export interface PetCareSuggestionProps {
  needs: Pick<PetNeeds, "energy" | "mood" | "bond">
  /** Run a care action (the same callback the action grid uses). */
  onCare: (kind: PetInteractionKind) => void
  /** The pet's name, for the content line. */
  petName?: string
  /**
   * Remaining cooldown per kind when the caller owns it (remote care ages the
   * desktop's cooldowns). Omitted, this device's own gate is read.
   */
  cooldownRemaining?: (kind: string) => number
  /** `comfortable` for the console, `compact` for the popup. */
  size?: "comfortable" | "compact"
  className?: string
}

export function PetCareSuggestion({
  needs,
  onCare,
  petName,
  cooldownRemaining,
  size = "comfortable",
  className,
}: PetCareSuggestionProps) {
  const t = useTranslations("pet")
  const local = useActionCooldown()
  const suggestion = suggestPetCare(needs, cooldownRemaining ?? local.remaining)
  const compact = size === "compact"

  if (suggestion.status === "content") {
    return (
      <div
        data-testid="pet-care-suggestion"
        data-status="content"
        role="status"
        className={cn(
          "flex min-w-0 items-center gap-2 text-muted-foreground",
          compact ? "text-xs" : "text-sm",
          className
        )}
      >
        <CheckCircle2Icon className="size-4 shrink-0 text-primary" aria-hidden />
        <span className="min-w-0 text-pretty">
          {petName ? t("console.home.content", { name: petName }) : t("console.home.contentNoName")}
        </span>
      </div>
    )
  }

  const needLabel = t(`needs.${suggestion.need}`)
  const actionLabel = t(ACTION_LABEL_KEYS[suggestion.action])
  const cooling = suggestion.cooldownMs > 0

  return (
    <div
      data-testid="pet-care-suggestion"
      data-status="needs"
      data-need={suggestion.need}
      data-tone={suggestion.tone}
      className={cn("flex min-w-0 items-center gap-3", className)}
    >
      <SparklesIcon className={cn("size-4 shrink-0", TONE_CLASS[suggestion.tone])} aria-hidden />
      <p className={cn("min-w-0 flex-1 text-pretty", compact ? "text-xs" : "text-sm")}>
        <span className="text-muted-foreground">{t("console.home.mostNeeded")}</span>{" "}
        <span className={cn("font-medium", TONE_CLASS[suggestion.tone])}>
          {t("console.home.needValue", { need: needLabel, value: suggestion.value })}
        </span>
      </p>
      <Button
        type="button"
        size={compact ? "sm" : "default"}
        data-testid="pet-care-suggestion-action"
        data-action={suggestion.action}
        disabled={cooling}
        className={cn("shrink-0", !compact && "min-h-11 px-5")}
        onClick={() => onCare(suggestion.action)}
      >
        {cooling
          ? t("console.home.cooling", {
              action: actionLabel,
              seconds: Math.ceil(suggestion.cooldownMs / 1000),
            })
          : actionLabel}
      </Button>
    </div>
  )
}
