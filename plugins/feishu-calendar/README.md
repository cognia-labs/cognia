# Feishu Calendar Integration

Feishu Calendar consumes `auth.feishu@^1.0.0` through a Host connection and a
consumer grant. Either the `feishu-auth` plugin or built-in Lark can supply the
connection. There is no hard plugin dependency: service availability and version
matching determine activation, and waiting consumers resume when a provider
appears. The scheduled `syncSubscribedCalendars` task remains enabled by default.

## Connect and consent

1. Configure an account in the Host's Feishu/Lark connection UI. The Host owns
   App ID, App Secret, redirect URI, credentials and refresh. Calendar has no
   credential configuration form and never calls `auth.getSession`.
2. In Integrations, add a Feishu Calendar account. The Host picker selects a
   connection using `auth.connections.get({ service: "auth.feishu", scopes })`.
   Approve calendar reads. Review write access separately if you need mutations.
3. Add a subscription for a chosen calendar or the whole account. The existing
   list-events action accepts an explicit query window (`startTime`/`endTime`);
   incremental subscriptions keep the complete cursor stream rather than using
   a truncated window response.

Read consent requests exactly `listCalendars`, `listEvents`, `getEvent`,
`getFreebusy`, `syncCalendar` and `request.GET`, prefixed with
`feishu-calendar.`, under `calendar:calendar:readonly`. Write consent requests
exactly `createEvent`, `updateEvent`, `deleteEvent`, `replyEvent`,
`addAttendees` and `removeAttendees` under `calendar:calendar`. There is no
wildcard or raw POST/PATCH/DELETE grant. Actions retain their existing risk,
resource selectors, approval and idempotency checks in the Host action broker.
Free/busy uses a POST endpoint but is a read action.

Every request uses `integrations.authenticatedRequest` with its account's
`connectionRef`. `calendarApiOrigin` is the single deployment mapping:
`https://accounts.feishu.cn` → `https://open.feishu.cn`;
`https://accounts.larksuite.com` → `https://open.larksuite.com`.
Other issuers are refused. Network rules permit only calendar v4 paths on those
two deployments, without auth/token endpoints.

## Migration and synchronization

Activation calls `integrations.migrateLegacy` with ledger id
`feishu-calendar-host-connections-v1`. The Host reads 5b's legacy-session alias
map and rebinds existing integration accounts in place. Account ids, labels,
externalRefs, subscriptions and account/calendar cursor keys remain stable.
The ledger and snapshots survive audit pruning. Compare-and-swap checks refuse
concurrent account/connection changes and duplicate bindings; the transaction
rolls back on conflict. No alias match records `legacy-connection-unmatched`
needs-attention, retains all original data and permits a later retry. Rollback
preserves post-migration user edits and reports conflicts.

The five-minute task uses full scans followed by incremental `sync_token`
reads. Only a completed scan commits its terminal cursor. Pending generations
make deliveries stable after a retry; checkpoints contain ids/fingerprints, not
event content or credentials. Expired tokens (190008) cause one full rescan;
missing entries and cancellation records produce tombstones.

Revoked grants, changed connection revisions and disconnected connections stop
sync without advancing its completed cursor. Background work never prompts for
new consent. Integrations shows the reason and read/write review controls.
The Host also rechecks grants after an in-flight response before releasing data.
A saved account retains its own connection even if another account is selected
for new work. The existing single-instance overlap guard remains; cross-process
sync leases are outside this phase.

## ES-32 behavior table

All rows use the existing Integration action/resource/event interfaces in
`feishu-calendar`. The migration above preserves their account references.
Tests exercise the actual `FeishuCalendarClient` with stubbed API responses.
Supported means the mapping is verified locally, not that live vendor acceptance
has been performed.

