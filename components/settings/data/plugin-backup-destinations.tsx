"use client"

import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  getBackupDestinationRevision,
  listBackupDestinations,
  readBackupDestinationReadiness,
  subscribeBackupDestinations,
  type RegisteredBackupDestination,
} from "@/lib/data/destinations"
import { runRemoteBackupSyncNow } from "@/lib/data/destinations/sync-now"
import {
  listBackupDestinationSnapshots,
  restoreFromBackupDestination,
  supportsBackupDestinationRestore,
} from "@/lib/data/destinations/restore"
import { listBackupHistory } from "@/lib/db/backup-history"
import { getSyncPassphrase } from "@/lib/webdav/passphrase-cache"
import type {
  BackupDestinationReadiness,
  BackupDestinationSnapshot,
} from "@cognia/plugin-contract/types/plugin/plugin-backup-destinations"

/** A runtime contribution has no bespoke Host vendor card. */
export function PluginBackupDestinations() {
  useSyncExternalStore(
    subscribeBackupDestinations,
    getBackupDestinationRevision,
    getBackupDestinationRevision
  )
  return listBackupDestinations()
    .filter((entry) => entry.pluginId)
    .map((entry) => <PluginBackupDestinationCard key={entry.id} entry={entry} />)
}

export function PluginBackupDestinationCard({ entry }: { entry: RegisteredBackupDestination }) {
  const t = useTranslations("settings.data.pluginDestinations")
  const tRoot = useTranslations()
  const [passphrase, setPassphrase] = useState("")
  const [readiness, setReadiness] = useState<BackupDestinationReadiness>({ state: "unavailable" })
  const [busy, setBusy] = useState(false)
  const [importing, setImporting] = useState(false)
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [snapshots, setSnapshots] = useState<BackupDestinationSnapshot[]>([])
  const [remoteId, setRemoteId] = useState("")
  const operation = useRef<AbortController | null>(null)
  const last = useLiveQuery(
    async () => (await listBackupHistory()).find((row) => row.destination === entry.id),
    [entry.id]
  )
  useEffect(() => () => operation.current?.abort(), [])
  useEffect(() => {
    const controller = new AbortController()
    void readBackupDestinationReadiness(
      entry.id,
      controller.signal,
      Boolean(passphrase || getSyncPassphrase())
    )
      .then((value) => {
        if (!controller.signal.aborted) setReadiness(value)
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [entry.id, passphrase, busy])

  const run = async (action: (signal: AbortSignal) => Promise<void>) => {
    const controller = new AbortController()
    operation.current = controller
    setBusy(true)
    try {
      await action(controller.signal)
    } catch {
      if (!controller.signal.aborted) toast.error(t("failed"))
    } finally {
      if (operation.current === controller) {
        if (!controller.signal.aborted) {
          setBusy(false)
          setImporting(false)
        }
        operation.current = null
      }
    }
  }
  const backup = () =>
    run(async (signal) => {
      const result = await runRemoteBackupSyncNow(
        entry.id as `plugin:${string}/${string}`,
        passphrase,
        { signal }
      )
      if (!signal.aborted) {
        if (result.ok) toast.success(t("succeeded"))
        else toast.error(t("failed"))
      }
    })
  const openRestore = () =>
    run(async (signal) => {
      const rows = await listBackupDestinationSnapshots(entry.id, signal)
      if (signal.aborted) return
      setSnapshots(rows)
      setRemoteId(rows[0]?.remoteId ?? "")
      setRestoreOpen(true)
    })
  const restore = () =>
    run(async (signal) => {
      await restoreFromBackupDestination(
        entry.id,
        remoteId,
        {
          passphrase: passphrase || getSyncPassphrase() || "",
          mergeStrategy: "skip",
          includeApiKey: false,
          onImportStart: () => setImporting(true),
        },
        signal
      )
      if (!signal.aborted) {
        setRestoreOpen(false)
        toast.success(t("restored"))
      }
    })
  const reason = readiness.reasonKey
    ? t.has(`reasons.${readiness.reasonKey}`)
      ? t(`reasons.${readiness.reasonKey}`)
      : tRoot.has(readiness.reasonKey)
        ? tRoot(readiness.reasonKey)
        : t("notReady")
    : undefined
  const passphraseId = `backup-passphrase-${entry.id}`

  return (
    <Card className="space-y-3 p-4">
      <h3 className="font-medium">{entry.label}</h3>
      <p className="text-sm text-muted-foreground">
        {t(`readiness.${readiness.state}`)}
        {reason ? ` — ${reason}` : ""}
      </p>
      <Label htmlFor={passphraseId}>{t("passphrase")}</Label>
      <Input
        id={passphraseId}
        type="password"
        autoComplete="off"
        value={passphrase}
        onChange={(event) => setPassphrase(event.target.value)}
        disabled={busy}
      />
      {last ? (
        <p className="text-sm">
          {t("lastResult", {
            result: t(`results.${last.result?.status ?? (last.success ? "success" : "failed")}`),
          })}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={busy || readiness.state !== "ready"}
          onClick={() => void backup()}
        >
          {t("backupNow")}
        </Button>
        {supportsBackupDestinationRestore(entry.id) ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void openRestore()}>
            {importing ? t("importing") : t("restore")}
          </Button>
        ) : null}
        <Button size="sm" variant="link" asChild>
          <Link
            href={`/plugins?plugin=${encodeURIComponent(entry.pluginId ?? "")}&subtab=configure`}
          >
            {t("settings")}
          </Link>
        </Button>
        {busy && !importing ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              operation.current?.abort()
              setBusy(false)
            }}
          >
            {t("cancel")}
          </Button>
        ) : null}
      </div>
      <Dialog
        open={restoreOpen}
        onOpenChange={(open) => {
          if (!importing) setRestoreOpen(open)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("restoreTitle", { label: entry.label })}</DialogTitle>
            <DialogDescription>{t("restoreDescription")}</DialogDescription>
          </DialogHeader>
          <Label htmlFor={`restore-${passphraseId}`}>{t("passphrase")}</Label>
          <Input
            id={`restore-${passphraseId}`}
            type="password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            disabled={busy}
          />
          <Select value={remoteId} onValueChange={setRemoteId}>
            <SelectTrigger aria-label={t("snapshot")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {snapshots.map((snapshot) => (
                <SelectItem key={snapshot.remoteId} value={snapshot.remoteId}>
                  {snapshot.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!snapshots.length ? <p>{t("empty")}</p> : null}
          <Button
            disabled={busy || !remoteId || !(passphrase || getSyncPassphrase())}
            onClick={() => void restore()}
          >
            {importing ? t("importing") : t("restore")}
          </Button>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
