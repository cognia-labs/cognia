"use client"

/**
 * WebRTC remote-access settings card (ADR-0021).
 *
 * Lives under the Mobile companion settings tab alongside the existing
 * tunnel / mDNS cards. Owns the four `AppSettings` keys the WebRTC tier
 * reads on the mobile side:
 *
 *   - `webrtcEnabled`   — master toggle, default ON
 *   - `signalingUrl`    — wss:// endpoint of the rendezvous service
 *   - `iceServers`      — STUN entries, one per line in the textarea. Only
 *                         `stun:` URLs: a TURN line typed here would reach
 *                         Dexie with its credential in plaintext.
 *   - `turnServers`     — TURN entries, encoded as
 *                         `turn:host:port?transport=udp|user|credential`;
 *                         the credentials go to the OS keyring.
 *
 * The settings persist through the existing Dexie `settings` singleton
 * (`lib/db/settings.ts:saveSettings`), which is the same path the mobile
 * `app_settings_update` RPC ultimately rides — the allowlist in
 * `crates/cognia-companion-rpc/src/rpc.rs` covers these keys (see ADR-0021).
 *
 * The status pane below the form polls two Tauri commands every 3 s:
 *   - `companion_signaling_status` — hub-level enabled flag + signaling URL
 *   - `companion_signaling_devices_status` — per-device tier (Offline /
 *     Awaiting / Negotiating / Connected / Failed) sourced from the Rust
 *     `SignalingHub::devices_status` snapshot.
 * Consecutive poll failures (≥ 3, i.e. ~9 s of unreachable hub) surface a
 * red banner above the device list so the user knows _why_ the tier
 * column hasn't refreshed.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { CircleIcon, GlobeIcon, RefreshCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { SettingsBlock } from "@/components/settings/common/settings-block"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { DEFAULT_SIGNALING_URL } from "@/lib/signaling/types"
import { isTauri, localTransport as transport } from "@/lib/tauri"
import {
  KEYRING_CREDENTIAL_PREFIX,
  deleteTurnCredential,
  freshCredentialKeyId,
  keyIdOfSentinel,
  resolveTurnServerCredentials,
  saveTurnCredential,
} from "@/lib/credentials/turn-credentials"
import {
  deleteProviderSecret,
  clampTtl,
  provisionIceServers,
  saveProviderSecret,
  type TurnProviderSecret,
} from "@/lib/credentials/turn-provisioning"
import {
  DEFAULT_TURN_PROVIDER,
  type AppSettings,
  type TurnProviderConfig,
  type TurnProviderKind,
} from "@cognia/agent-config-types"

const DEFAULT_STUN_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
]
const POLL_INTERVAL_MS = 3000
const POLL_FAILURE_BANNER_THRESHOLD = 3

export interface FormState {
  enabled: boolean
  signalingUrl: string
  iceServersText: string
  turnServersText: string
  // ADR-0021 — automatic ephemeral-TURN provider.
  turnProviderKind: TurnProviderKind
  /** Cloudflare Calls TURN Key ID. */
  turnProviderKeyId: string
  /** Twilio Account SID. */
  turnProviderSid: string
  /** Provider API secret entered this session; never re-read from keyring. */
  turnProviderToken: string
  /** Requested TTL (seconds) as raw text; blank = provider default. */
  turnProviderTtl: string
  /** Existing keyring sentinel (`kr:<keyId>`) for the stored secret, or "". */
  turnProviderSecretRef: string
}

const INITIAL: FormState = {
  enabled: true,
  signalingUrl: DEFAULT_SIGNALING_URL,
  iceServersText: DEFAULT_STUN_SERVERS.map((s) => urlsOf(s)).join("\n"),
  turnServersText: "",
  turnProviderKind: "none",
  turnProviderKeyId: "",
  turnProviderSid: "",
  turnProviderToken: "",
  turnProviderTtl: "",
  turnProviderSecretRef: "",
}

/** Build the keyring secret blob for the given provider kind. */
function secretFor(kind: TurnProviderKind, token: string): TurnProviderSecret {
  return kind === "twilio" ? { authToken: token } : { apiToken: token }
}

interface SignalingStatusSnapshot {
  enabled: boolean
  signalingUrl: string
  registeredDevices: string[]
}

/** Mirror of `DeviceTier` in `src-tauri/src/companion_api/signaling/mod.rs`. */
export type DeviceTier = "offline" | "awaiting" | "negotiating" | "relayed" | "connected" | "failed"

