"use client"

/**
 * "New Squad": the one way to make a Squad on `/squads`.
 *
 * The page used to offer two sibling buttons, "New Squad" and "Compose from an
 * objective", and the first of them created an empty Squad on the spot, named
 * "New Squad" with a lead and nobody to lead, then left the reader to find
 * Settings to staff it. Neither button said which was the better start, and
 * the third way, a template, lived only in Settings.
 *
 * Now the header has a single verb and this dialog names the three starts, most
 * useful first:
 *
 *  - Compose from an objective hands over to `AutoComposeDialog`, which
 *    proposes the roster. This dialog closes first: one modal at a time.
 *  - Start from a template lists the same templates, in the same order, that
 *    the Settings library does (`useSquadTemplates`), and creates through the
 *    template platform so the Squad records where it came from.
 *  - Blank Squad is the old one-click create.
 *
 * Whichever start is picked, the host is told the new Squad's id and opens it
 * with its edit drawer, so the next step (naming it, staffing it) is already on
 * screen instead of a page away.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  LayoutTemplateIcon,
  PlusIcon,
  SparklesIcon,
  type LucideIcon,
} from "lucide-react"

import { AgentTeamAvatar } from "@/components/agent/workspace/agent-team-avatar"
import { AutoComposeDialog } from "@/components/agent/workspace/auto-compose-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Empty, EmptyDescription } from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { toast } from "@/components/ui/sonner"
import { useCreateSquad } from "@/hooks/squads/use-create-squad"
import { useApplySquadTemplate, useSquadTemplates } from "@/hooks/squads/use-squad-templates"
import { cn } from "@/lib/utils"

type Step = "choose" | "templates"

export interface CreateSquadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The new Squad's id, whichever way it was made. */
  onCreated: (squadId: string) => void
}