| Capability / old calendar entry         | Status      | Exact public interface and native mapping                                                                                                                                                                                                                                          | Test pin                                                                                                                                                                                                                                                                                        |
| --------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recurring series                        | supported   | `createEvent` / `updateEvent` pass `recurrence` (RFC 5545 RRULE) unchanged; an empty string clears it. No local expansion.                                                                                                                                                         | `api.test.ts: supports all-day events and recurrence`; `preserves explicit patch clears and false values`                                                                                                                                                                                       |
| Recurrence exceptions                   | read-only   | `listEvents` / `getEvent` preserve native exception identifiers, `recurring_event_id`, `original_time` and cancellation records. No dedicated exception-set editing/instance-expansion interface; extra exception-set write fields are refused. UI labels that operation inactive. | `api.test.ts: ES-32 preserves recurrence exceptions on reads and rejects exception-set writes`; `index.test.ts: ES-32 labels unsupported features and exposes no active exception or push controls`                                                                                             |
| Timezone and all-day                    | supported   | Pass IANA `start_time.timezone` / `end_time.timezone` and Unix seconds strings unchanged. All-day uses `date: YYYY-MM-DD` with an exclusive end date, optionally UTC; mixed representations, invalid zones/dates and reversed ranges are refused.                                  | `api.test.ts: ES-32 preserves IANA timezones and all-day date boundaries in round trips`; `rejects invalid event boundaries before sending`                                                                                                                                                     |
| Attendees and RSVP                      | supported   | `addAttendees` → POST `events/{id}/attendees` with typed `user_id` / `chat_id`; `removeAttendees` → POST `attendees/batch_delete` with `attendee_ids`; `replyEvent` → POST `events/{id}/reply` with `rsvp_status: accept/decline/tentative`.                                       | `api.test.ts: adds typed invitees and removes by attendee IDs`; `sends delete and RSVP to their native endpoints`                                                                                                                                                                               |
| Free/busy                               | supported   | `getFreebusy` → POST `freebusy/list`, with RFC 3339 `time_min` / `time_max`, exactly one `user_id` or `room_id`, at most 90 days; return the native result unchanged.                                                                                                              | `api.test.ts: uses the freebusy endpoint with exactly one user or room and at most 90 days`                                                                                                                                                                                                     |
| Rooms                                   | supported   | `addAttendees` maps `type: resource` to `room_id` (at most 100 rooms per call). Native response remains authoritative for booking/approval; no synthetic successful booking. Room availability uses the free/busy mapping above.                                                   | `api.test.ts: adds typed invitees and removes by attendee IDs`; `ES-32 preserves room availability results and maps every RSVP status`                                                                                                                                                          |
| Reminders and remote notification flag  | supported   | `createEvent` / `updateEvent` pass `reminders: [{ minutes }]` and explicit `need_notification`; empty reminders and false are retained. The service owns any notification side effect.                                                                                             | `api.test.ts: ES-32 maps reminders and explicit notification side effects to native fields`                                                                                                                                                                                                     |
| Native push / local reminder scheduling | unsupported | Polling only; no push registration or local timer control is active. The UI labels these inert and strict inputs reject push fields.                                                                                                                                               | `api.test.ts: ES-32 maps reminders and explicit notification side effects to native fields`; `index.test.ts: ES-32 labels unsupported features and exposes no active exception or push controls`; `integrations-hub.test.ts: labels inactive calendar features and connection recovery reasons` |

## Validation and distribution

Co-located tests cover both real provider adapters through the Host connection,
consent, credential injection, deployment selection and in-flight revocation.
Protocol responses and native credential snapshots are stubbed. Live OAuth,
calendar writes and native keychain acceptance still need a configured account.

Source/manifest changes require the bundled plugin artifact producer before a
release. It is deliberately not run in this phase; `authoring-kit.json` must not
be edited. Standalone package tests build only their isolated test packages.

## 中文说明

日历只消费 Host 的 `auth.feishu` 连接，可使用 `feishu-auth` 或内置 Lark。
在 Host 配置认证应用，在 Integrations 选择连接并分别批准读取与写入；日历不再
收集 App ID、App Secret 或回调地址。订阅选择日历；按时间窗口查询与增量同步
分开处理。旧账户通过 alias ledger 原地重绑，保留订阅、externalRefs 和游标；
无匹配时标记待处理，冲突时事务回滚。撤权、断连或连接修订变化都会停止同步，
保留已完成游标并显示恢复原因。重复例外集合的编辑、原生推送及本地提醒调度未
开放，界面明确标注为只读或未启用。