/** Mirror of `DeviceTierEntry` (camelCase via serde). */
export interface DeviceTierEntry {
  deviceId: string
  rendezvousId: string
  tier: DeviceTier
  lastError?: string
  updatedAtMs: number
}

export function WebRtcCard() {
  const t = useTranslations("mobile.companion.webrtc")
  const [form, setForm] = useState<FormState>(INITIAL)
  const [busy, setBusy] = useState(false)
  const [hydrating, setHydrating] = useState(true)
  const [status, setStatus] = useState<SignalingStatusSnapshot | null>(null)
  const [devices, setDevices] = useState<DeviceTierEntry[] | null>(null)
  const [pollFailureCount, setPollFailureCount] = useState(0)
  const [pollFailureMessage, setPollFailureMessage] = useState<string | null>(null)
  // The static TURN entries the stored config holds, with their resolved
  // credentials, so a save reuses the keyring entry of an unchanged line
  // instead of minting a new one each time.
  const [storedTurn, setStoredTurn] = useState<StoredTurnCredential[]>([])

  // Hydrate from Dexie on mount.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const s = await getSettings()
        if (cancelled) return
        // For display in the textarea we resolve sentinels back to
        // plaintext credentials — the textarea has always shown the
        // user the values it persists, and shipping a feature where
        // "TURN credentials disappear after save" would be a usability
        // regression.
        const displayTurn = await resolveTurnServerCredentials(s.turnServers ?? [])
        if (cancelled) return
        setStoredTurn(storedTurnCredentials(s.turnServers ?? [], displayTurn))
        const tp = s.turnProvider ?? DEFAULT_TURN_PROVIDER
        setForm({
          enabled: s.webrtcEnabled ?? true,
          signalingUrl: s.signalingUrl ?? DEFAULT_SIGNALING_URL,
          iceServersText: stringifyServers(s.iceServers ?? DEFAULT_STUN_SERVERS),
          turnServersText: stringifyServers(displayTurn),
          turnProviderKind: tp.kind,
          turnProviderKeyId: tp.cloudflareKeyId ?? "",
          turnProviderSid: tp.twilioAccountSid ?? "",
          // The secret is one-way (write-only); never resolved back into the form.
          turnProviderToken: "",
          turnProviderTtl: tp.ttlSeconds ? String(tp.ttlSeconds) : "",
          turnProviderSecretRef: tp.secretRef ?? "",
        })
      } catch {
        // Dexie unavailable (SSR / first load) — keep INITIAL.
      } finally {
        if (!cancelled) setHydrating(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Poll the Rust hub for both the global status and the per-device tier
  // table every 3 s while the card is mounted. The two commands always
  // succeed or fail together (same hub, same dispatch path), so we treat
  // them as a single sample.
  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        const [snapshot, deviceRows] = await Promise.all([
          transport.call<SignalingStatusSnapshot>("companion_signaling_status"),
          transport.call<DeviceTierEntry[]>("companion_signaling_devices_status"),
        ])
        if (cancelled) return
        setStatus(snapshot)
        setDevices(deviceRows)
        setPollFailureCount(0)
        setPollFailureMessage(null)
      } catch (err) {
        if (cancelled) return
        setPollFailureCount((n) => n + 1)
        setPollFailureMessage(err instanceof Error ? err.message : String(err))
      }
      if (!cancelled) timer = setTimeout(refresh, POLL_INTERVAL_MS)
    }
    void refresh()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  const onSave = useCallback(async () => {
    if (hydrating) return
    const url = form.signalingUrl.trim()
    if (!/^wss?:\/\//i.test(url)) {
      toast.error(t("invalidUrl"))
      return
    }
    setBusy(true)
    try {
      const { servers: ice, invalid: invalidIce } = parseServers(form.iceServersText, "ice")
      const { servers: turn, invalid: invalidTurn } = parseServers(form.turnServersText, "turn")
      // `value` is already redacted by the parser: an invalid line can still
      // carry a username and credential, and a toast is no place for them.
      for (const bad of invalidIce) {
        toast.warning(
          bad.reason === "wrong-field"
            ? t("turnInIceField", { value: bad.value })
            : t("invalidIceServer", { value: bad.value })
        )
      }
      for (const bad of invalidTurn) {
        toast.warning(
          bad.reason === "wrong-field"
            ? t("stunInTurnField", { value: bad.value })
            : t("invalidTurnServer", { value: bad.value })
        )
      }

      // The keyring entries the stored config references right now. A save
      // writes its new secrets first and commits settings second; only once
      // the commit landed are the entries it no longer references deleted.
      // Deleting first left a failed save pointing at a deleted secret.
      const before = referencedSecrets(await getSettings())
      const minted: MintedSecrets = { turn: [], provider: [] }
      let committed: {
        turnServers: RTCIceServer[]
        stored: StoredTurnCredential[]
        turnProvider: TurnProviderConfig
        nextSecretRef: string
      }
      try {
        // S1: TURN credentials never reach Dexie in plaintext. Dexie keeps the
        // URL and a `kr:<keyId>` sentinel; unchanged entries keep their key.
        const persisted = await persistTurnServers(
          turn,
          storedTurn.filter((entry) => before.turn.includes(entry.keyId)),
          minted
        )
        // ADR-0021 — the ephemeral-TURN provider. The API secret goes to the
        // OS keyring (one-way); Dexie keeps the kind, non-secret ids and a
        // `kr:<keyId>` sentinel.
        const { turnProvider, nextSecretRef } = await persistTurnProvider(form, minted)
        await saveSettings({
          webrtcEnabled: form.enabled,
          signalingUrl: url,
          iceServers: ice.length > 0 ? ice : undefined,
          turnServers: persisted.turnServers.length > 0 ? persisted.turnServers : undefined,
          turnProvider,
        })
        committed = { ...persisted, turnProvider, nextSecretRef }
      } catch (err) {
        // Nothing was committed: drop what this attempt minted and leave every
        // previously stored entry alone, since the stored config still uses it.
        await deleteSecrets(minted)
        throw err
      }
      await deleteSecrets(
        unreferencedSecrets(
          before,
          referencedSecrets({
            turnServers: committed.turnServers,
            turnProvider: committed.turnProvider,
          })
        )
      )
      setStoredTurn(committed.stored)
      // Clear the just-saved token from form state and reflect the stored
      // sentinel so the input shows the "token stored" placeholder.
      setForm((prev) => ({
        ...prev,
        turnProviderToken: "",
        turnProviderSecretRef: committed.nextSecretRef,
      }))
      toast.success(t("saved"))
    } catch (err) {
      toast.error(
        t("saveFailed", {
          reason: err instanceof Error ? err.message : String(err),
        })
      )
    } finally {
      setBusy(false)
    }
  }, [form, hydrating, storedTurn, t])

  const onTestProvider = useCallback(async () => {
    if (hydrating) return
    const kind = form.turnProviderKind
    if (kind === "none") return
    const token = form.turnProviderToken.trim()
    const provider: TurnProviderConfig = {
      kind,
      ttlSeconds: parseTtl(form.turnProviderTtl),
      cloudflareKeyId:
        kind === "cloudflare-calls" ? form.turnProviderKeyId.trim() || undefined : undefined,
      twilioAccountSid: kind === "twilio" ? form.turnProviderSid.trim() || undefined : undefined,
      // Use the freshly-entered token if present (test before save); else
      // fall back to the already-stored keyring secret.
      secretRef: token ? undefined : form.turnProviderSecretRef || undefined,
    }
    setBusy(true)
    try {
      const res = await provisionIceServers(
        provider,
        token ? { loadSecret: async () => secretFor(kind, token) } : undefined
      )
      toast.success(
        t("turnTestSuccess", {
          count: res.iceServers.length,
          expiresAt: new Date(res.expiresAt).toLocaleTimeString(),
        })
      )
    } catch (err) {
      toast.error(t("turnTestFailed", { reason: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }, [form, hydrating, t])

  const showPollBanner = pollFailureCount >= POLL_FAILURE_BANNER_THRESHOLD

  return (
    <SettingsBlock
      icon={<GlobeIcon />}
      title={t("title")}
      description={t("description")}
      action={
        <Switch
          checked={form.enabled}
          disabled={busy || hydrating}
          onCheckedChange={(v) => setForm((prev) => ({ ...prev, enabled: v }))}
          aria-label={t("enableLabel")}
          data-testid="webrtc-enable-toggle"
        />
      }
      testid="webrtc-card"
      settingId="companion-webrtc"
      contentClassName="space-y-3 text-sm"
    >
      <p className="text-xs text-muted-foreground">{t("enableHelp")}</p>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="webrtc-signaling-url" className="text-xs font-medium">
          {t("signalingUrlLabel")}
        </Label>
        <Input
          id="webrtc-signaling-url"
          value={form.signalingUrl}
          onChange={(e) => setForm((prev) => ({ ...prev, signalingUrl: e.target.value }))}
          placeholder={t("signalingUrlPlaceholder")}
          disabled={busy || hydrating}
          className="font-mono text-xs"
        />
        <p className="text-[10px] text-muted-foreground">{t("signalingUrlHelp")}</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="webrtc-ice-servers" className="text-xs font-medium">
          {t("iceServersLabel")}
        </Label>
        <Textarea
          id="webrtc-ice-servers"
          value={form.iceServersText}
          onChange={(e) => setForm((prev) => ({ ...prev, iceServersText: e.target.value }))}
          disabled={busy || hydrating}
          className="min-h-16 font-mono text-xs"
        />
        <p className="text-[10px] text-muted-foreground">{t("iceServersHelp")}</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="webrtc-turn-servers" className="text-xs font-medium">
          {t("turnServersLabel")}
        </Label>
        <Textarea
          id="webrtc-turn-servers"
          value={form.turnServersText}
          onChange={(e) => setForm((prev) => ({ ...prev, turnServersText: e.target.value }))}
          disabled={busy || hydrating}
          className="min-h-16 font-mono text-xs"
          placeholder={t("turnServersPlaceholder")}
        />
        <p className="text-[10px] text-muted-foreground">{t("turnServersHelp")}</p>
      </div>

      <div className="flex flex-col gap-1.5 rounded border border-dashed p-2">
        <Label htmlFor="webrtc-turn-provider" className="text-xs font-medium">
          {t("turnProviderLabel")}
        </Label>
        <NativeSelect
          id="webrtc-turn-provider"
          value={form.turnProviderKind}
          onChange={(e) =>
            setForm((prev) => ({
              ...prev,
              turnProviderKind: e.target.value as TurnProviderKind,
            }))
          }
          disabled={busy || hydrating}
          className="text-xs"
          wrapperClassName="w-full"
          data-testid="webrtc-turn-provider-kind"
        >
          <NativeSelectOption value="none">{t("turnProviderNone")}</NativeSelectOption>
          <NativeSelectOption value="cloudflare-calls">
            {t("turnProviderCloudflare")}
          </NativeSelectOption>
          <NativeSelectOption value="twilio">{t("turnProviderTwilio")}</NativeSelectOption>
        </NativeSelect>
        <p className="text-[10px] text-muted-foreground">{t("turnProviderHelp")}</p>

        {form.turnProviderKind === "cloudflare-calls" ? (
          <Input
            aria-label={t("turnProviderKeyIdLabel")}
            value={form.turnProviderKeyId}
            onChange={(e) => setForm((prev) => ({ ...prev, turnProviderKeyId: e.target.value }))}
            placeholder={t("turnProviderKeyIdLabel")}
            disabled={busy || hydrating}
            className="font-mono text-xs"
            data-testid="webrtc-turn-cf-keyid"
          />
        ) : null}
        {form.turnProviderKind === "twilio" ? (
          <Input
            aria-label={t("turnProviderSidLabel")}
            value={form.turnProviderSid}
            onChange={(e) => setForm((prev) => ({ ...prev, turnProviderSid: e.target.value }))}
            placeholder={t("turnProviderSidLabel")}
            disabled={busy || hydrating}
            className="font-mono text-xs"
            data-testid="webrtc-turn-twilio-sid"
          />
        ) : null}
        {form.turnProviderKind !== "none" ? (
          <>
            <Input
              type="password"
              aria-label={
                form.turnProviderKind === "twilio"
                  ? t("turnProviderAuthTokenLabel")
                  : t("turnProviderTokenLabel")
              }
              value={form.turnProviderToken}
              onChange={(e) => setForm((prev) => ({ ...prev, turnProviderToken: e.target.value }))}
              placeholder={
                form.turnProviderSecretRef
                  ? t("turnProviderTokenStored")
                  : form.turnProviderKind === "twilio"
                    ? t("turnProviderAuthTokenLabel")
                    : t("turnProviderTokenLabel")
              }
              disabled={busy || hydrating}
              className="font-mono text-xs"
              data-testid="webrtc-turn-token"
            />
            <Input
              aria-label={t("turnProviderTtlLabel")}
              value={form.turnProviderTtl}
              onChange={(e) => setForm((prev) => ({ ...prev, turnProviderTtl: e.target.value }))}
              placeholder={t("turnProviderTtlLabel")}
              disabled={busy || hydrating}
              inputMode="numeric"
              className="font-mono text-xs"
              data-testid="webrtc-turn-ttl"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={onTestProvider}
              disabled={busy || hydrating}
              data-testid="webrtc-turn-test"
            >
              {t("turnTestButton")}
            </Button>
          </>
        ) : null}
      </div>

      <Button size="sm" onClick={onSave} disabled={busy || hydrating} data-testid="webrtc-save">
        {busy ? t("savingButton") : t("saveButton")}
      </Button>

      {showPollBanner ? (
        <div
          className="flex flex-col gap-0.5 rounded border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          data-testid="webrtc-poll-error"
          role="alert"
        >
          <span className="font-medium">
            {t("pollFailed", { reason: pollFailureMessage ?? "" })}
          </span>
        </div>
      ) : null}

      {status ? <StatusBlock status={status} devices={devices} /> : null}
    </SettingsBlock>
  )
}

// ---------------------------------------------------------------------------
// Status sub-tree — exported for direct rendering in tests.
// ---------------------------------------------------------------------------

interface StatusBlockProps {
  status: SignalingStatusSnapshot
  devices: DeviceTierEntry[] | null
}

function StatusBlock({ status, devices }: StatusBlockProps): React.JSX.Element {
  const t = useTranslations("mobile.companion.webrtc")
  const [pendingReconnect, setPendingReconnect] = useState<string | null>(null)

  const onReconnect = useCallback(
    async (rendezvousId: string) => {
      setPendingReconnect(rendezvousId)
      try {
        await transport.call<void>("companion_signaling_reconnect_device", {
          rendezvousId,
        })
        toast.success(t("reconnectSuccess"))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // The Rust hub throttles repeated reconnects with an error
        // string prefixed `reconnect_throttled:`; surface that as a
        // warning instead of an error toast so the user understands
        // the action wasn't a failure on the desktop side.
        if (msg.startsWith("reconnect_throttled")) {
          toast.warning(t("reconnectThrottled"))
        } else {
          toast.error(t("reconnectFailed", { reason: msg }))
        }
      } finally {
        setPendingReconnect(null)
      }
    },
    [t]
  )

  // Hub disabled (master toggle off) — render a single Offline row.
  if (!status.enabled) {
    return (
      <div
        className="flex items-center gap-2 rounded border bg-card px-3 py-2 text-xs"
        data-testid="webrtc-status-disabled"
        role="status"
        aria-live="polite"
      >
        <TierDot tier="offline" />
        <span className="font-medium">{t("deviceTier.offline")}</span>
      </div>
    )
  }

  // No paired devices ever registered — surface an empty-state hint.
  if (!devices || devices.length === 0) {
    return (
      <div
        className="rounded border bg-card px-3 py-2 text-xs text-muted-foreground"
        data-testid="webrtc-status-empty"
        role="status"
        aria-live="polite"
      >
        {t("noDevices")}
      </div>
    )
  }

  return (
    <ul
      className="flex flex-col gap-1 rounded border bg-card p-1.5 text-xs"
      data-testid="webrtc-device-tier-list"
      role="status"
      aria-live="polite"
    >
      {devices.map((d) => (
        <li
          key={d.rendezvousId}
          className="flex flex-col gap-1 rounded px-2 py-1.5 sm:flex-row sm:items-center sm:gap-2"
          data-testid={`webrtc-device-row-${d.deviceId}`}
        >
          <TierDot tier={d.tier} />
          <span
            className="font-mono text-[10px] text-muted-foreground sm:flex-1"
            title={d.deviceId}
          >
            {truncateId(d.deviceId)}
          </span>
          <span className="font-medium">{t(`deviceTier.${d.tier}`)}</span>
          <span className="text-[10px] text-muted-foreground">{t("protocolMode")}</span>
          {d.lastError && d.tier === "failed" ? (
            <span className="text-[10px] text-destructive sm:ml-2" title={d.lastError}>
              {truncateError(d.lastError)}
            </span>
          ) : null}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="ml-auto size-6 shrink-0"
            disabled={pendingReconnect === d.rendezvousId}
            onClick={() => {
              void onReconnect(d.rendezvousId)
            }}
            aria-label={t("reconnectButton")}
            title={t("reconnectButton")}
            data-testid={`webrtc-reconnect-${d.deviceId}`}
          >
            <RefreshCwIcon
              aria-hidden="true"
              className={cn("size-3.5", pendingReconnect === d.rendezvousId && "animate-spin")}
            />
          </Button>
        </li>
      ))}
    </ul>
  )
}

interface TierDotProps {
  tier: DeviceTier
  className?: string
}

/** Color-coded status dot shared between the desktop card and the mobile
 *  tier indicator. Five colors → five tiers, one source of truth. */
export function TierDot({ tier, className }: TierDotProps): React.JSX.Element {
  const palette: Record<DeviceTier, string> = {
    connected: "fill-emerald-500 text-emerald-500",
    relayed: "fill-amber-500 text-amber-500",
    negotiating: "fill-amber-500 text-amber-500",
    awaiting: "fill-sky-500 text-sky-500",
    failed: "fill-destructive text-destructive",
    offline: "fill-muted-foreground text-muted-foreground",
  }
  return (
    <CircleIcon aria-hidden="true" className={cn("size-2 shrink-0", palette[tier], className)} />
  )
}

// ---------------------------------------------------------------------------
// Helpers — exported for unit testing.
// ---------------------------------------------------------------------------

/** Parse the raw TTL textbox into seconds, or `undefined` for the default. */
export function parseTtl(text: string): number | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  const n = Number(trimmed)
  return Number.isFinite(n) && n > 0 ? clampTtl(n) : undefined
}

/** Keyring entries one save attempt wrote, deleted again if the attempt fails. */
export interface MintedSecrets {
  /** TURN credential key ids (`lib/credentials/turn-credentials.ts`). */
  turn: string[]
  /** TURN provider secret key ids (`lib/credentials/turn-provisioning.ts`). */
  provider: string[]
}

/**
 * A static TURN entry the stored config holds, resolved: one row per URL, with
 * the keyring id its credentials live under.
 */
export interface StoredTurnCredential {
  url: string
  username: string
  credential: string
  keyId: string
}

/**
 * Pair the stored TURN entries with their keyring-resolved form.
 * `resolved` is `resolveTurnServerCredentials(stored)`, which keeps order and
 * length; an entry without a sentinel, or whose keyring entry is gone, has no
 * key to reuse and is left out.
 */
export function storedTurnCredentials(
  stored: readonly RTCIceServer[],
  resolved: readonly RTCIceServer[]
): StoredTurnCredential[] {
  const out: StoredTurnCredential[] = []
  stored.forEach((server, index) => {
    const keyId = keyIdOfSentinel(typeof server.credential === "string" ? server.credential : null)
    const plain = resolved[index]
    if (!keyId || !plain?.username || typeof plain.credential !== "string") return
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls]
    for (const url of urls) {
      out.push({ url, username: plain.username, credential: plain.credential, keyId })
    }
  })
  return out
}

/**
 * Turn the parsed TURN lines into the Dexie-safe list: credentials move to the
 * OS keyring and the entry keeps a `kr:<keyId>` sentinel. A line whose URL,
 * username and credential match a stored entry keeps that entry's key, so
 * saving an unchanged form writes nothing to the keyring. Every key minted is
 * recorded in `minted` before its write, so a failed attempt can drop it.
 * Exported for unit testing.
 */
export async function persistTurnServers(
  entries: readonly RTCIceServer[],
  stored: readonly StoredTurnCredential[],
  minted: MintedSecrets
): Promise<{ turnServers: RTCIceServer[]; stored: StoredTurnCredential[] }> {
  const turnServers: RTCIceServer[] = []
  const nextStored: StoredTurnCredential[] = []
  for (const entry of entries) {
    const url = Array.isArray(entry.urls) ? entry.urls[0] : entry.urls
    const credential = typeof entry.credential === "string" ? entry.credential : ""
    const username = entry.username ?? ""
    if (credential.startsWith(KEYRING_CREDENTIAL_PREFIX)) {
      // Already a sentinel (typed or pasted as one): the secret is in the
      // keyring, and the username with it.
      turnServers.push({ urls: entry.urls, credential })
      continue
    }
    if (!username || !credential) {
      // Nothing secret to store.
      turnServers.push({ urls: entry.urls })
      continue
    }
    const same = stored.find(
      (s) => s.url === url && s.username === username && s.credential === credential
    )
    const keyId = same?.keyId ?? freshCredentialKeyId()
    if (!same) {
      minted.turn.push(keyId)
      await saveTurnCredential(keyId, { username, credential })
    }
    turnServers.push({ urls: entry.urls, credential: `${KEYRING_CREDENTIAL_PREFIX}${keyId}` })
    nextStored.push({ url, username, credential, keyId })
  }
  return { turnServers, stored: nextStored }
}

/**
 * Persist the TURN-provider section of the form: write a newly entered API
 * secret to the OS keyring (one-way, recorded in `minted`) and return the
 * Dexie-safe `TurnProviderConfig` (kind + non-secret ids + `kr:<keyId>`
 * sentinel). It deletes nothing: the secret a new one replaces, or the one
 * kind `"none"` drops, is still the stored config's until the save commits,
 * and `unreferencedSecrets` names it afterwards. Exported for unit testing.
 */
export async function persistTurnProvider(
  form: FormState,
  minted: MintedSecrets
): Promise<{ turnProvider: TurnProviderConfig; nextSecretRef: string }> {
  const kind = form.turnProviderKind
  if (kind === "none") {
    return { turnProvider: { kind: "none" }, nextSecretRef: "" }
  }
  let secretRef = form.turnProviderSecretRef
  const token = form.turnProviderToken.trim()
  if (token) {
    const keyId = freshCredentialKeyId()
    minted.provider.push(keyId)
    await saveProviderSecret(keyId, secretFor(kind, token))
    secretRef = `${KEYRING_CREDENTIAL_PREFIX}${keyId}`
  }
  const turnProvider: TurnProviderConfig = {
    kind,
    ttlSeconds: parseTtl(form.turnProviderTtl),
    cloudflareKeyId:
      kind === "cloudflare-calls" ? form.turnProviderKeyId.trim() || undefined : undefined,
    twilioAccountSid: kind === "twilio" ? form.turnProviderSid.trim() || undefined : undefined,
    secretRef: secretRef || undefined,
  }
  return { turnProvider, nextSecretRef: secretRef }
}

/** The keyring entries a stored WebRTC config references. */
export function referencedSecrets(
  config: Pick<AppSettings, "turnServers" | "turnProvider">
): MintedSecrets {
  const turn = new Set<string>()
  for (const server of config.turnServers ?? []) {
    const keyId = keyIdOfSentinel(typeof server.credential === "string" ? server.credential : null)
    if (keyId) turn.add(keyId)
  }
  const providerKey = keyIdOfSentinel(config.turnProvider?.secretRef ?? null)
  return { turn: [...turn], provider: providerKey ? [providerKey] : [] }
}

/** The entries `before` referenced that `after` no longer does. */
export function unreferencedSecrets(before: MintedSecrets, after: MintedSecrets): MintedSecrets {
  return {
    turn: before.turn.filter((keyId) => !after.turn.includes(keyId)),
    provider: before.provider.filter((keyId) => !after.provider.includes(keyId)),
  }
}

/**
 * Delete keyring entries, every one attempted. A failure leaves an orphaned
 * entry nothing references, which is logged rather than failing a save that
 * already committed (or masking the error of one that did not).
 */
export async function deleteSecrets(secrets: MintedSecrets): Promise<void> {
  const deletions = [
    ...secrets.turn.map((keyId) => ({ keyId, run: () => deleteTurnCredential(keyId) })),
    ...secrets.provider.map((keyId) => ({ keyId, run: () => deleteProviderSecret(keyId) })),
  ]
  for (const { keyId, run } of deletions) {
    try {
      await run()
    } catch (err) {
      console.warn(`[webrtc-card] could not delete keyring entry ${keyId}`, err)
    }
  }
}

/** Renders a `RTCIceServer.urls` (string | string[]) back as one URL per line. */
function urlsOf(server: RTCIceServer): string {
  const list = Array.isArray(server.urls) ? server.urls : [server.urls]
  return list.join("\n")
}

/** Encode `RTCIceServer[]` into the textarea text format. */
export function stringifyServers(servers: RTCIceServer[]): string {
  return servers
    .map((s) => {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls]
      return urls
        .map((u) => {
          if (s.username && s.credential) {
            return `${u}|${s.username}|${s.credential}`
          }
          return u
        })
        .join("\n")
    })
    .join("\n")
}

