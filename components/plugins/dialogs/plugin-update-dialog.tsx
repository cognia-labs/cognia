"use client"

// Update dialog — surfaces the marketplace updater's `checkForUpdates`
// output and lets the user apply singletons or batch-update everything.
// Reads from the lazy-loaded updater singleton so this dialog can mount
// inside a panel that doesn't always need the updater module.

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { DownloadIcon, RefreshCcwIcon } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { usePluginDisplayName } from "@/hooks/plugins/use-plugin-display-name"
import type { PluginUpdater, UpdateInfo } from "@/lib/plugin/lifecycle/updater"

type UpdaterClient = Pick<
  PluginUpdater,
  "checkForUpdates" | "installUpdate" | "cancelUpdate" | "onProgress"
>

let cachedClient: UpdaterClient | null = null

async function loadUpdaterClient(): Promise<UpdaterClient> {
  if (cachedClient) return cachedClient
  const { getPluginUpdater } = await import("@/lib/plugin/lifecycle/updater")
  cachedClient = getPluginUpdater()
  return cachedClient
}

export function __resetPluginUpdateClientForTests(client: UpdaterClient | null) {
  cachedClient = client
}

interface Props {
  open: boolean
  onClose: () => void
  /**
   * Scope the check to one plugin (the detail header's Update action). Omit
   * or pass `null` to check every installed plugin (the toolbar).
   */
  pluginId?: string | null
}

export function PluginUpdateDialog({ open, onClose, pluginId = null }: Props) {
  const t = useTranslations("plugins.update")
  const tErrors = useTranslations("plugins.errors")
  const [updates, setUpdates] = useState<UpdateInfo[]>([])
  const [progress, setProgress] = useState<Record<string, number>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [checkError, setCheckError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let unsubscribe: (() => void) | undefined
    void (async () => {
      setRefreshing(true)
      setCheckError(null)
      try {
        const client = await loadUpdaterClient()
        const list = await client.checkForUpdates(pluginId ? [pluginId] : undefined)
        setUpdates(list)
        unsubscribe = client.onProgress((p) =>
          setProgress((prev) => ({ ...prev, [p.pluginId]: p.progress }))
        )
      } catch (error) {
        setCheckError(error instanceof Error ? error.message : String(error))
      } finally {
        setRefreshing(false)
      }
    })()
    return () => {
      unsubscribe?.()
    }
  }, [open, pluginId])

  const refresh = async () => {
    setRefreshing(true)
    setCheckError(null)
    try {
      const client = await loadUpdaterClient()
      setUpdates(await client.checkForUpdates(pluginId ? [pluginId] : undefined))
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : String(error))
    } finally {
      setRefreshing(false)
    }
  }

  const installOne = async (info: UpdateInfo) => {
    setBusyId(info.pluginId)
    setErrors((prev) => {
      const next = { ...prev }
      delete next[info.pluginId]
      return next
    })
    try {
      const client = await loadUpdaterClient()
      const result = await client.installUpdate(info.pluginId, info.latestVersion)
      if (result.success) {
        setUpdates((prev) => prev.filter((u) => u.pluginId !== info.pluginId))
      } else {
        setErrors((prev) => ({
          ...prev,
          [info.pluginId]: result.error || tErrors("install", { pluginName: info.pluginId }),
        }))
      }
    } catch (error) {
      setErrors((prev) => ({
        ...prev,
        [info.pluginId]: error instanceof Error ? error.message : String(error),
      }))
    } finally {
      setBusyId(null)
    }
  }

  const installAll = async () => {
    for (const info of updates) {
      await installOne(info)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      {/* `dvh`, not `vh`: on a phone `vh` is the viewport with the browser
          chrome retracted, so a `vh` cap can still run under the toolbar. */}
      <DialogContent className="flex max-h-[85dvh] w-[95vw] max-w-2xl flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>{pluginId ? <ScopedTitle pluginId={pluginId} /> : t("title")}</DialogTitle>
          <DialogDescription>
            {pluginId ? t("descriptionSingle") : t("description")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Badge variant="secondary" className="text-xs">
            {t("availableCount", { count: updates.length })}
          </Badge>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={refresh}
            disabled={refreshing}
          >
            <RefreshCcwIcon className="size-3.5 mr-1.5" />
            {refreshing ? t("checking") : t("recheck")}
          </Button>
        </div>

        {checkError && (
          <p role="alert" className="text-sm text-destructive">
            {checkError}
          </p>
        )}

        {/* A divided list between two hairlines, not a card inside the dialog:
            the dialog is already the frame. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-y">
          <ScrollArea className="flex-1 min-h-0">
            {updates.length === 0 ? (
              <p className="p-4 text-center text-sm text-muted-foreground">
                {pluginId ? t("upToDateSingle") : t("upToDate")}
              </p>
            ) : (
              <ul className="divide-y">
                {updates.map((info) => (
                  <li key={info.pluginId} className="flex items-center gap-3 px-1 py-3">
                    <div className="flex-1 min-w-0">
                      <UpdateName pluginId={info.pluginId} />
                      <div className="text-xs text-muted-foreground">
                        {t("versionChange", {
                          from: info.currentVersion,
                          to: info.latestVersion,
                        })}
                      </div>
                      {busyId === info.pluginId && (
                        <Progress value={progress[info.pluginId] ?? 0} className="mt-2 h-1.5" />
                      )}
                      {errors[info.pluginId] && (
                        <p role="alert" className="mt-2 text-sm text-destructive">
                          {errors[info.pluginId]}
                        </p>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void installOne(info)}
                      disabled={busyId !== null}
                    >
                      <DownloadIcon className="size-3.5 mr-1.5" />
                      {t("install")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </ScrollArea>
        </div>

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={onClose}>
            {t("close")}
          </Button>
          <Button
            onClick={() => void installAll()}
            disabled={updates.length === 0 || busyId !== null}
          >
            {t("installAll")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The plugin's own (localized) name; the id only when the runtime has no manifest for it. */
function UpdateName({ pluginId }: { pluginId: string }) {
  const name = usePluginDisplayName(pluginId)
  return (
    <div className="truncate text-sm font-medium" title={pluginId}>
      {name}
    </div>
  )
}

function ScopedTitle({ pluginId }: { pluginId: string }) {
  const t = useTranslations("plugins.update")
  const name = usePluginDisplayName(pluginId)
  return <>{t("titleSingle", { name })}</>
}
