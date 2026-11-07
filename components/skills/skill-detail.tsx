"use client"

import { useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import Link from "next/link"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  ArrowUpCircleIcon,
  CopyIcon,
  DownloadIcon,
  FileTextIcon,
  MoreHorizontalIcon,
  PackageIcon,
  PencilIcon,
  Trash2Icon,
  WorkflowIcon,
} from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { Spinner } from "@/components/ui/spinner"
import { useSkillUpdate } from "@/hooks/skills"
import { duplicateSkill, inferCategory, inferSource, setSkillStatus } from "@/lib/db/skills"
import { listResourcesForSkill } from "@/lib/db/skill-resources"
import { countRecordingsForSkill } from "@/lib/db/skill-recordings"
import { getCategoryMeta, getSourceMeta } from "@/lib/skills/categories"
import { useSkillsStore } from "@/stores/skills"
import { serializeSkill, skillFilename } from "@/lib/claude/skills-io"
import { saveBinaryFileAs, saveFileAs } from "@/lib/files/file-bridge"
import { serializeSkillBundle } from "@/lib/skills/bundle/serializer"
import { deriveSkillSlug } from "@/lib/skills/slug"
import { playbookWorkflowHref } from "@/lib/skills/playbook/open-href"
import { toast } from "sonner"
import type { Skill } from "@cognia/agent-config-types"
import { SkillResourceManager } from "./skill-resource-manager"
import { SkillSecurityScanner } from "./skill-security-scanner"
import { SkillRecordingsSection } from "./skill-recordings-section"
import { SkillValidationSection } from "./skill-validation-section"
import { SkillSyncSection } from "./skill-sync-section"
import { useSkillValidation } from "@/hooks/skills"
import { loggers } from "@cognia/logging"

interface Props {
  skill: Skill
}

const DETAIL_TAB =
  "h-7 flex-none gap-1 rounded-md border-0 px-2 text-xs whitespace-nowrap text-muted-foreground shadow-none hover:text-foreground data-[state=active]:bg-muted data-[state=active]:text-foreground data-[state=active]:shadow-none dark:data-[state=active]:bg-muted"