/** Which textarea a server list comes from. */
export type ServerField = "ice" | "turn"

export interface InvalidServerLine {
  /** The line, redacted (`redactServerLine`): safe to show. */
  value: string
  /**
   * `wrong-field`: a valid entry for the other textarea (a TURN line in the
   * STUN field, or the reverse). `malformed`: valid in neither.
   */
  reason: "malformed" | "wrong-field"
}

export interface ParseServersResult {
  servers: RTCIceServer[]
  /** Invalid lines that were skipped. The caller toasts these. */
  invalid: InvalidServerLine[]
}

/** What stands in for a credential in a line shown back to the user. */
const CREDENTIAL_MASK = "•••"

/**
 * The part of a server line that is safe to show: the URL, with any
 * `|username|credential` suffix masked, and so are userinfo before an `@` and
 * any query other than the `transport=udp|tcp` the parser accepts. Invalid
 * lines are echoed in a toast, and they can carry real credentials.
 */
export function redactServerLine(line: string): string {
  const bar = line.indexOf("|")
  let url = (bar === -1 ? line : line.slice(0, bar)).trim()
  url = url.replace(/^([a-z][a-z0-9+.-]*:(?:\/\/)?)[^@/]*@/i, `$1${CREDENTIAL_MASK}@`)
  const query = url.indexOf("?")
  if (query !== -1 && !/^transport=(udp|tcp)$/i.test(url.slice(query + 1))) {
    url = `${url.slice(0, query)}?${CREDENTIAL_MASK}`
  }
  return bar === -1 ? url : `${url}|${CREDENTIAL_MASK}`
}

