"use client"

// Settings → Pet, a pointer: the pet's settings live on the pet page, under
// Appearance & settings (`/pet?view=appearance`), beside the pet they change.
//
// It used to render the whole customization workspace a second time, so the
// same switches had two homes and the console's own page felt optional. The
// section stays in the nav and in settings search (its keywords are
// unchanged), so looking for "pet" in Settings still lands somewhere that says
// where to go, in one click.

import Link from "next/link"
import { useTranslations } from "next-intl"
import { ArrowRightIcon, PawPrintIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SettingsBlock, SettingsStack } from "@/components/settings/common/settings-block"
import { petConsoleHref } from "@/lib/pet/console-tabs"

export function PetSection() {
  const t = useTranslations("settings.pet.pointer")
  return (
    <SettingsStack>
      <SettingsBlock
        testid="settings-pet-pointer"
        icon={<PawPrintIcon />}
        title={t("title")}
        description={t("description")}
        action={
          <Button asChild size="sm" data-testid="settings-pet-open-appearance">
            <Link href={petConsoleHref("appearance")}>
              {t("action")}
              <ArrowRightIcon className="size-3.5" aria-hidden />
            </Link>
          </Button>
        }
      >
        <ul className="ms-6 list-disc space-y-1 text-xs text-muted-foreground">
          <li>{t("covers.look")}</li>
          <li>{t("covers.desktop")}</li>
          <li>{t("covers.behavior")}</li>
          <li>{t("covers.characters")}</li>
        </ul>
      </SettingsBlock>
    </SettingsStack>
  )
}
