"use client"

import { useEffect, useId, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Field, FieldGroup } from "@/components/ui/field"
import { Checkbox } from "@/components/ui/checkbox"
import { Textarea } from "@/components/ui/textarea"
import { NativeSelect } from "@/components/ui/native-select"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useOpencodeAuth } from "@/hooks/agent/use-opencode-auth"
import { openUrl } from "@/lib/native/opener"
import {
  initialOAuthAnswers,
  isHttpAuthorizationUrl,
  visibleOAuthFields,
  type FormAnswer,
  type IntegrationOAuthMethod,
  type OpenCodeV2Auth,
} from "@cognia/agent-opencode/v2-auth"

/** The Agent owns the UI; the connected OpenCode service owns all accounts. */
export function OpencodeAuthPanel({
  agentId,
  connected,
  onAuthenticated,
}: {
  agentId: string
  connected: boolean
  onAuthenticated: () => Promise<void>
}) {
  const t = useTranslations("externalAgent.settings.opencode.auth")
  const { controller, snapshot, available, failed } = useOpencodeAuth(agentId, connected)
  const integrations = snapshot.integrations.filter(
    (entry) => entry.methods.length || entry.connections.length
  )
  const [selection, setSelection] = useState<{
    integrationID: string
    name: string
    method: IntegrationOAuthMethod
    controller: OpenCodeV2Auth
  }>()

  useEffect(() => {
    if (snapshot.phase === "complete") void onAuthenticated()
  }, [snapshot.phase, onAuthenticated])

  if (failed)
    return (
      <p role="alert" className="text-xs text-destructive">
        {t("errors.load")}
      </p>
    )
  if (!available || !controller) return null

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{t("title")}</span>
        <Button
          size="sm"
          variant="ghost"
          disabled={snapshot.loading}
          onClick={() => void controller.refresh()}
        >
          {t("refresh")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("ownership")}</p>
      {snapshot.error === "load" && (
        <p role="alert" className="text-xs text-destructive">
          {t("errors.load")}
        </p>
      )}
      {!snapshot.loading && !snapshot.error && integrations.length === 0 && (
        <p className="text-xs text-muted-foreground">{t("empty")}</p>
      )}
      {integrations.map((entry) => (
        <div key={entry.id} className="space-y-2 rounded-md border p-3">
          <p className="text-xs font-medium">{entry.name}</p>
          {entry.connections.length === 0 && (
            <p className="text-xs text-muted-foreground">{t("notSignedIn")}</p>
          )}
          {entry.connections.map((connection) => (
            <p
              key={connection.id ?? connection.label}
              className="flex flex-wrap items-center gap-2 text-xs"
            >
              <span>{connection.label}</span>
              <Badge variant={connection.needsAuth ? "outline" : "secondary"}>
                {t(connection.needsAuth ? "needsAuth" : "signedIn")}
              </Badge>
            </p>
          ))}
          <div className="flex flex-wrap gap-2">
            {entry.methods.map((method) => (
              <Button
                key={method.id}
                size="sm"
                variant="outline"
                onClick={() => {
                  void controller.cancel().then((cancelled) => {
                    if (cancelled)
                      setSelection({
                        integrationID: entry.id,
                        name: entry.name,
                        method,
                        controller,
                      })
                  })
                }}
              >
                {t("signInWith", { method: method.label })}
              </Button>
            ))}
          </div>
        </div>
      ))}
      {selection && selection.controller === controller && (
        <OpencodeLoginDialog
          key={`${selection.integrationID}:${selection.method.id}`}
          controller={controller}
          selection={selection}
          onClose={() => setSelection(undefined)}
        />
      )}
    </div>
  )
}

