"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import type { ConnectionPrompt, ConnectionPromptResult } from "@/lib/plugin/auth/connection-prompts"
import type { AuthMethod } from "@cognia/plugin-contract/types/plugin/plugin-auth"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { NativeSelect } from "@/components/ui/native-select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/** Configuration stays in the Host form and is never written into plugin settings. */
export function ConnectionConfigurationDialog({
  request,
  onResolve,
}: {
  request: Extract<ConnectionPrompt, { kind: "configure" | "connect-error" }>
  onResolve: (result: ConnectionPromptResult) => void
}) {
  const t = useTranslations("plugins.auth.connections")
  const [values, setValues] = useState(request.kind === "configure" ? request.defaults : {})
  const [method, setMethod] = useState<AuthMethod>(
    request.kind === "configure" ? request.methods[0] : "oauth-pkce"
  )
  const dismiss = () => onResolve({ kind: "dismissed" })
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss()
      }}
    >
      <DialogContent showCloseButton={false} className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {request.kind === "configure"
              ? t("setupTitle", { provider: request.providerLabel })
              : t("connectFailed")}
          </DialogTitle>
          <DialogDescription>
            {request.kind === "configure"
              ? t("setupDescription")
              : t(
                  request.reason === "tenant-scope-required"
                    ? "tenantScopeRequired"
                    : "identityConflict"
                )}
          </DialogDescription>
        </DialogHeader>
        {request.kind === "configure" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              onResolve({
                kind: "configured",
                method,
                configuration: Object.fromEntries(
                  Object.entries(values).filter(([, value]) => value !== "")
                ),
              })
            }}
            className="space-y-6"
          >
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel htmlFor="auth-issuer">{t("deployment")}</FieldLabel>
                <NativeSelect
                  native
                  id="auth-issuer"
                  className="w-full"
                  value={values.issuer}
                  onChange={(event) => setValues({ ...values, issuer: event.target.value })}
                >
                  {request.issuers.map((issuer) => (
                    <option key={issuer} value={issuer}>
                      {issuer}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="auth-method">{t("principal")}</FieldLabel>
                <NativeSelect
                  native
                  id="auth-method"
                  className="w-full"
                  value={method}
                  onChange={(event) => setMethod(event.target.value as AuthMethod)}
                >
                  {request.methods.map((item) => (
                    <option key={item} value={item}>
                      {t(
                        item === "oauth-pkce"
                          ? "userPrincipal"
                          : item === "client-credentials"
                            ? "botPrincipal"
                            : "otherMethod",
                        { method: item }
                      )}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              {Object.entries(request.schema.properties)
                .filter(([key]) => key !== "redirectUri" || method === "oauth-pkce")
                .map(([key, field]) => (
                  <Field key={key}>
                    <FieldLabel htmlFor={`auth-config-${key}`}>
                      {t(
                        key === "appId"
                          ? "appId"
                          : key === "clientSecret"
                            ? "clientSecret"
                            : key === "redirectUri"
                              ? "redirectUri"
                              : "configurationField",
                        { field: key }
                      )}
                    </FieldLabel>
                    {field.enum && field.format !== "secret" ? (
                      <NativeSelect
                        native
                        id={`auth-config-${key}`}
                        className="w-full"
                        value={values[key] ?? ""}
                        required={request.schema.required?.includes(key)}
                        onChange={(event) => setValues({ ...values, [key]: event.target.value })}
                      >
                        <option value="">{t("configurationField", { field: key })}</option>
                        {field.enum.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </NativeSelect>
                    ) : (
                      <Input
                        id={`auth-config-${key}`}
                        type={field.format === "secret" ? "password" : "text"}
                        autoComplete={field.format === "secret" ? "new-password" : "off"}
                        value={values[key] ?? ""}
                        minLength={field.minLength}
                        required={request.schema.required?.includes(key)}
                        onChange={(event) => setValues({ ...values, [key]: event.target.value })}
                      />
                    )}
                  </Field>
                ))}
            </FieldGroup>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={dismiss}>
                {t("dismiss")}
              </Button>
              <Button type="submit">{t("signIn")}</Button>
            </DialogFooter>
          </form>
        ) : (
          <DialogFooter>
            <Button onClick={dismiss}>{t("dismiss")}</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
