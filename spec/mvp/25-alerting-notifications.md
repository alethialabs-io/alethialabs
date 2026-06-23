# 25 — Alerting & Notifications

**Status:** Accepted (architecture) — MVP scope

## Context

Alethia is the authoritative record of what happens to a team's infrastructure: every provisioning
job, every spec lifecycle change, and — since [07-auth-rbac-sso](07-auth-rbac-sso.md) — every
**authorization decision** the PDP makes (`authz_audit_log`). Today that record is *pull-only*: you
have to open the dashboard to see a failed deploy or a denied action. There is no way to be **told**
when something matters.

Alerting closes that gap and turns the PDP into a differentiator. Every competitor can tell you a
deploy failed; very few can tell you *"someone was denied `destroy` on prod"* or *"an owner grant was
just handed out"* — because they don't sit on a uniform policy-decision log. Alerting is the surface
that makes the authz work **felt**.

This doc defines: the **event model** (what fires), the **channels** (where it goes), the **data
model**, the **open-core boundary**, and **pricing**.

## The model

An **alert rule** binds an **event type** (optionally narrowed by a **match** filter) to one or more
**channels**. When a source emits an event with a **key**, every enabled rule whose **event-key pattern**
matches (and whose `match` passes) produces a **delivery** per bound channel. Deliveries are a durable
ledger (retry + audit), not fire-and-forget.

```
event source ──emit(key)──▶ pattern match ──▶ throttle ──▶ delivery/channel ──dispatch──▶ webhook/email/slack/rocketchat
  (enforceDecision,         (key glob +        (dedupe       (ledger row:                  (HMAC-signed POST / SES)
   job status, …)            field `match`)     window)       pending→sent→failed→dead)
```

### Event keys — "everything is alertable, you configure which"

Events are identified by a **namespaced TEXT key**, not a DB enum, so the alertable surface grows with
the product and never needs a migration. Two families; a rule's `event_pattern` is an exact key or a
`*`-segment glob (a trailing `*` matches the remainder). The catalog is **code-derived** in
`lib/alerts/catalog.ts`.

| Family | Key shape | Emitted from | Examples |
|---|---|---|---|
| **Action** (PDP) | `authz.<resource>.<action>.<allowed\|denied>` | the single `enforceDecision` chokepoint (`lib/authz/audit.ts`) — **every** PDP decision, so any action is alertable automatically | `authz.spec.destroy.denied`, `authz.*.*.denied`, `authz.connector.manage_connectors.allowed` |
| | `authz.grant.assign` · `authz.grant.revoke` · `authz.role.edit` | grant/role mutations that bypass `authorize()` (`grants.ts`) | governance changes |
| **System** (lifecycle) | `system.<domain>.<event>` | the durable state-change point | `system.job.failed`, `system.job.succeeded`, `system.spec.destroyed`, `system.runner.offline`, `system.connector.token_failed` |

`authz.*` keys are the **security/governance** half — gated (see open-core). `system.*` keys are free.
Emitting on every decision stays cheap via a per-org rule cache (`lib/alerts/rule-cache.ts`): an org with
no matching rule does zero DB work. Cost/FinOps threshold keys land later with the FinOps module ([14](14-gtm-pricing.md)).

**The UI is policy-centric** (ported from the `console/alerts.html` design): a **policy** bundles a *set*
of these keys (`event_patterns`) plus shared routing (channels + scope/min-severity/dedup; `escalate` +
`recipient` are stored but ee/-gated/inert). The rule editor presents a **curated catalog**
(`lib/alerts/catalog.ts`) — 8 categories (deploy · PDP · access · members · identities · cost · workers ·
auth) of friendly events, each mapped to an underlying key; events whose emitter hasn't shipped yet are
selectable but tagged "soon". The "alert on literally any action" power remains via `authz.*.*.*` patterns.

### Match filters & throttle

A rule's `match` further narrows a matched key (field-equality, no code change): `job_types[]`,
`zone_ids[]`, `spec_ids[]`, `resource_types[]`, `actions[]`, `min_severity`. Empty = "all events of this
pattern". `throttle_seconds` collapses repeats of the same event subject within a window (0 = every event)
— the configurable re-alert control. Advanced/compound match expressions are an `ee/` capability.

### Severity

