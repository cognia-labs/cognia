"use client"

/**
 * Google Drive backup destination card (Settings → Data). The user supplies
 * their own OAuth client (Google Cloud → "Desktop app"), connects through the
 * OAuth device flow (a code to type at google.com/device — works on the
 * desktop AND when driving a headless host from a companion), and can run a
 * manual "Sync now" through the same pipeline the scheduled `backup` executor
 * uses. Tokens/secret never leave the host keyring.
 */

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { CloudIcon } from "lucide-react"
import { toast } from "sonner"
import { DeviceAuthorizationDialog } from "@/components/plugins/auth/device-authorization-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  DEFAULT_GOOGLE_DRIVE_FOLDER_NAME,
  getBackupDestinationsSettings,
  updateBackupDestinationsSettings,
} from "@/lib/data/destinations/config"
import {
  bindGoogleDriveConnection,
  resolveGoogleDriveConnection,
  GOOGLE_DRIVE_AUTH_SCOPES,
  GOOGLE_DRIVE_SCOPE,
} from "@/lib/data/destinations/google-oauth"
import {
  listGoogleConnections,
  createGoogleDeviceAuthorization,
} from "@/lib/auth-providers/google/host-auth"
import {
  googleState,
  subscribeGoogleStateChanged,
  type GoogleStateReply,
} from "@/lib/docs-providers/providers/google/state"
import {
  getConnectionManager,
  getHostConnectionDriver,
  type HostDeviceAuthorization,
} from "@/lib/plugin/auth/connection-manager"
import type { AuthConnectionRow } from "@/lib/db/auth-connections"
import {
  runRemoteBackupSyncNow,
  type RemoteBackupSyncPhase,
} from "@/lib/data/destinations/sync-now"
import { hasSyncPassphrase, loadPersistedSyncPassphrase } from "@/lib/webdav/passphrase-cache"

