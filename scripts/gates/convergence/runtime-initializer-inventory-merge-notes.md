# B6 v2 merge notes — delete after merge

Verified 2026-11-01 against `/tmp/conv0a/b6-exclusions-v2.json` and `/tmp/conv0a/b6-check-headless-registry.mjs` (B6 `f4cdf4ccb0`). Keep the committed inventory valid with this worktree’s v1 ledger until merge. All initializer filenames below are relative to `components/providers/initializers/`; keys remain `<initializer>#<symbol>@<module>`.

## Remove 35 members excluded by v2

These rows disappear from detection under v2; remove them rather than copying them into inventory exclusions.

| Initializer                              | Member symbols to remove                                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `chat-copilot-initializer.tsx`           | `createScreenCopilotController`, `onChatCopilotIntent`                                                            |
| `cli-sync-initializer.tsx`               | `maybeAutoPushToCli`                                                                                              |
| `cloud-identity-initializer.tsx`         | `discardLegacyGlobalLogtoSession`                                                                                 |
| `connector-host-writes-initializer.tsx`  | `createHostAdapterInstanceWriter`, `setAdapterInstanceRemoteWriter`                                               |
| `dock-pages-lifecycle-initializer.tsx`   | `primeLocalBrowserRouting`                                                                                        |
| `fleet-history-sink-initializer.tsx`     | `fleetMonitorRestore`, `islandRestore`                                                                            |
| `glance-publisher-initializer.tsx`       | `onGlanceRequest`, `onGlanceSubscription`, `sendGlanceSnapshot`                                                   |
| `island-initializer.tsx`                 | `onIslandActionIntent`, `onIslandDetailRequest`, `onIslandStateRequest`, `sendIslandState`                        |
| `managed-desktop-alerts-initializer.tsx` | `startManagedDesktopAlerts`                                                                                       |
| `provider-oauth-refresh-initializer.tsx` | `refreshExpiringOAuthCredentials`                                                                                 |
| `remote-host-keys-initializer.tsx`       | `followRemoteHostKeys`                                                                                            |
| `remote-host-liveness-initializer.tsx`   | `startHostLivenessLoop`                                                                                           |
| `session-import-watch-initializer.tsx`   | `retargetSessionImportWatch`, `stopSessionImportWatch`                                                            |
| `shared-chat-lifecycle-initializer.tsx`  | `connectSharedSessionStream`, `listAndCacheSharedSessions`, `recoverSharedSessionRun`, `suspendSharedSessionRuns` |
| `subscription-initializer.tsx`           | `deferUntilSecretStoreReady`, `subscriptionInitOnce`                                                              |
| `terminal-boot-initializer.tsx`          | `rehydrateTerminals`                                                                                              |
| `tray-panel-initializer.tsx`             | `onTrayPanelRequest`                                                                                              |
| `update-center-initializer.tsx`          | `getAppUpdateInfo`, `getGooglePlayServicesStatus`, `getUpdateCoordinator`                                         |
| `usage-dock-initializer.tsx`             | `onUsageDockOpenFull`, `onUsageDockStateRequest`                                                                  |

## Update 19 notes and promote 2 template helpers

For each of the following 21 detected pending rows, prefix the existing source-specific note with `pending:${phase} ${JSON.stringify(firstSentence)} `, removing an existing `pending-exclusion:` prefix when present. `firstSentence` comes from that B6 entry and ends at `.`, `!` or `?` followed by whitespace/end, as in the gate. Retain the reviewed function/capability explanation after the quoted reason. The two promote rows move from `excluded` to `members`, lose `reason`, and receive the same prefix plus an explanation of their template-source/feature-flag role within the B6-pending platform lifecycle; do not hand-add candidates. Recompute pendingPhase/metrics and retain their matching evidence fingerprints; changed evidence requires an explicit reviewed `--reconfirm <key>`.

