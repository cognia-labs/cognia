"use client"

import { useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import {
  assessContentSafety,
  decideContentSafety,
  type ContentAssessment,
} from "@cognia/content-safety"
import {
  ChevronDownIcon,
  FlaskConicalIcon,
  ImageIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react"

import { useConfirmDialog } from "@/components/shared/confirm-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible"
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu"
import { updateAdapterConfigSection } from "@/lib/db/adapter-instances"
import { getDb } from "@/lib/db/schema"
import { cn } from "@/lib/utils"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type {
  AdapterInstanceRow,
  ImHostCapabilityId,
  MediaModelPolicy,
} from "@/lib/db/connector-types"

const HOST_CAPABILITIES: ImHostCapabilityId[] = [
  "computer_use",
  "ocr",
  "goal_driving",
  "schedule_tools",
]
const SAFETY_REASON_CODES = [
  "instruction_override",
  "system_prompt_extraction",
  "credential_exfiltration",
  "forged_role_boundary",
  "safety_bypass",
] as const

function selectors(row?: AdapterInstanceRow) {
  return row?.builtInSkillCeiling?.join(", ") ?? ""
}

interface PermissionsDraft {
  skills: string
  host: ImHostCapabilityId[]
  injectionProtection: boolean
  hitl: boolean
  mediaPolicy: MediaModelPolicy
}

function draftFromRow(row?: AdapterInstanceRow): PermissionsDraft {
  return {
    skills: selectors(row),
    host: row?.hostCapabilityCeiling ?? HOST_CAPABILITIES,
    injectionProtection: row?.promptInjectionProtection !== false,
    hitl: row?.requireHitlForWrites ?? true,
    // Bot-wide media policy. Hard-coded to `local_extract_only` by all eleven
    // create dialogs and editable nowhere, so `allow_cloud_binary` was
    // unreachable at this scope even though the resolver reads it as the base
    // every conversation grant sits on top of.
    mediaPolicy: row?.mediaModelPolicy ?? "local_extract_only",
  }
}

function sameDraft(left: PermissionsDraft, right: PermissionsDraft) {
  return (
    left.skills.trim() === right.skills.trim() &&
    left.host.length === right.host.length &&
    left.host.every((capability) => right.host.includes(capability)) &&
    left.injectionProtection === right.injectionProtection &&
    left.hitl === right.hitl &&
    left.mediaPolicy === right.mediaPolicy
  )
}

export function AdapterPermissions({ adapterId }: { adapterId: string }) {
  const row = useLiveQuery(
    // `async` so both branches share one `Promise<AdapterInstanceRow | undefined>`.
    // The ternary's mixed `Promise.resolve(undefined)` / `PromiseExtended<...>`
    // union defeated `useLiveQuery`'s unwrapping, so `row` came back as the
    // promise itself.
    async () =>
      typeof window === "undefined" ? undefined : getDb().adapterInstances.get(adapterId),
    [adapterId]
  )
  return (
    <AdapterPermissionsDraft
      key={`${adapterId}:${row?.updatedAt ?? "loading"}`}
      adapterId={adapterId}
      row={row}
    />
  )
}

function PermissionGroup({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon
  title: string
  children: ReactNode
}) {
  return (
    <section className="space-y-4" aria-label={title}>
      <h4 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Icon className="size-3.5" aria-hidden />
        {title}
      </h4>
      {children}
    </section>
  )
}

function SwitchRow({
  id,
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
  children,
}: {
  id: string
  label: string
  description: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  children?: ReactNode
}) {
  return (
    <div className="rounded-lg border px-4 py-3">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0 space-y-1">
          <Label htmlFor={id} className="text-sm font-medium">
            {label}
          </Label>
          <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
        </div>
        <Switch
          id={id}
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={disabled}
          className="mt-0.5 shrink-0"
        />
      </div>
      {children}
    </div>
  )
}

function AdapterPermissionsDraft({
  adapterId,
  row,
}: {
  adapterId: string
  row?: AdapterInstanceRow
}) {
  const t = useTranslations("settings.connections.permissionsEditor")
  const [draft, setDraft] = useState(() => draftFromRow(row))
  const { skills, host, injectionProtection, hitl, mediaPolicy } = draft
  const update = (patch: Partial<PermissionsDraft>) =>
    setDraft((current) => ({ ...current, ...patch }))
  const dirty = !sameDraft(draft, draftFromRow(row))

  const [probeOpen, setProbeOpen] = useState(false)
  const [probeText, setProbeText] = useState("")
  const [probeSource, setProbeSource] = useState<"user" | "external">("user")
  const [probeResult, setProbeResult] = useState<ContentAssessment>()
  const probeDecision = probeResult
    ? decideContentSafety(probeResult, { injectionProtection })
    : undefined
  const clearProbe = () => {
    setProbeText("")
    setProbeResult(undefined)
  }

  const [saving, setSaving] = useState(false)
  const { confirm, dialog: confirmDialog } = useConfirmDialog()

  const hostSummary =
    host.length === HOST_CAPABILITIES.length
      ? t("hostCapabilityAll")
      : host.length === 0
        ? t("hostCapabilityNone")
        : HOST_CAPABILITIES.filter((capability) => host.includes(capability))
            .map((capability) => t(`host.${capability}`))
            .join(", ")

  const save = async () => {
    const confirmed = await confirm({
      title: t("confirmImpactTitle"),
      description: t("confirmImpact"),
      confirmLabel: t("save"),
      testid: "adapter-permissions-confirm",
    })
    if (!confirmed) return
    const parsed = skills
      .split(/[\s,;]+/)
      .map((item) => item.trim())
      .filter(Boolean)
    setSaving(true)
    try {
      await updateAdapterConfigSection(
        adapterId,
        "permissions",
        {
          builtInSkillCeiling: skills.trim() ? parsed : undefined,
          hostCapabilityCeiling: host.length === HOST_CAPABILITIES.length ? undefined : host,
          requireHitlForWrites: hitl,
          mediaModelPolicy: mediaPolicy,
          promptInjectionProtection: injectionProtection,
        },
        "settings.adapter.permissions"
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card data-testid="adapter-permissions" className="gap-0 py-0">
      <CardHeader className="px-5 pt-4 pb-0">
        <CardDescription className="text-xs">{t("intro")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 px-5 py-5">
        <PermissionGroup icon={WrenchIcon} title={t("groups.capabilities")}>
          <FieldGroup className="gap-5">
            <Field className="gap-2">
              <FieldLabel htmlFor="adapter-skill-ceiling">{t("builtInSkills")}</FieldLabel>
              <Input
                id="adapter-skill-ceiling"
                value={skills}
                onChange={(event) => update({ skills: event.target.value })}
                placeholder={t("skillPlaceholder")}
              />
              <FieldDescription className="text-xs">{t("skillHelp")}</FieldDescription>
            </Field>
            <Field className="gap-2">
              <FieldLabel htmlFor="adapter-host-capabilities">{t("hostCapabilities")}</FieldLabel>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    id="adapter-host-capabilities"
                    type="button"
                    variant="outline"
                    className="w-full justify-between font-normal"
                    aria-label={t("hostCapabilities")}
                  >
                    <span className={cn("truncate", host.length === 0 && "text-muted-foreground")}>
                      {hostSummary}
                    </span>
                    <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
                >
                  <DropdownMenuGroup>
                    {HOST_CAPABILITIES.map((capability) => (
                      <DropdownMenuCheckboxItem
                        key={capability}
                        checked={host.includes(capability)}
                        onSelect={(event) => event.preventDefault()}
                        onCheckedChange={(checked) =>
                          setDraft((current) => ({
                            ...current,
                            host: checked
                              ? HOST_CAPABILITIES.filter(
                                  (item) => item === capability || current.host.includes(item)
                                )
                              : current.host.filter((item) => item !== capability),
                          }))
                        }
                      >
                        {t(`host.${capability}`)}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <FieldDescription className="text-xs">{t("hostCapabilitiesHelp")}</FieldDescription>
            </Field>
          </FieldGroup>
        </PermissionGroup>

        <Separator />

        <PermissionGroup icon={ImageIcon} title={t("groups.attachments")}>
          {/* Bot-WIDE, and therefore the blunter of the two controls: a
           * conversation grant is provider-scoped, revocable and expiring, and
           * this is none of those. The warning is not decoration. */}
          <Field className="gap-2">
            <FieldLabel htmlFor="adapter-media-policy">{t("mediaPolicy")}</FieldLabel>
            <Select
              value={mediaPolicy}
              onValueChange={(next) => update({ mediaPolicy: next as MediaModelPolicy })}
            >
              <SelectTrigger id="adapter-media-policy" data-testid="adapter-media-policy">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local_extract_only">{t("mediaPolicyLocal")}</SelectItem>
                <SelectItem value="allow_cloud_binary">{t("mediaPolicyCloud")}</SelectItem>
              </SelectContent>
            </Select>
            <FieldDescription className="text-xs">{t("mediaPolicyHelp")}</FieldDescription>
            {mediaPolicy === "allow_cloud_binary" && (
              <Alert
                variant="destructive"
                className="py-2.5"
                data-testid="adapter-media-policy-warning"
              >
                <TriangleAlertIcon />
                <AlertDescription className="text-xs">{t("mediaPolicyWarning")}</AlertDescription>
              </Alert>
            )}
          </Field>
        </PermissionGroup>

        <Separator />

        <PermissionGroup icon={ShieldCheckIcon} title={t("groups.safety")}>
          <div className="space-y-3">
            <SwitchRow
              id={`adapter-hitl-${adapterId}`}
              label={t("hitl")}
              description={t("hitlHelp")}
              checked={hitl}
              onCheckedChange={(checked) => update({ hitl: checked })}
            />
            <SwitchRow
              id="adapter-injection-protection"
              label={t("injectionProtection")}
              description={t("injectionProtectionHelp")}
              checked={injectionProtection}
              onCheckedChange={(checked) => update({ injectionProtection: checked })}
              disabled={!row || saving}
            >
              <Collapsible
                open={probeOpen}
                onOpenChange={(open) => {
                  setProbeOpen(open)
                  if (!open) clearProbe()
                }}
                className="mt-3 border-t pt-2"
              >
                <CollapsibleTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="-ml-2 h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
                  >
                    <FlaskConicalIcon className="size-3.5" aria-hidden />
                    {t("safetyTest.title")}
                    <ChevronDownIcon
                      className={cn("size-3.5 transition-transform", probeOpen && "rotate-180")}
                      aria-hidden
                    />
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-2">
                  <div className="space-y-4 rounded-md bg-muted/40 p-4">
                    <Field className="gap-2">
                      <FieldLabel id={`safety-source-${adapterId}`} className="text-xs">
                        {t("safetyTest.source")}
                      </FieldLabel>
                      <RadioGroup
                        value={probeSource}
                        onValueChange={(source) => {
                          if (source === "user" || source === "external") {
                            setProbeSource(source)
                            setProbeResult(undefined)
                          }
                        }}
                        aria-labelledby={`safety-source-${adapterId}`}
                        className="flex flex-wrap gap-5"
                      >
                        {(["user", "external"] as const).map((source) => (
                          <div key={source} className="flex items-center gap-2">
                            <RadioGroupItem
                              value={source}
                              id={`safety-source-${adapterId}-${source}`}
                            />
                            <Label
                              htmlFor={`safety-source-${adapterId}-${source}`}
                              className="text-sm font-normal"
                            >
                              {t(`safetyTest.${source}`)}
                            </Label>
                          </div>
                        ))}
                      </RadioGroup>
                    </Field>
                    <Field className="gap-2">
                      <FieldLabel htmlFor={`safety-sample-${adapterId}`} className="text-xs">
                        {t("safetyTest.sample")}
                      </FieldLabel>
                      <Textarea
                        id={`safety-sample-${adapterId}`}
                        value={probeText}
                        maxLength={16384}
                        rows={4}
                        className="bg-background"
                        aria-describedby={`safety-help-${adapterId}`}
                        onChange={(event) => {
                          setProbeText(event.target.value)
                          setProbeResult(undefined)
                        }}
                      />
                      <FieldDescription id={`safety-help-${adapterId}`} className="text-xs">
                        {t("safetyTest.help")}
                      </FieldDescription>
                    </Field>
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={clearProbe}
                        disabled={!probeText && !probeResult}
                      >
                        {t("safetyTest.clear")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={!probeText.trim()}
                        onClick={() =>
                          setProbeResult(
                            assessContentSafety({
                              text: probeText,
                              source: probeSource,
                              stage: probeSource === "user" ? "admission" : "model-input",
                              inspectPrivacy: false,
                            })
                          )
                        }
                      >
                        {t("safetyTest.run")}
                      </Button>
                    </div>
                    {probeResult && probeDecision && (
                      <Alert
                        role="status"
                        aria-live="polite"
                        variant={probeDecision.action === "allow" ? "default" : "destructive"}
                      >
                        {probeDecision.action === "allow" ? (
                          <ShieldCheckIcon />
                        ) : (
                          <TriangleAlertIcon />
                        )}
                        <AlertTitle>{t(`safetyTest.actions.${probeDecision.action}`)}</AlertTitle>
                        <AlertDescription className="text-xs">
                          {!injectionProtection && probeResult.findings.length > 0 && (
                            <p>{t("safetyTest.disabledNotice")}</p>
                          )}
                          {probeResult.status === "incomplete" && (
                            <p>{t("safetyTest.incomplete")}</p>
                          )}
                          {probeResult.status === "complete" &&
                            probeResult.findings.length === 0 && (
                              <p>{t("safetyTest.noFindings")}</p>
                            )}
                          {probeResult.findings.length > 0 && (
                            <ul className="list-disc pl-4">
                              {probeResult.findings.map((finding) => {
                                const code = SAFETY_REASON_CODES.find(
                                  (code) => code === finding.code
                                )
                                return (
                                  <li key={finding.code}>
                                    {code
                                      ? t(`safetyTest.reasons.${code}`)
                                      : t("safetyTest.otherFinding")}
                                  </li>
                                )
                              })}
                            </ul>
                          )}
                        </AlertDescription>
                      </Alert>
                    )}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </SwitchRow>
          </div>
        </PermissionGroup>
      </CardContent>
      <CardFooter className="justify-between gap-3 border-t px-5 py-3 [.border-t]:pt-3">
        <p
          className={cn(
            "flex items-center gap-2 text-xs text-muted-foreground",
            !dirty && "invisible"
          )}
          aria-live="polite"
        >
          <span className="size-1.5 rounded-full bg-amber-500" aria-hidden />
          {dirty ? t("unsaved") : null}
        </p>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={!dirty || saving}
            onClick={() => {
              setDraft(draftFromRow(row))
              clearProbe()
            }}
          >
            {t("cancel")}
          </Button>
          <Button
            size="sm"
            onClick={() => void save()}
            disabled={!dirty || saving}
            aria-busy={saving}
          >
            {t("save")}
          </Button>
        </div>
      </CardFooter>
      {confirmDialog}
    </Card>
  )
}