/**
 * Parse one URL per line for the given field. Blank lines and `#` comments
 * are ignored.
 *
 * - `ice` (the STUN field): `stun:` URLs only, without any `|` part. A
 *   `turn:` / `turns:` line here is rejected: this list is stored as typed,
 *   so its credential would reach Dexie in plaintext.
 * - `turn`: `turn:` / `turns:` URLs with a `|username|credential` suffix, the
 *   one path whose credentials go to the OS keyring.
 */
export function parseServers(text: string, field: ServerField): ParseServersResult {
  const servers: RTCIceServer[] = []
  const invalid: InvalidServerLine[] = []
  const skip = (line: string, reason: InvalidServerLine["reason"]) =>
    invalid.push({ value: redactServerLine(line), reason })
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const parts = line.split("|")
    const url = parts[0]?.trim() ?? ""
    const isTurn = /^turns?:/i.test(url)
    const isStun = /^stun:/i.test(url)
    if (field === "ice" ? isTurn : isStun) {
      skip(line, isValidIceUrl(url) ? "wrong-field" : "malformed")
      continue
    }
    if (!isValidIceUrl(url)) {
      skip(line, "malformed")
      continue
    }
    if (field === "ice") {
      if (parts.length === 1) servers.push({ urls: url })
      else skip(line, "malformed")
      continue
    }
    if (parts.length !== 3 || !parts[1]?.trim() || !parts[2]?.trim()) {
      skip(line, "malformed")
      continue
    }
    servers.push({ urls: url, username: parts[1].trim(), credential: parts[2].trim() })
  }
  return { servers, invalid }
}