| Initializer                            | Phase   | Existing members: replace note                                                                                                                 | Move from exclusions to members                                   |
| -------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `background-task-initializer.tsx`      | phase 2 | `setRendererBackgroundSettleListener`                                                                                                          | —                                                                 |
| `best-of-n-recovery-initializer.tsx`   | phase 1 | `recoverBestOfNRunsOnStartup`                                                                                                                  | —                                                                 |
| `chat-middleware-flag-initializer.tsx` | phase 1 | `setChatMiddlewareExecutionEnabled`                                                                                                            | —                                                                 |
| `harness-evolution-initializer.tsx`    | phase 1 | `defaultFailureTriggerDeps`, `enqueueRunForFailure`, `installHarnessNotificationActions`, `installLiveToolRules`, `recoverOrphanedHarnessRuns` | —                                                                 |
| `models-dev-catalog-initializer.tsx`   | phase 1 | `initializeProviderCatalog`                                                                                                                    | —                                                                 |
| `openrouter-catalog-initializer.tsx`   | phase 1 | `refreshOpenRouterCatalogIfStale`                                                                                                              | —                                                                 |
| `plugin-runtime-initializer.tsx`       | phase 1 | `seedBundledPluginsOnHost`, `setPluginSecurityPostureSource`                                                                                   | —                                                                 |
| `provider-cost-mirror-initializer.tsx` | phase 1 | `rebuildProviderCostDaily`, `setBudgetMirrorSink`                                                                                              | —                                                                 |
| `routing-runtime-initializer.tsx`      | phase 1 | `installDesktopCertificationRuntime`, `rebuildCompatibilityProjection`                                                                         | —                                                                 |
| `template-platform-initializer.tsx`    | phase 1 | `migrateLegacyTemplates`, `refreshBuiltInTemplateOverlays`, `refreshCatalogOnlyTemplateAdapters`                                               | `createLegacyTemplateSources`, `isUnifiedTemplatePlatformEnabled` |

Use the v2 override with `--write-baseline` to refresh computed fields (including `pendingPhase`), remove the 35 repaid members and 57 stale inventory exclusions, and promote the 2 pending helpers. Then apply the notes above and adjudicate the five rows below before expecting a v2 gate pass. The 8 external `pending-b6:` members and desktop-bound `tauri-provider.tsx#dispatchDesktopDeeplink` keep their notes; they are outside B6’s file boundary.

## When B6's helper exports land too

An in-memory counter probe importing the copied B6 module finds 188 candidates instead of the v2-ledger-only 179. The only 9 additions are below, all in `components/providers/companion-boot-provider.tsx`, whose owning effect is gated on `platform === "mobile"` at :195–196. After that merge's baseline rewrite, move these new rows into inventory `excluded` with the source-specific reasons below; they are not additional headless debt. Do not add them to the current v1 inventory, where they would be stale. Keys use that provider plus the listed symbol and the detected module.

| Added symbol                | Effect evidence / exclusion reason                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `adoptMobileCompanionHosts` | :331 migrates the paired mobile client's historical Host credentials; client enrollment, not a missing brain lifecycle. |
| `createWakeableSleep`       | :457 creates the mobile manifest-retry helper; subordinate client retry timer, not an independent runtime owner.        |
| `hydrateCompanionConfig`    | :354 reads this paired client's connection configuration; client transport setup, not Host work.                        |
| `markMobileBootSettled`     | :326/:539 updates the mobile splash's completion state; renderer boot UI only.                                          |
| `reportPushTokenToDesktop`  | :280 reports the phone's native push token to its authoritative Host; client push enrollment.                           |
| `runStagedSyncDown`         | :550 hydrates the mobile replica from its Host; the brain owns the authoritative data, not this client replica.         |
| `skipMobileBootStagesAfter` | :325/:424 settles skipped splash stages; renderer boot UI only.                                                         |
| `updateRuntimeSnapshot`     | :394/:552 projects the paired client's connection state for renderer consumers; no independent brain runtime.           |
| `waitForHostManifest`       | :498 polls this client's paired Host manifest; client connection negotiation, not missing Host work.                    |

## Five unadjudicated symbols: actual B6 result

