# Feishu Calendar Integration

Feishu Calendar is a frontend Integration plugin that depends on the shared
`feishu-auth` provider plugin. The supported authorization host is Cognia
Desktop. Tokens stay in the authentication plugin's secure storage; calendar
handlers use the host's account-bound `authenticatedRequest` broker.

## Connect

1. Enable **Feishu Calendar** in Plugins. Its required `feishu-auth` dependency
   activates first. Both packages are included in the first-party curation.
2. In the Feishu developer console, create/configure an application with user
   authorization and the scopes `offline_access`, `calendar:calendar:readonly`
   and `calendar:calendar`. Publish/approve those scopes as your tenant requires.
3. Deploy Cognia's static `/plugin-auth/callback` page at an HTTPS URL and
   register that exact URL as the application's OAuth redirect URI. Loopback
   HTTP is accepted for local development. No callback server is started by
   this plugin, and a `cognia://` URI is not the Feishu redirect URI.
4. Open Integrations, select Feishu Calendar, and add an account with the App ID,
   App Secret and registered redirect URI. Complete consent in the system
   browser, then follow **Return to Cognia** on the callback page. State and
   PKCE are checked before the token exchange. Keep the app open during sign-in.
5. Add a subscription for one selectable calendar or the whole account. Choose
   created/updated/deleted event types and optionally the Calendar event Inbox
   projection. Account-wide subscriptions enumerate all accessible calendars.

Deleting the last account reference removes the locally stored session. To
revoke application consent remotely, use Feishu's authorized-app management.
The plugin does not invent or call an undocumented remote revocation API.

## Calendar operations

Actions become Agent tools and Workflow nodes through the existing Integration
bridge: list calendars/events, read/create/update/delete an event, free/busy,
RSVP, add/remove attendees (including meeting rooms), and synchronize now.
Action inputs use the native Feishu event field names inside `event`/`patch`;
list options use `pageToken`, `syncToken`, `anchorTime`, `startTime`, `endTime`
and `pageSize`. Times use Unix **seconds** strings or all-day `YYYY-MM-DD`
dates. Recurrence, IANA timezones and explicit field clears are supported.

Writes enter the existing approval/action broker; deletion is destructive.
Create uses the durable action job ID as Feishu's `idempotency_key`. The action
runner owns retries. Writes without provider-level replay safety are declared
non-retryable. Calendar resource selectors bind scoped grants to `calendarId`.

## Incremental synchronization

An enabled plugin task polls subscribed calendars every 300 seconds. It reads
only remote data and publishes canonical `calendar.event.created`,
`calendar.event.updated` and `calendar.event.deleted` Integration events.
Workflow/Inbox projections use the host's durable event broker.

The first scan reads all available events with `anchor_time=0`, including
historical entries, and emits existing live events as created. The terminal
`sync_token` is saved only after every page and event publication succeeds.
Subsequent scans use that token. A failed scan retries from the previous
completed cursor; a persisted generation gives redeliveries stable IDs.
Checkpoints contain event IDs/fingerprints, not event descriptions or tokens.

Expired tokens (`190008`) trigger one bounded full rescan and reconcile missing
events as deletions. Tombstones, repeated page tokens, cancellation, plugin
disposal and overlapping calls are covered by tests. Inbox thread identity
contains both calendar and event IDs. One active plugin instance owns scans;
the storage API does not provide a cross-process compare-and-swap lease.

Time-window listing and incremental listing are different modes in Feishu:
`start_time`/`end_time` cannot be combined with pagination, sync or anchor
parameters. A time-window response may be truncated by Feishu; use the sync
path for complete traversal. Native push webhooks are not used by this plugin.

## Shared foundation versus library modules

`dependencies: { "feishu-auth": "^1.0.0" }` expresses the runtime dependency.
The foundation registers `feishu-user-oauth`; this Integration references that
provider in `authStrategies`. Another Feishu service can depend on the same
plugin and request its own scopes without receiving copied refresh tokens.
The generic account form currently creates a new consent session when adding
an account; automatic selection/reuse of an existing session is not claimed.

`library.modules` is suitable for pure shared helpers. Such modules are
instantiated in the consumer's context, so they should not own a shared login
singleton or the provider's secret namespace. The existing native auth registry
provides that singleton boundary without a new IPC token API.

## Verification and sources

Run the co-located tests with the repository's `pnpm test` entry point.
Protocol tests use deterministic broker responses; a real sign-in and calendar
round trip require a configured Feishu app, callback deployment and user login.

- [Feishu OAuth authorization code](https://open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code)
- [Feishu user token](https://open.feishu.cn/document/authentication-management/access-token/get-user-access-token)
- [Feishu event listing and incremental cursor](https://open.feishu.cn/document/server-docs/calendar-v4/calendar-event/list)
- [Feishu event creation](https://open.feishu.cn/document/server-docs/calendar-v4/calendar-event/create)

## 中文说明

启用飞书日历插件会先启用其必需依赖 `feishu-auth`。在 Integrations 中填写
App ID、App Secret 和已部署并登记的 HTTPS `/plugin-auth/callback` 地址，完成
浏览器授权后点击“返回 Cognia”。认证凭证由基础插件安全保管；日历插件通过
宿主请求代理读写，不复制 token。

为指定日历或整个账号建立订阅后，每五分钟进行增量同步。首次同步会产生历史
现有日程的创建事件；同步成功后才提交游标，失败可重放，失效游标自动全量修复。
支持日程读写、忙闲、RSVP 和参会人/会议室操作。实际飞书联调需提供应用配置和
交互登录；当前声明的认证支持范围是桌面宿主。