function isValidIceUrl(raw: string): boolean {
  if (/[\s#]/.test(raw)) return false
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return false
  }
  const scheme = parsed.protocol.toLowerCase()
  if (scheme !== "stun:" && scheme !== "turn:" && scheme !== "turns:") return false

  const address = parsed.pathname
  const bracketed = address.match(/^\[[0-9a-f:.]+\](?::(\d{1,5}))?$/i)
  const hostname = address.match(/^[a-z0-9.-]+(?::(\d{1,5}))?$/i)
  const portText = bracketed?.[1] ?? hostname?.[1]
  if (!bracketed && !hostname) return false
  if (portText && (Number(portText) < 1 || Number(portText) > 65_535)) return false

  const query = [...parsed.searchParams.entries()]
  if (query.length === 0) return true
  if (
    query.length !== 1 ||
    query[0][0] !== "transport" ||
    !["udp", "tcp"].includes(query[0][1].toLowerCase())
  ) {
    return false
  }
  return scheme !== "turns:" || query[0][1].toLowerCase() === "tcp"
}

function truncateId(deviceId: string): string {
  // Device IDs are UUIDs (~36 chars); show enough to disambiguate without
  // overflowing on narrow mobile previews. Falls back to the full string
  // for short identifiers.
  if (deviceId.length <= 14) return deviceId
  return `${deviceId.slice(0, 6)}…${deviceId.slice(-4)}`
}

function truncateError(message: string): string {
  if (message.length <= 60) return message
  return `${message.slice(0, 57)}…`
}