The copied B6 module was evaluated in memory with only `REPO_ROOT` rebound to this worktree. Its exact roots/walker/`reachableFrom` produced a 5,992-file corpus; initializer files and B6’s test/story pattern were excluded exactly as in `analyze`. Each `calledInBrain` witness below was also checked in a one-file corpus. No protected file was changed.

| Initializer / symbol                                                     | Effect evidence                                                                                                 | Why B6 omits it                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `automation-audit-mirror-initializer.tsx` / `startAutomationAuditMirror` | `:19–23` invokes the subscription installer; `lib/automation/audit.ts:54` listens for native automation events. | `effectCalls` finds it; `calledInBrain=true` solely from the comment at `lib/automation/audit.ts:9`, which survives declaration removal. False call proof, not a missing effect binding or real brain registration.                          |
| `deferred-boot-initializers-impl.tsx` / `ensurePlanStepRecovery`         | `:47–54` invokes renderer-boot plan recovery.                                                                   | `effectCalls` finds it; `calledInBrain=true` at `components/agent/plan/plan-halt-dock.tsx:34`. B6’s broad reachable corpus includes that renderer component; this is a real renderer call, not proof of a headless runtime.                  |
| `im-notify-initializer.tsx` / `installImNotifyWatcher`                   | `:16–18` installs the chat-status subscription implemented at `stores/chat/im-notify-store.ts:198`.             | `calledInBrain=false`; `effectCalls` returns no binding because `libBindings` accepts only `@/lib/`, while this import is `@/stores/`. B6 detector scope miss relative to A2.                                                                |
| `local-character-pack-initializer.tsx` / `scanAndRegisterLocalPacks`     | `:35–65` runs local `initialize`; `:41` scans persisted pack files.                                             | `effectCalls` finds it; `calledInBrain=true` solely from the comment at `lib/plugin/character-pack/local-pack-store.ts:14`, which survives declaration removal. False call proof, not a missing effect binding or real registration.         |
| `pwa-lifecycle-initializer.tsx` / `attachInstallListeners`               | `:29–31` attaches the browser install-state listeners in `lib/pwa/install-state.ts`.                            | `effectCalls` finds it and `calledInBrain=false`, but `isUiOnlyModule=true` automatically excuses its DOM-only module. Neither a brain call nor a detector miss; classify the new A2 candidate as a browser-UI exclusion with that evidence. |

The first four need explicit B6/inventory adjudication; keep them visible rather than treating the text matches as registrations. The last is a new candidate only under the v2 ledger override (v1 already excludes it). Current v2 report: 35 effective members / 20 roots / 21 pending, with 29 invalid diagnostics (21 notes, 2 pending membership checks, 5 unadjudicated, 1 persisted-metrics mismatch). Default v1 remains 67 members / 38 roots / 203 exclusions.

The review-2 evidence/metrics rules do not alter these v1/v2 member sets. Refresh `metrics` from the effective v2 set, preserve matching fingerprints and reconfirm only evidence actually re-reviewed. The old f4cdf copy still has 21 pending symbols; the protected resolution below describes the later 25-symbol ledger, which must be used at merge.

## conv-0b's resolution (2026-11-01, lands in the next 0b commit)

conv-0b confirmed the four misses above and fixed its detector. Its corpus now blanks comments and drops `components/`, `hooks/` and `app/`, and `libBindings` binds `@/stores/` too. The widened rule surfaced 10 findings, and `pendingCeiling` goes from 21 to 25:

- **pending, phase 2:** `ensurePlanStepRecovery`, `installImNotifyWatcher`, `scanAndRegisterLocalPacks`.
- **pending, phase 1:** `lastUserRequest` (harness-evolution).
- **excluded:** `startAutomationAuditMirror`, `unannouncedInterrupted`, `enhancePrompt`, `getQuickAction`.
- **uiOnly:** `hydrateA2UISurfaceCache` (`@/stores/a2ui/a2ui-store`) and `rememberedDockFor` (`@/stores/artifact/dock-tabs-store`).

At merge, regenerate against that version of the exclusions file, not the `f4cdf4ccb0` copy used above.