export function GoogleDriveBackupCard() {
  const t = useTranslations("settings.data.googleDriveBackup")
  const [enabled, setEnabled] = useState(false)
  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const [snapshot, setSnapshot] = useState<GoogleStateReply | null>(null)
  const [savedClientId, setSavedClientId] = useState("")
  const [loadFailed, setLoadFailed] = useState(false)
  const [reload, setReload] = useState(0)
  const [connection, setConnection] = useState<AuthConnectionRow | null>(null)
  const secretSaved = Boolean(
    snapshot?.clients.find((client) => client.clientId === clientId.trim())?.hasClientSecret
  )
  const [folderName, setFolderName] = useState(DEFAULT_GOOGLE_DRIVE_FOLDER_NAME)
  const connected =
    connection?.status === "connected" && connection.scopes.includes(GOOGLE_DRIVE_SCOPE)
  const accountEmail = connection?.accountLabel
  const [lastSyncAt, setLastSyncAt] = useState<string | undefined>()
  const [challenge, setChallenge] = useState<HostDeviceAuthorization | null>(null)
  const [saving, setSaving] = useState(false)
  const [working, setBusy] = useState(false)
  const busy = working || challenge !== null
  const [phase, setPhase] = useState<RemoteBackupSyncPhase | null>(null)
  const [unlocked, setUnlocked] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    let active = true
    void (async () => {
      const settings = await getBackupDestinationsSettings()
      if (!active) return
      const cfg = settings.googleDrive
      setEnabled(cfg?.enabled ?? false)
      setClientId(cfg?.clientId ?? "")
      setSavedClientId(cfg?.clientId?.trim() ?? "")
      setFolderName(cfg?.folderName ?? DEFAULT_GOOGLE_DRIVE_FOLDER_NAME)
      setLastSyncAt(cfg?.lastSyncAt)
      await loadPersistedSyncPassphrase()
      if (active) setUnlocked(hasSyncPassphrase())
    })().catch(() => {
      if (active) setLoadFailed(true)
    })
    return () => {
      active = false
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [])

  useEffect(() => {
    const refresh = () => setReload((value) => value + 1)
    const stopNative = subscribeGoogleStateChanged(refresh)
    const stopConnections = getConnectionManager().onDidChange((event) => {
      if (event.providerId === "google") refresh()
    })
    return () => {
      stopNative()
      stopConnections()
    }
  }, [])

  useEffect(() => {
    let active = true
    void (async () => {
      await resolveGoogleDriveConnection()
      if (!active) return
      const rows = await listGoogleConnections()
      if (!active) return
      const settings = await getBackupDestinationsSettings()
      if (!active) return
      const metadata = await googleState({ action: "snapshot" })
      if (!active) return
      setSnapshot(metadata)
      setConnection(
        rows.find(
          (row) => row.id === settings.googleDrive?.connectionId && row.clientId === clientId.trim()
        ) ?? null
      )
    })().catch(() => {
      if (active) {
        setSnapshot(null)
        setConnection(null)
      }
    })
    return () => {
      active = false
    }
  }, [clientId, reload])

  const onSave = async () => {
    if (!clientId.trim()) {
      toast.error(t("clientIdRequired"))
      return
    }
    setSaving(true)
    try {
      if (clientSecret.trim()) {
        setSnapshot(
          await googleState({
            action: "setClientSecret",
            clientId: clientId.trim(),
            secret: clientSecret.trim(),
          })
        )
        setClientSecret("")
      }
      await updateBackupDestinationsSettings((current) => ({
        ...current,
        googleDrive: {
          ...(current.googleDrive ?? { enabled: false }),
          enabled,
          clientId: clientId.trim(),
          ...(current.googleDrive?.clientId?.trim() !== clientId.trim()
            ? {
                connectionId: current.googleDrive?.connectionId === undefined ? undefined : null,
                folderId: undefined,
              }
            : {}),
          folderName: folderName.trim() || DEFAULT_GOOGLE_DRIVE_FOLDER_NAME,
        },
      }))
      setSavedClientId(clientId.trim())
      setReload((value) => value + 1)
      toast.success(t("saved"))
    } catch {
      toast.error(t("saveFailed"))
    } finally {
      setSaving(false)
    }
  }

  const onConnect = async (reauthorize = false) => {
    setBusy(true)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      let authorization: HostDeviceAuthorization | void
      if (reauthorize && connection) {
        authorization = await getHostConnectionDriver("google")?.reauthorize?.(connection.id, {})
      } else {
        const reply = await googleState({
          action: "beginDevice",
          clientId: savedClientId,
          scopes: GOOGLE_DRIVE_AUTH_SCOPES,
        })
        if (!reply.attempt) throw new Error("device-challenge-missing")
        authorization = createGoogleDeviceAuthorization(reply.attempt)
      }
      // A challenge arriving after unmount still belongs to this caller to cancel.
      if (controller.signal.aborted) {
        await authorization?.cancel()
        return
      }
      if (authorization) setChallenge(authorization)
    } catch {
      if (!controller.signal.aborted) toast.error(t("connectFailed"))
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null
        setBusy(false)
      }
    }
  }

  const onDisconnect = async () => {
    if (!connection) return
    setBusy(true)
    try {
      await getConnectionManager().disconnect(connection.id, { revoke: true })
      await updateBackupDestinationsSettings((current) => ({
        ...current,
        googleDrive:
          current.googleDrive?.connectionId === connection.id
            ? {
                ...current.googleDrive,
                connectionId: null,
                connected: false,
                accountEmail: undefined,
              }
            : current.googleDrive,
      }))
      setConnection(null)
      toast.success(t("disconnected"))
    } catch {
      toast.error(t("disconnectFailed"))
    } finally {
      setBusy(false)
      setReload((value) => value + 1)
    }
  }

  const onSyncNow = async () => {
    if (!unlocked) {
      toast.error(t("passphraseRequired"))
      return
    }
    setBusy(true)
    try {
      const result = await runRemoteBackupSyncNow("googledrive", "", { onProgress: setPhase })
      if (result.ok) {
        setLastSyncAt(new Date().toISOString())
        toast.success(t("syncDone"))
      } else {
        toast.error(t("syncFailed"), { description: result.error })
      }
    } finally {
      setBusy(false)
      setPhase(null)
    }
  }

  return (
    <Card className="space-y-4 p-4" data-testid="google-drive-backup-card">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CloudIcon className="h-4 w-4" aria-hidden="true" />
          <Label className="text-sm">{t("title")}</Label>
          {connected && (
            <Badge
              variant="outline"
              className="text-[10px]"
              data-testid="google-drive-connected-badge"
            >
              {accountEmail ? t("connectedAs", { email: accountEmail }) : t("connectedBadge")}
            </Badge>
          )}
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label={t("enableLabel")}
          data-testid="google-drive-backup-enabled"
        />
      </div>
      <p className="text-xs text-muted-foreground">{t("description")}</p>
      {loadFailed && <p role="alert">{t("loadFailed")}</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs">{t("clientIdLabel")}</Label>
          <Input
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder={t("clientIdPlaceholder")}
            aria-label={t("clientIdLabel")}
            disabled={busy}
            className="h-9 font-mono text-xs"
            data-testid="google-drive-client-id"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("clientSecretLabel")}</Label>
          <Input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={secretSaved ? t("clientSecretSaved") : t("clientSecretPlaceholder")}
            aria-label={t("clientSecretLabel")}
            disabled={busy}
            className="h-9 font-mono text-xs"
            data-testid="google-drive-client-secret"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("folderLabel")}</Label>
          <Input
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            placeholder={DEFAULT_GOOGLE_DRIVE_FOLDER_NAME}
            aria-label={t("folderLabel")}
            className="h-9 text-xs"
            data-testid="google-drive-folder"
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t("clientHelp")}</p>

      {challenge && (
        <DeviceAuthorizationDialog
          authorization={challenge}
          onAuthorized={async () => {
            if (!("lineageId" in challenge) || typeof challenge.lineageId !== "string")
              throw new Error("authorized-lineage-missing")
            const bound = await bindGoogleDriveConnection(challenge.lineageId)
            setConnection(bound)
            toast.success(t("connected"))
          }}
          onClose={() => {
            setChallenge(null)
            setReload((value) => value + 1)
          }}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={onSave}
          disabled={saving || busy}
          data-testid="google-drive-save"
        >
          {t("save")}
        </Button>
        {connected ? (
          <Button
            size="sm"
            variant="outline"
            onClick={onDisconnect}
            disabled={busy}
            data-testid="google-drive-disconnect"
          >
            {t("disconnect")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void onConnect()}
            disabled={busy || !savedClientId || clientId.trim() !== savedClientId || !secretSaved}
            data-testid="google-drive-connect"
          >
            {t("connect")}
          </Button>
        )}
        {connection && connection.status !== "tombstoned" && connection.status !== "revoked" && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void onConnect(true)}
            disabled={busy || !secretSaved}
          >
            {t("reauthorize")}
          </Button>
        )}
        {snapshot?.backupMigrationNeedsClientId && (
          <p className="text-xs text-muted-foreground">{t("migrationNeedsClientId")}</p>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={onSyncNow}
          disabled={busy || !enabled || !connected}
          data-testid="google-drive-sync"
        >
          {phase ? t(`phase.${phase}`) : t("syncNow")}
        </Button>
        <span className="text-xs text-muted-foreground" data-testid="google-drive-last-sync">
          {lastSyncAt
            ? t("lastSync", { time: new Date(lastSyncAt).toLocaleString() })
            : t("neverSynced")}
        </span>
      </div>
    </Card>
  )
}