`info | warning | critical`, set per rule, carried into the payload so channels can format/route
(e.g. a chat colour, a webhook consumer's PagerDuty mapping).

## Channels

All four are a signed HTTP POST or an SES send — cheap to ship together, one `ChannelSender` interface
(`send()` + `verify()`), so adding the next one is a single file.

| Channel | Transport | Secret | Notes |
|---|---|---|---|
| **webhook** | `POST` JSON, `X-Alethia-Signature: sha256=HMAC(secret, body)` | endpoint URL + signing secret (encrypted) | mirrors the inbound Stripe verification pattern; the generic escape hatch for anything |
| **email** | existing SES transport (`lib/email/send.ts`) | — (recipients are non-secret) | reuses the product `EMAIL_FROM` stream + a new `emails/alert.tsx` template; dev-log fallback for self-hosters with no SES |
| **slack** | incoming-webhook `POST` (Block Kit) | webhook URL (encrypted) | |
| **rocketchat** | incoming-webhook `POST` (attachment) | webhook URL (encrypted) | same shape family as Slack |

Channel URLs/secrets are stored with the existing AES-256-GCM envelope (`lib/crypto/secrets.ts`,
`EncryptedSecret`). A **Test** action drives `verify()` so users confirm a channel before binding rules.

Roadmap channels (same interface, no schema change): PagerDuty, Discord, MS Teams, Opsgenie.

**Setup (operator-facing):** the chat channels authenticate with a pasted **incoming-webhook URL** (no
OAuth); secret-bearing channels require `ALETHIA_CRED_ENCRYPTION_KEY`. The how-to lives in the user docs at
`apps/docs/.../console/alerts.mdx`.

## Data model

New tables in `lib/db/schema/alerts.ts`; JSONB shapes typed via `$type<>()` with interfaces in
`types/database-custom.types.ts` (`AlertChannelConfig`, `AlertRuleMatch`, `AlertEventContext`).

| Table | Shape | Purpose |
|---|---|---|
| `alert_channels` | `id, org_id, type, name, config jsonb, secret EncryptedSecret?, enabled, is_verified, last_verified_at, created_by, timestamps` | a destination |
| `alert_rules` (a **policy**) | `id, org_id, name, description, event_patterns jsonb string[], match jsonb, severity, throttle_seconds, escalate, recipient, enabled, created_by, timestamps` | a **set** of event-key patterns → shared routing |
| `alert_rule_channels` | `rule_id, channel_id` (composite PK, cascade) | rule ⇆ channels (M2M) |
| `alert_deliveries` | `id, org_id, rule_id, channel_id, event_key text, dedupe_key text, context jsonb, status, attempts, max_attempts, last_error, next_attempt_at, created_at, sent_at` | durable ledger: retry + audit + the **Activity** view |

Enums (`lib/db/schema/enums.ts`): `alert_channel_type`, `alert_severity`, `alert_delivery_status`
(`pending | sent | failed | dead`). **Event keys are `text`, not an enum** — the catalog is code-derived
(`lib/alerts/catalog.ts`); the security/free split is `isSecurityKey()` (`authz.*`), no column.

### Emit & dispatch

- **Emit** (`lib/alerts/emit.ts`): `emitActionEvent(actor, action, resource, allowed)` is called from the
  single `enforceDecision` chokepoint for **every** PDP decision (so any action is alertable); system
  sources call `emitAlertEvent(orgId, key, context)`. Emit reads the org's enabled rules from a 30s cache
  (`rule-cache.ts`) — zero DB work when nothing matches — keeps rules whose `event_pattern` matches the
  key and whose `match` passes, **gates `authz.*` keys on `advancedAlerting`**, applies the per-rule
  throttle (dedupe by `dedupe_key`), inserts `pending` deliveries, dispatches. Fire-and-forget.
- **Dispatch** (`lib/alerts/dispatch.ts` + `lib/alerts/channels/*`): `deliverOne` **claims** a row first
  (conditional UPDATE with a visibility timeout) so the inline send and the sweep never double-send across
  instances; then send → `sent`, or `failed` with exponential `next_attempt_at`, or `dead` after
  `max_attempts`. The retry sweep runs **in-process** on a 60s `setInterval` (`lib/alerts/scheduler.ts`
  via `instrumentation.ts`) — the same self-hostable pattern as `lib/jobs/recovery.ts`, **not** a cron /
  EventBridge. `/api/internal/alerts/sweep` remains an optional manual trigger.

### Governed by the PDP

Alerting configuration is itself a PDP resource: a new `alert` resource with `manage_alerts` /
`view_alerts` actions ([07](07-auth-rbac-sso.md) registry). Every alerts server action begins with
`authorize(...)`; owners/admins manage, operators/viewers read. Attempts to mutate without permission
are themselves denials — which can, in turn, fire an `authz.*.denied` alert.

## Open-core boundary

Consistent with [12-licensing-open-core](12-licensing-open-core.md): the paid line is the
**governance** line, not the feature itself. You can run real alerting fully self-hosted for free.

| Layer | License | What |
|---|---|---|
| **Core (free)** | AGPL-3.0 | all four channels, the rule engine, deliveries ledger + in-process sweeper, the configurable throttle, and **all `system.*` keys** (`system.job.*`, `system.spec.destroyed`, `system.runner.offline`, `system.connector.token_failed`) with field-equality match |
| **Commercial (`ee/`)** | proprietary | **`authz.*` keys** (every PDP action decision + `authz.grant.*` / `authz.role.edit`), advanced/compound match expressions, escalation & routing policies, alert-config RBAC beyond the built-in roles |

Mechanism: a new `advancedAlerting: boolean` on `Entitlements` (`lib/authz/types.ts`), `false` in
`COMMUNITY_ENTITLEMENTS`, granted on **business+** in `lib/billing/plan.ts` (alongside `auditExport` —
security alerts derive from the same audit data). Core never imports `ee/`; the gate is the existing
entitlement seam read in `emit.ts` (skip unentitled security deliveries) and in the rule
create/update action (UI shows a locked upgrade prompt). The community build runs fully with `ee/` absent.

## Pricing

Alerting is **not** its own SKU — it's an entitlement on the existing ladder ([14](14-gtm-pricing.md)):
ops alerting is a free adoption driver (every self-hoster gets "tell me when a deploy breaks"); the
**security/governance** half rides the same governance value as SSO/audit and unlocks at **business+**.
This avoids a paywall on a table-stakes feature while keeping the PDP-differentiated half as a reason to
move up a tier.

## Exit criteria

- [ ] `alert_channels` / `alert_rules` / `alert_rule_channels` / `alert_deliveries` migrated via the Drizzle pipeline (event keys are `text`, no event enum).
- [ ] Channels: create + **Test** for webhook (valid HMAC), email (SES / dev-log), Slack, RocketChat.
- [ ] Universal action alerting: a rule on `authz.*.*.denied` fires for ANY denied action (try `spec.destroy`, `connector.manage_connectors`) with no per-action wiring.
- [ ] Ops rule end-to-end: `system.job.failed → Slack` produces a `pending→sent` delivery and the message arrives.
- [ ] Security gated: `authz.*` rules are locked in UI and skipped in `emit.ts` when `advancedAlerting` is off; fire when on.
- [ ] Throttle: repeats of one subject within `throttle_seconds` collapse to a single delivery.
- [ ] Retry: a failing endpoint walks `failed → retry → dead` with `last_error`; two instances don't double-send (claim-before-send).
- [ ] PDP: a `viewer` cannot mutate rules (`manage_alerts` denied); the denial lands in `authz_audit_log`.
- [ ] Boundary-guard lint passes (core never imports `ee/`); `turbo lint && turbo check-types` green.

## Roadmap

- ✅ **Shipped:** `system.runner.offline` (emitted from the offline-runner sweep), durable
  `system.connector.token_failed` (point-of-use git/api-key failure → `connector_health`, once per
  transition, no polling), and `authz.role.create/edit/delete`.
- Cost/FinOps threshold events (spend-per-spec, drift-to-cost) with the FinOps module.
- More channels (PagerDuty, Discord, MS Teams, Opsgenie) via the same `ChannelSender`.
- Escalation policies, per-user notification preferences, digest/batching, and dedup/suppression windows (`ee/`).

## References

- [07-auth-rbac-sso](07-auth-rbac-sso.md) — PDP, `authz_audit_log`, the sensitive-action set, entitlement seam.
- [08-integrations-extensibility](08-integrations-extensibility.md) — the category-provider pattern the channel interface echoes.
- [12-licensing-open-core](12-licensing-open-core.md) — the `ee/` boundary and entitlement mechanism.
- [14-gtm-pricing](14-gtm-pricing.md) — the plan → entitlement ladder this rides.