export function SkillDetail({ skill }: Props) {
  const t = useTranslations("skills")
  const tDetail = useTranslations("skills.detail")
  const tToasts = useTranslations("skills.toasts")
  const tVersions = useTranslations("skills.recorder.versions")
  const category = getCategoryMeta(inferCategory(skill))
  const source = getSourceMeta(inferSource(skill))
  const Icon = category.icon
  const status = skill.status ?? "enabled"
  const setDeleteTarget = useSkillsStore((s) => s.setDeleteTarget)
  const openSkillInEditor = useSkillsStore((s) => s.openSkillInEditor)
  const setActiveTab = useSkillsStore((s) => s.setActiveTab)
  const closeDetail = useSkillsStore((s) => s.closeDetail)
  const resources = useLiveQuery(() => listResourcesForSkill(skill.id), [skill.id])
  const [compatibilityWarningOpen, setCompatibilityWarningOpen] = useState(false)
  // Counted rather than loaded: the tab only needs to know whether this skill
  // has a source capture, and the section itself does the reading.
  const recordingCount = useLiveQuery(() => countRecordingsForSkill(skill.id), [skill.id], 0)
  const hasRecordings = recordingCount > 0
  useSkillValidation(skill.id)

  const handleDuplicate = async () => {
    try {
      const dup = await duplicateSkill(skill.id)
      toast.success(tToasts("duplicatedAs", { name: dup.name }))
      loggers.skills.info("duplicate ok", { sourceId: skill.id, newId: dup.id })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      loggers.skills.error("duplicate failed", err, { skillId: skill.id })
    }
  }

  const handleBundleExport = async () => {
    try {
      const bundle = await serializeSkillBundle({ skill, resources: resources ?? [] })
      const ok = await saveBinaryFileAs({
        defaultName: bundle.filename,
        bytes: bundle.bytes,
        mimeType: "application/zip",
        filters: [{ name: tDetail("bundleFilterName"), extensions: ["zip"] }],
      })
      if (ok) {
        toast.success(tToasts("exportedSingle", { name: skill.name }))
        loggers.skills.info("bundle export single ok", { skillId: skill.id })
      }
    } catch (err) {
      toast.error(
        tToasts("exportFailed", { error: err instanceof Error ? err.message : String(err) })
      )
      loggers.skills.error("bundle export single failed", err, { skillId: skill.id })
    }
  }

  const handleCompatibilityExport = async () => {
    try {
      const ok = await saveFileAs({
        defaultName: skillFilename(skill.slug ?? deriveSkillSlug(skill)),
        content: serializeSkill(skill),
        filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
      })
      if (ok) {
        toast.success(tToasts("exportedSingle", { name: skill.name }))
        loggers.skills.info("export single ok", { skillId: skill.id })
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      loggers.skills.error("export single failed", err, { skillId: skill.id })
    }
  }

  const compatibilityLosses = [
    ...(resources && resources.length > 0
      ? [tDetail("compatibilityExportResources", { count: resources.length })]
      : []),
    ...(skill.codexOpenAiYaml !== undefined ? [tDetail("compatibilityExportCodex")] : []),
  ]

  const requestCompatibilityExport = () => {
    if (compatibilityLosses.length > 0) setCompatibilityWarningOpen(true)
    else void handleCompatibilityExport()
  }

  const handleToggleStatus = async () => {
    await setSkillStatus(skill.id, status === "enabled" ? "disabled" : "enabled")
  }

  const enabled = status === "enabled"
  const builtIn = Boolean(skill.isBuiltIn)
  return (
    <div className="@container/skill-detail flex h-full flex-col">
      <div className="flex shrink-0 flex-col gap-3 px-4 py-3 sm:px-5 sm:py-4">
        <div className="flex flex-wrap items-start gap-3">
          <div
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md ${category.color}`}
          >
            <Icon className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold">{skill.name}</h2>
            {skill.description && (
              <p className="line-clamp-2 text-xs text-muted-foreground">{skill.description}</p>
            )}
          </div>
          {/* Sized by the pane, not the window: beside the list at 800px the
              pane is ~420px, and sharing the row cut the name to "Ag…". */}
          <div className="flex w-full shrink-0 items-center justify-end gap-2 @2xl/skill-detail:w-auto">
            {/* The on/off state, shown and changed in one place. It was a bare
                power icon that toggled without ever saying which way the
                skill currently was. */}
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={enabled}
                onCheckedChange={() => void handleToggleStatus()}
                data-testid="skill-status-switch"
              />
              {t("status.enabled")}
            </label>
            {/* A built-in cannot be edited, only copied. Its Edit button sat
                there disabled with nothing saying what to do instead; the
                way to change one is the primary action now. */}
            {builtIn ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleDuplicate()}
                data-testid="skill-duplicate-to-edit"
              >
                <CopyIcon className="mr-1.5 size-3.5" />
                {tDetail("duplicateToEdit")}
              </Button>
            ) : (
              /* Single edit entry: jumps straight to the workspace editor (file
                 tree + Monaco + validation). Metadata is edited from the
                 editor's "Skill settings" panel, so there is no separate form
                 dialog. */
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  openSkillInEditor(skill.id, skill.content)
                  setActiveTab("editor")
                  // On mobile the detail renders inside a full-screen Sheet
                  // that would otherwise keep covering the editor tab.
                  closeDetail()
                }}
                data-testid="skill-open-in-editor"
              >
                <PencilIcon className="mr-1.5 size-3.5" />
                {t("card.edit")}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  aria-label={t("toolbar.moreActions")}
                  data-testid="skill-detail-more"
                >
                  <MoreHorizontalIcon className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuGroup>
                  {builtIn ? null : (
                    <DropdownMenuItem onSelect={() => void handleDuplicate()}>
                      <CopyIcon className="size-3.5" />
                      {t("card.duplicate")}
                    </DropdownMenuItem>
                  )}
                  {/* A playbook opens its compiled, read-only workflow; any
                      other skill opens a workflow the Copilot drafts from it
                      (ADR-0254 §2). The editor route decides which. */}
                  <DropdownMenuItem asChild>
                    <Link
                      href={playbookWorkflowHref(skill.id)}
                      data-testid="skill-open-as-workflow"
                    >
                      <WorkflowIcon className="size-3.5" />
                      {tDetail("openAsWorkflow")}
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void handleBundleExport()}>
                    <PackageIcon className="size-3.5" />
                    {tDetail("exportBundle")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={requestCompatibilityExport}>
                    <FileTextIcon className="size-3.5" />
                    {tDetail("exportMarkdownCompatibility")}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                {/* Not offered at all for a built-in, rather than a red icon
                    that did nothing. */}
                {builtIn ? null : (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => setDeleteTarget({ skillId: skill.id, name: skill.name })}
                      data-testid="skill-detail-delete"
                    >
                      <Trash2Icon className="size-3.5" />
                      {t("card.delete")}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 sm:ps-[3.25rem]">
          <Badge variant={source.badgeVariant} className="h-5 text-[10px]">
            {t(`source.${source.labelKey}` as never)}
          </Badge>
          <Badge variant="outline" className="h-5 text-[10px]">
            {t(`category.${category.labelKey}` as never)}
          </Badge>
          {(skill.tags ?? []).map((tag) => (
            <Badge key={tag} variant="outline" className="h-5 text-[10px]">
              {tag}
            </Badge>
          ))}
        </div>
      </div>

      <Tabs defaultValue="overview" className="flex flex-1 flex-col overflow-hidden">
        {/* The same quiet text tabs as the page header, a size down: a second
            segmented control here read as a peer of the page's own tabs. */}
        <div className="mx-4 overflow-x-auto border-b pb-2 sm:mx-5">
          <TabsList className="h-auto gap-0.5 self-start rounded-none bg-transparent p-0">
            <TabsTrigger value="overview" className={DETAIL_TAB}>
              {tDetail("tabOverview")}
            </TabsTrigger>
            <TabsTrigger value="content" className={DETAIL_TAB}>
              {tDetail("tabContent")}
            </TabsTrigger>
            <TabsTrigger value="resources" className={DETAIL_TAB}>
              {tDetail("tabResources")}
              {resources && resources.length > 0 && (
                <span className="ml-1 text-[10px] opacity-60">{resources.length}</span>
              )}
            </TabsTrigger>
            <TabsTrigger value="security" className={DETAIL_TAB}>
              {tDetail("tabSecurity")}
            </TabsTrigger>
            {/* Only a recorded skill has a source capture behind it; an
                empty tab on every hand-written skill would be noise. */}
            {hasRecordings ? (
              <TabsTrigger value="recordings" className={DETAIL_TAB}>
                {tVersions("tabLabel")}
                <span className="ml-1 text-[10px] opacity-60">{recordingCount}</span>
              </TabsTrigger>
            ) : null}
            <TabsTrigger value="validation" className={DETAIL_TAB}>
              {tDetail("tabValidation")}
              {skill.validationErrors && skill.validationErrors.length > 0 && (
                <Badge variant="destructive" className="ml-1 h-4 px-1.5 text-[10px]">
                  {skill.validationErrors.length}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>
        </div>
        <ScrollArea className="flex-1">
          <TabsContent value="overview" className="m-0 px-5 py-4">
            <OverviewSection skill={skill} />
          </TabsContent>
          <TabsContent value="content" className="m-0 px-5 py-4">
            <ContentSection skill={skill} />
          </TabsContent>
          <TabsContent value="resources" className="m-0 px-5 py-4">
            <SkillResourceManager skillId={skill.id} />
          </TabsContent>
          <TabsContent value="security" className="m-0 px-5 py-4">
            <SkillSecurityScanner skill={skill} />
          </TabsContent>
          {hasRecordings ? (
            <TabsContent value="recordings" className="m-0 px-5 py-4">
              <SkillRecordingsSection skillId={skill.id} />
            </TabsContent>
          ) : null}
          <TabsContent value="validation" className="m-0 px-5 py-4">
            <SkillValidationSection errors={skill.validationErrors ?? []} />
          </TabsContent>
        </ScrollArea>
      </Tabs>
      <AlertDialog open={compatibilityWarningOpen} onOpenChange={setCompatibilityWarningOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tDetail("compatibilityExportTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {tDetail("compatibilityExportDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {compatibilityLosses.map((loss) => (
              <li key={loss}>{loss}</li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel>{tDetail("compatibilityExportCancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setCompatibilityWarningOpen(false)
                void handleCompatibilityExport()
              }}
            >
              {tDetail("compatibilityExportContinue")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function OverviewSection({ skill }: { skill: Skill }) {
  const t = useTranslations("skills.detail")
  const tSkills = useTranslations("skills")
  const format = useFormatter()
  const category = getCategoryMeta(inferCategory(skill))
  const source = getSourceMeta(inferSource(skill))
  const formatTime = (ms?: number) =>
    ms ? format.dateTime(ms, { dateStyle: "medium", timeStyle: "short" }) : "—"
  const usageCount = skill.usageCount ?? 0
  return (
    <div className="space-y-5">
      <SkillUpdateBanner skill={skill} />
      {/* Labels in sentence case beside readable values. The values were the
          raw stored ids ("meta", "builtin"), and the usage row put its count
          in the label with a dash for a value. */}
      <dl
        className="grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] items-baseline gap-x-6 gap-y-3"
        data-testid="skill-overview-details"
      >
        <Row label={t("metaCategory")}>{tSkills(`category.${category.labelKey}` as never)}</Row>
        <Row label={t("metaSource")}>{tSkills(`source.${source.labelKey}` as never)}</Row>
        {skill.author && <Row label={t("metaAuthor")}>{skill.author}</Row>}
        {skill.version && <Row label={t("metaVersion")}>{skill.version}</Row>}
        {skill.license && <Row label={t("metaLicense")}>{skill.license}</Row>}
        <Row label={t("metaUsageLabel")}>
          {usageCount === 0 ? (
            <span className="text-muted-foreground">{t("usageNever")}</span>
          ) : (
            <>
              {t("usageSummary", { count: usageCount })}
              {skill.lastUsedAt ? (
                <span className="text-muted-foreground">
                  {" · "}
                  {t("metaLastUsed", { when: formatTime(skill.lastUsedAt) })}
                </span>
              ) : null}
            </>
          )}
        </Row>
        <Row label={t("metaCreated")}>{formatTime(skill.createdAt)}</Row>
        <Row label={t("metaUpdated")}>{formatTime(skill.updatedAt)}</Row>
        {skill.allowedTools && skill.allowedTools.length > 0 && (
          <Row label={t("metaTools")}>
            <span className="font-mono text-xs">{skill.allowedTools.join(", ")}</span>
          </Row>
        )}
      </dl>
      {/* After the facts, not before them: off the desktop it is one line
          saying sync lives there, and it opened every skill's overview. */}
      <SkillSyncSection skill={skill} />
    </div>
  )
}

/**
 * "Update available" banner with a one-click update, shown when the last
 * explicit update check flagged this skill. The flag lives in the skills
 * store so the toolbar's check, the list badge, and this banner agree.
 * Exported for parity in the mobile skill sheet's Overview tab.
 */
export function SkillUpdateBanner({ skill }: { skill: Skill }) {
  const t = useTranslations("skills.detail")
  const tToasts = useTranslations("skills.toasts")
  const updateAvailable = useSkillsStore((s) => Boolean(s.updateAvailable[skill.id]))
  const updates = useSkillUpdate()
  if (!updateAvailable) return null
  const handleUpdate = async () => {
    try {
      await updates.updateOne(skill)
      toast.success(tToasts("updated", { name: skill.name }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <div
      className="flex items-center justify-between gap-3 border-y bg-muted/30 px-3 py-2"
      data-testid="skill-update-banner"
    >
      <span className="flex items-center gap-1.5 text-xs">
        <ArrowUpCircleIcon className="size-3.5 text-primary" />
        {t("updateAvailable")}
      </span>
      <Button
        size="sm"
        className="min-h-11 md:min-h-8"
        onClick={() => void handleUpdate()}
        disabled={updates.updatingId === skill.id}
        data-testid="skill-update-button"
      >
        {updates.updatingId === skill.id ? (
          <Spinner className="mr-1.5 size-3" />
        ) : (
          <DownloadIcon className="mr-1.5 size-3.5" />
        )}
        {t("update")}
      </Button>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </>
  )
}

function ContentSection({ skill }: { skill: Skill }) {
  // Reuse the chat MarkdownRenderer so the skill body gets Shiki syntax
  // highlighting, the same-line code toolbar (language + copy/download/wrap),
  // GFM tables, and math — instead of streamdown's plain fallback.
  return <MarkdownRenderer content={`## ${skill.name}\n\n${skill.content}`} rhythm="document" />
}