function OpencodeLoginDialog({
  controller,
  selection,
  onClose,
}: {
  controller: OpenCodeV2Auth
  selection: { integrationID: string; name: string; method: IntegrationOAuthMethod }
  onClose: () => void
}) {
  const t = useTranslations("externalAgent.settings.opencode.auth")
  // The parent subscribes to this same controller; its updates render the dialog.
  const state = controller.getSnapshot()
  const prefix = useId()
  const fields = selection.method.form ?? []
  const [answers, setAnswers] = useState<FormAnswer>(() => initialOAuthAnswers(fields))
  const [code, setCode] = useState("")
  const [openFailed, setOpenFailed] = useState(false)
  const busy = ["starting", "submitting", "cancelling"].includes(state.phase)
  const close = async () => {
    if (await controller.cancel()) onClose()
  }
  const open = async () => {
    if (!state.attempt || !isHttpAuthorizationUrl(state.attempt.url)) return
    try {
      await openUrl(state.attempt.url)
      setOpenFailed(false)
    } catch {
      setOpenFailed(true)
    }
  }
  const activeFields = visibleOAuthFields(fields, answers)
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) void close()
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("dialogTitle", { provider: selection.name })}</DialogTitle>
          <DialogDescription>{t("ownership")}</DialogDescription>
        </DialogHeader>
        {state.error && (
          <p role="alert" className="text-sm text-destructive">
            {t(`errors.${state.error}`)}
          </p>
        )}
        {openFailed && (
          <p role="alert" className="text-sm text-destructive">
            {t("errors.open")}
          </p>
        )}
        {state.phase === "complete" ? (
          <p role="status">{t("success")}</p>
        ) : state.attempt ? (
          <div className="space-y-3">
            <p role="status" className="text-sm">
              {t("waiting")}
            </p>
            <p className="whitespace-pre-wrap break-words text-sm">{state.attempt.instructions}</p>
            {isHttpAuthorizationUrl(state.attempt.url) && (
              <>
                <Button variant="outline" onClick={() => void open()}>
                  {t("open")}
                </Button>
                <p className="break-all text-xs text-muted-foreground">{state.attempt.url}</p>
              </>
            )}
            {state.attempt.mode === "code" && (
              <form
                className="space-y-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  void controller.complete(code)
                }}
              >
                <Label htmlFor={`${prefix}-code`}>{t("code")}</Label>
                <Input
                  id={`${prefix}-code`}
                  autoComplete="off"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
                <Button disabled={busy || !code.trim()} type="submit">
                  {t("submit")}
                </Button>
              </form>
            )}
            {state.error === "status" && (
              <Button disabled={busy} variant="outline" onClick={() => void controller.check()}>
                {t("retryStatus")}
              </Button>
            )}
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              const answer = Object.fromEntries(
                activeFields
                  .filter(
                    (field) =>
                      field.type !== "external" &&
                      answers[field.key] !== undefined &&
                      !(
                        (field.type === "number" || field.type === "integer") &&
                        answers[field.key] === ""
                      )
                  )
                  .map((field) => [
                    field.key,
                    field.type === "multiselect" && Array.isArray(answers[field.key])
                      ? (answers[field.key] as string[])
                          .map((value) => value.trim())
                          .filter(Boolean)
                      : answers[field.key],
                  ])
              )
              void controller.start(selection.integrationID, selection.method.id, answer)
            }}
          >
            <fieldset disabled={busy} className="space-y-3">
              <FieldGroup>
                {activeFields.map((field) => {
                  if (field.type === "external")
                    return isHttpAuthorizationUrl(field.url) ? (
                      <a
                        key={field.key}
                        href={field.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-sm underline"
                      >
                        {field.title ?? t("open")}
                      </a>
                    ) : null
                  if (field.hidden) return null
                  const id = `${prefix}-${field.key}`
                  const label = field.title ?? field.key
                  const value = answers[field.key]
                  const update = (value: FormAnswer[string]) =>
                    setAnswers((previous) => ({ ...previous, [field.key]: value }))
                  return (
                    <Field key={field.key}>
                      <Label htmlFor={id}>{label}</Label>
                      {field.type === "boolean" ? (
                        <Checkbox
                          id={id}
                          checked={value === true}
                          onCheckedChange={(checked) => update(checked === true)}
                        />
                      ) : field.type === "multiselect" && field.custom ? (
                        <div className="space-y-1">
                          <Textarea
                            id={id}
                            required={field.required}
                            value={Array.isArray(value) ? value.join("\n") : ""}
                            onChange={(event) => update(event.target.value.split("\n"))}
                          />
                          <p className="text-xs text-muted-foreground">{t("onePerLine")}</p>
                        </div>
                      ) : field.type === "multiselect" ? (
                        <NativeSelect
                          native
                          id={id}
                          multiple
                          className="w-full rounded-md border bg-background p-2 text-sm"
                          value={Array.isArray(value) ? value : []}
                          required={field.required}
                          onChange={(event) =>
                            update(
                              Array.from(event.target.selectedOptions, (option) => option.value)
                            )
                          }
                        >
                          {field.options.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </NativeSelect>
                      ) : field.type === "string" && field.options && !field.custom ? (
                        <NativeSelect
                          native
                          id={id}
                          className="w-full rounded-md border bg-background p-2 text-sm"
                          required={field.required}
                          value={typeof value === "string" ? value : ""}
                          onChange={(event) => update(event.target.value)}
                        >
                          <option value="">{t("choose")}</option>
                          {field.options.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </NativeSelect>
                      ) : (
                        <Input
                          id={id}
                          required={field.required}
                          autoComplete="off"
                          type={
                            field.type === "string"
                              ? field.format === "uri"
                                ? "url"
                                : field.format === "email"
                                  ? "email"
                                  : "text"
                              : "number"
                          }
                          value={
                            typeof value === "number" || typeof value === "string" ? value : ""
                          }
                          min={
                            "minimum" in field && typeof field.minimum === "number"
                              ? field.minimum
                              : undefined
                          }
                          max={
                            "maximum" in field && typeof field.maximum === "number"
                              ? field.maximum
                              : undefined
                          }
                          step={
                            field.type === "integer"
                              ? 1
                              : field.type === "number"
                                ? "any"
                                : undefined
                          }
                          minLength={field.type === "string" ? field.minLength : undefined}
                          maxLength={field.type === "string" ? field.maxLength : undefined}
                          pattern={field.type === "string" ? field.pattern : undefined}
                          placeholder={field.type === "string" ? field.placeholder : undefined}
                          onChange={(event) =>
                            update(
                              field.type === "string" || !event.target.value
                                ? event.target.value
                                : Number(event.target.value)
                            )
                          }
                        />
                      )}
                      {field.description && (
                        <p className="text-xs text-muted-foreground">{field.description}</p>
                      )}
                    </Field>
                  )
                })}
              </FieldGroup>
              <Button type="submit" disabled={busy}>
                {t(state.phase === "starting" ? "starting" : "continue")}
              </Button>
            </fieldset>
          </form>
        )}
        <Button
          variant="ghost"
          disabled={state.phase === "cancelling"}
          onClick={() => void close()}
        >
          {t(state.phase === "complete" ? "done" : "cancel")}
        </Button>
      </DialogContent>
    </Dialog>
  )
}