export function CreateSquadDialog({ open, onOpenChange, onCreated }: CreateSquadDialogProps) {
  const t = useTranslations("squads.create")
  const tFleet = useTranslations("squads.fleet")
  const createSquad = useCreateSquad()
  const templates = useSquadTemplates()
  const applyTemplate = useApplySquadTemplate()
  const [step, setStep] = useState<Step>("choose")
  const [composeOpen, setComposeOpen] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  // Reopening starts from the three choices, not from wherever it was closed.
  const setOpen = useCallback(
    (next: boolean) => {
      if (!next) setStep("choose")
      onOpenChange(next)
    },
    [onOpenChange]
  )

  const finish = useCallback(
    (squadId: string) => {
      setOpen(false)
      onCreated(squadId)
    },
    [onCreated, setOpen]
  )

  const run = useCallback(
    async (id: string, create: () => Promise<string>) => {
      setBusyId(id)
      try {
        finish(await create())
      } catch (error) {
        toast.error(t("failed"), {
          description: error instanceof Error ? error.message : String(error),
        })
      } finally {
        setBusyId(null)
      }
    },
    [finish, t]
  )

  const onBlank = () =>
    void run("blank", async () => {
      const squad = await createSquad({
        name: tFleet("newSquadName"),
        leadName: tFleet("defaultLeadName"),
      })
      return squad.id
    })

  const onCompose = () => {
    setOpen(false)
    setComposeOpen(true)
  }

  const busy = busyId !== null

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="flex max-h-[85vh] flex-col gap-4 sm:max-w-lg"
          data-testid="squad-create-dialog"
        >
          {step === "choose" ? (
            <>
              <DialogHeader>
                <DialogTitle>{t("title")}</DialogTitle>
                <DialogDescription>{t("description")}</DialogDescription>
              </DialogHeader>
              <div className="grid gap-2">
                <StartOption
                  id="compose"
                  icon={SparklesIcon}
                  title={t("options.compose.title")}
                  description={t("options.compose.description")}
                  badge={t("recommended")}
                  disabled={busy}
                  onSelect={onCompose}
                />
                <StartOption
                  id="template"
                  icon={LayoutTemplateIcon}
                  title={t("options.template.title")}
                  description={t("options.template.description")}
                  disabled={busy}
                  onSelect={() => setStep("templates")}
                />
                <StartOption
                  id="blank"
                  icon={PlusIcon}
                  title={t("options.blank.title")}
                  description={t("options.blank.description")}
                  disabled={busy}
                  onSelect={onBlank}
                />
              </div>
            </>
          ) : (
            <>
              <DialogHeader className="flex-row items-start gap-2 space-y-0">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="-ml-2 size-8 shrink-0"
                  onClick={() => setStep("choose")}
                  aria-label={t("templates.back")}
                  data-testid="squad-create-back"
                >
                  <ArrowLeftIcon aria-hidden className="size-4" />
                </Button>
                <div className="min-w-0 space-y-1.5 text-left">
                  <DialogTitle>{t("templates.title")}</DialogTitle>
                  <DialogDescription>{t("templates.description")}</DialogDescription>
                </div>
              </DialogHeader>
              {templates.merged.length === 0 ? (
                <Empty className="border-none py-6">
                  <EmptyDescription>{t("templates.empty")}</EmptyDescription>
                </Empty>
              ) : (
                <ScrollArea className="-mx-2 min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
                  <ul className="space-y-0.5 px-2" data-testid="squad-create-templates">
                    {templates.merged.map((template) => {
                      const plugin = templates.pluginIndex.get(template.id)
                      return (
                        <li
                          key={template.id}
                          className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-accent/60"
                          data-testid={`squad-create-template-${template.id}`}
                        >
                          <AgentTeamAvatar subject={template} className="size-9 shrink-0" />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="min-w-0 truncate text-sm font-medium">
                                {template.name}
                              </span>
                              {template.isBuiltIn ? (
                                <Badge variant="secondary" className="shrink-0 text-[10px]">
                                  {t("templates.builtIn")}
                                </Badge>
                              ) : plugin ? (
                                <Badge variant="outline" className="shrink-0 text-[10px]">
                                  {t("templates.plugin")}
                                </Badge>
                              ) : null}
                            </div>
                            <p className="truncate text-xs text-muted-foreground">
                              {tFleet("memberCount", { count: template.teammates.length })}
                              {template.description ? ` · ${template.description}` : ""}
                            </p>
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="shrink-0"
                            disabled={busy}
                            aria-label={t("templates.useAria", { name: template.name })}
                            onClick={() =>
                              void run(template.id, async () => {
                                const result = await applyTemplate(template, plugin?.pluginId)
                                return result.teamId
                              })
                            }
                            data-testid={`squad-create-use-${template.id}`}
                          >
                            {t("templates.use")}
                          </Button>
                        </li>
                      )
                    })}
                  </ul>
                </ScrollArea>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
      <AutoComposeDialog
        open={composeOpen}
        onOpenChange={setComposeOpen}
        onComposed={(teamId) => {
          setComposeOpen(false)
          onCreated(teamId)
        }}
      />
    </>
  )
}

function StartOption({
  id,
  icon: Icon,
  title,
  description,
  badge,
  disabled,
  onSelect,
}: {
  id: string
  icon: LucideIcon
  title: string
  description: string
  badge?: string
  disabled: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      data-testid={`squad-create-${id}`}
      className={cn(
        "group flex w-full items-start gap-3 rounded-lg border px-3.5 py-3 text-left transition-colors",
        "hover:border-foreground/20 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:pointer-events-none disabled:opacity-60"
      )}
    >
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground group-hover:text-foreground">
        <Icon aria-hidden className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-sm font-medium">{title}</span>
          {badge ? (
            <Badge variant="secondary" className="text-[10px]">
              {badge}
            </Badge>
          ) : null}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
      </span>
      <ChevronRightIcon
        aria-hidden
        className="mt-2 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
      />
    </button>
  )
}

export default CreateSquadDialog
