<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Retention schedule

**Status: Draft — pending maintainer legal review (#7351).** Written by an agent for LEG-L4 (#6922).
No lawyer has reviewed it.

Owner: LEG-L4 (#6922)

Effective: 2026-11-23

This schedule names, for each class of personal data Alethia holds or sends, how long it is kept and
the code that enforces that period. Where no code enforces a period, the row says so. A row that says
"none found" is a finding, not a decision. It lists what was searched, so the next reader can tell an
examined row from an unexamined one.

The typed source is the retention register, `apps/console/lib/retention/registry.ts`.
`apps/console/tests/privacy/retention-registry.test.ts` holds that register to the `gc_*` functions in
`apps/console/lib/db/programmables.sql`. It does not hold this file to anything. If this file and the
register disagree, the register is right and this file is stale.

## The register as it will read after #7388

Open PR #7388 (#7220) changes the register. This schedule describes the register **as it will read
once #7388 merges**. Until then, three rows below are not yet true on `dev`:

- **Support cases.** On `dev` today nothing deletes them. #7388 adds `gcSupportCases` and the
  `support-cases` entry.
- **Removed cloud inventory.** The 7-day purge already runs on `dev`, but the register has no entry
  for it. #7388 adds `removed-cloud-inventory`.
- **Backups.** On `dev` the `backups` entry says the rotation is not established. #7388 records the
  rotation and the 76-day maximum.

If #7388 changes before it merges, update these rows to match it.

## How to read the table

| Column | Meaning |
| --- | --- |
| Data | The class of data, in the words the Privacy Policy uses where it has words for it |
| Where | The Postgres table, or the outside party that holds it |
| Period | How long it is kept |
| Enforced by | The code that deletes it, and how often it runs. "None" means nothing in the repository deletes it on a schedule |
| Register | The `id` of the entry in `registry.ts`, or "not registered" |

"Default" means an environment variable can change the period. A deployment that sets one has changed
a published promise. `retentionHealth()` in `apps/console/lib/retention/health.ts` reports the period
each deployment actually uses.

## 1. Enforced by Alethia's code

| Data | Where | Period | Enforced by | Register |
| --- | --- | --- | --- | --- |
| Deploy and job logs, including anything a customer's tooling printed | `job_logs` | 30 days (default; `ALETHIA_JOB_LOG_RETENTION_DAYS`) | `public.gc_job_logs`, called by `gcJobLogs` in `apps/console/lib/reconcile/gc.ts`, every 15 minutes by the reconcile loop (`apps/console/lib/reconcile/loop.ts`, `gc-job-logs`) in bounded batches | `job-logs` |
| Fleet action ledger: what was provisioned, scaled or destroyed, and by whom | `fleet_actions` | 90 days (default; `ALETHIA_FLEET_ACTION_RETENTION_DAYS`) | `public.gc_fleet_actions`, every 15 minutes (`gc-fleet-actions`) | `fleet-actions` |
| Authorization decisions: every allow and deny | `authz_activity_log` | 365 days (default; `ALETHIA_AUTHZ_ACTIVITY_RETENTION_DAYS`) | `public.gc_authz_activity_log`, every 15 minutes (`gc-authz-activity`). The table is append-only; the function sets the one flag the WORM trigger accepts for this delete | `authz-activity` |
| Half-finished cloud connections | `cloud_identities` (status `pending`) | 24 hours (default; `PENDING_IDENTITY_TTL_H`) | `public.gc_pending_identities`, called from `apps/console/lib/jobs/recovery.ts` | `pending-cloud-identities` |
| Unsent assistant drafts, which may hold pasted secrets | `elench_drafts` | 30 days after last written. No environment override | `elench-drafts-sweep` (`apps/console/lib/elench/drafts-sweep.ts`), daily | `elench-drafts` |
| Discarded assistant drafts (the Undo window) | `elench_drafts` (status discarded) | 24 hours after discard. The sweep runs daily, so up to about 2 days | Same sweep | `elench-drafts-discarded` |
| Support and contractual correspondence: support cases, messages, internal notes, read markers, attachment rows and files, classification assignments | `support_cases` and its children; the support attachments bucket | 1095 days (3 × 365) after the matter closes. A case that is still open or pending is never deleted. No environment override | **After #7388:** `gcSupportCases` in `apps/console/lib/reconcile/gc.ts`, hourly (`gc-support-cases`), paged. Attachment files are deleted before the rows; a case whose file cannot be deleted is kept and tried again. **On `dev` today: none** | `support-cases` (after #7388) |
| Removed cloud inventory and capability observations | Cloud inventory tables and the launchable-service and quota capability tables (`removed_at` set) | 7 days after removal (default; `ALETHIA_INVENTORY_RETENTION_DAYS`) | `runConnectionSweep` in `apps/console/lib/cloud-providers/sweep.ts` (`gcRemovedInventory`, `gcRemovedServiceCapabilities`, `gcRemovedQuotaCapabilities`), every minute on every app instance | `removed-cloud-inventory` (after #7388) |
| Sealed kubeconfig awaiting collection | `kubeconfig_mint_requests` (ciphertext column) | End of the 10-minute poll window, plus up to about one minute | `kubeconfig-mint-sweep` (`apps/console/lib/kubeconfig-mint/sweep.ts`), every minute: sets the row to `expired` and nulls the ciphertext | Not registered |
| Rate-limit counters. A key can carry a client IP address or a user id (`apps/console/lib/rate-limit.ts`) | `rate_limit_buckets` | Until the counting window ends | `sweepExpiredRateLimitBuckets` in `apps/console/lib/rate-limit.ts`, every 5 minutes (`rate-limit-sweep`) | Not registered |
| Analytics choice on the visitor's device | Cookie `alethia_consent_v2` | 183 days | The cookie's own lifetime (legal-set claim `cookies.consent-cookie.lifetime`) | Not applicable: on the device, not in Alethia's systems |

The last three rows are not in the register. The register says that "nothing may be retained by
this product without appearing here". Its test only checks the `gc_*` SQL functions, so a TypeScript
sweep can be missing and nothing reports it. **Open: maintainer to confirm** whether the kubeconfig
and rate-limit sweeps belong in the register.

## 2. Kept on purpose, with no deletion

| Data | Where | Period | Enforced by | Register |
| --- | --- | --- | --- | --- |
| Which Terms version an account accepted, and when | `legal_acceptance` | As long as the contract it proves can be disputed. **No number is set** | Nothing deletes it. On erasure it is kept, not erased (`apps/console/lib/privacy/erasure-plan.ts`, disposition `retain`, GDPR art. 17(3)(b)) | `legal-acceptance` |
| Orders, what was charged, consumer withdrawal outcomes | `commerce_order` | The statutory accounting period. **Not established** in the register | Nothing deletes it. Kept on erasure (`retain`). The `ON DELETE RESTRICT` reference to `user` makes that true in the database | `commerce-order` |
| Invoices | `invoice` | The statutory accounting period | Nothing deletes it. Kept on erasure (`retain`, for the subject's personal organization) | Not registered |
| Bulgarian фактура and credit notes, with the recipient's details in a snapshot | `factura`, `factura_series` | The schema comment says **ten years** (Accountancy Act art. 12; ЗДДС art. 121(1)) | Nothing deletes it. A trigger in `programmables.sql` refuses UPDATE, DELETE and TRUNCATE on an issued row (`apps/console/lib/db/schema/factura.ts`) | Not registered |

Two sources disagree here. The `commerce-order` entry says the statutory period is **not
established**. The `factura` schema comment states ten years and names the articles. **Open:
maintainer to confirm** the period, then record it in the register (`commerce-order`, and new entries
for `invoice` and `factura`). Nothing in the repository deletes any of these four tables, at ten years
or at any other time.

## 3. Held by an outside party

Alethia's code deletes none of this. The period is the provider's, under its configuration or terms.

| Data | Held by | Period | What would settle it | Register |
| --- | --- | --- | --- | --- |
| Product analytics and client diagnostics, for consenting visitors | PostHog EU Cloud | **Not established** | The retention configured in the PostHog project, read and recorded | `product-analytics` |
| Server and migration errors, operational logs | PostHog EU Cloud | **Not established** | Same project settings | Not registered: the register's `product-analytics` entry names consented analytics only |
| Prompts, and the context and repository files sent with them | Anthropic (OpenAI only under an operator's `openai/*` override) | The value of `ALETHIA_AI_ANTHROPIC_RETENTION` in the production vault | Reading that value. The assistant's chat routes refuse to run until it is set (`isAiConfigured()` in `apps/console/lib/config/ai.ts`). The repository scan does not ask that question; see `AI_ACT_POSITION.md` | Not registered |
| Transactional email delivery metadata | Amazon SES (Amazon Web Services EMEA SARL, eu-central-1) | **Not established** | AWS terms and account settings | Not registered |
| Billing contact and payment records | Stripe Payments Europe, Ltd. | Stripe's own statutory periods | Stripe's terms | Not registered |
| Edge and security data | Cloudflare | **Not established** | Cloudflare account settings and terms | Not registered |
| Hetzner server backups of the control-plane box (`backups = true` in `infra/cp-hetzner/main.tf`) | Hetzner | Hetzner's backup rotation. **Not established** in this repository | Hetzner's product terms | Covered by the `backups` entry only in its subject line |

### Off-box backups

After #7388 the `backups` entry reads:

- `deploy/prod/backup/backup.sh` takes a nightly encrypted copy of the Postgres dump, the
  object-store buckets and the erasure tombstones.
- In script mode it keeps 14 daily and 8 weekly copies (`BACKUP_KEEP_DAILY`, `BACKUP_KEEP_WEEKLY`).
- In bucket mode (`BACKUP_RETENTION=bucket`), which is what production uses, the bucket's lifecycle
  rules expire them (`infra/backup-account/main.tf`): daily copies after 15 days, weekly copies after
  60, then 16 more days as a noncurrent version. No copy outlives **76 days**.
- The IaC puts the bucket in a dedicated AWS account in `eu-central-1` (`infra/backup-account/`).

**Not established:** that a restore replays the erasure tombstones before the restored instance
serves traffic. Nothing in this repository does that yet. Until it does, a restore of a copy older
than an erasure brings the erased data back. **Open: maintainer to confirm** that production's
`backup.env` points at the `infra/backup-account` bucket and sets `BACKUP_RETENTION=bucket`; both are
on the box, not in the repository.

## 4. No period, and nothing that deletes it

For each row below, I searched `apps/console/lib` and `apps/console/app` for a `.delete(<table>)`
call and `programmables.sql` for a `gc_*` function, and read the reconcile loop's task list
(`apps/console/lib/reconcile/loop.ts`). None deletes these rows on a schedule. Some are removed by a
user action, by the erasure path, or by a foreign-key cascade when the parent row is deleted. The
cascades were not examined table by table.

| Data | Where | What does remove it | Register |
| --- | --- | --- | --- |
| Assistant conversations: everything a user typed and the model answered | `agent_threads` | The user deleting the thread (`apps/console/app/server/actions/agent.ts`); erasure (`erase`) | Not registered |
| Jobs, including `config_snapshot` and `execution_metadata`. A repository scan stores its digest here: the text of manifests, Dockerfiles, compose files, Kubernetes manifests, CI configuration and `.env.example`-style files, each up to 64 KiB (`packages/core/scanner/scanner.go`) | `jobs` | Nothing found, except the cascade from its parent | Not registered |
| AI usage records (tokens, model, user, org) | `ai_usage_ledger` | Nothing found | Not registered |
| Account, profile, linked identities, sessions, OAuth tokens and consents, CLI login records | `user`, `profiles`, `account`, `session`, `oauth_*`, `cli_logins` | Erasure (`apps/console/lib/privacy/erasure-plan.ts`): erased, except `user`, which is pseudonymized. No sweep of expired `session` rows was found in the repository | Not registered |
| Audit trail: who approved what | `audit_log` | Erasure pseudonymizes the actor (nil UUID). Nothing deletes the entry | Not registered |
| Privacy cases and their ledger | `privacy_case`, `privacy_case_event` (WORM) | Nothing found | Not registered |
| Erasure tombstones (a SHA-256 of the identifier, no personal data) | `privacy_erasure_tombstone` | Nothing, on purpose: a tombstone has to outlive every backup it may need to be replayed against | Not registered |
| Email suppression list (addresses that bounced or complained) | `email_suppression` | Nothing found | Not registered |
| Early Access grant requests, with what VIES returned | `early_access_request` | Nothing found. The app role cannot UPDATE or DELETE a row | Not registered |
| Break-glass sessions, approvals and audit | `breakglass_session`, `breakglass_approval`, `breakglass_audit` | Nothing found | Not registered |
| Sign-in rate-limit counters, keyed on client IP address and auth path | `rate_limit` (Better Auth's table, `apps/console/lib/db/schema/auth.ts`) | Nothing found in the repository. Better Auth's own handling of old rows was not examined | Not registered |
| OpenTofu state of what Alethia provisioned | Object storage (`apps/console/lib/storage/tofu-state.ts`) | Not examined | Not registered |

**Open: maintainer to confirm** a period for each row in this section, or a recorded reason why the
data is kept while the account exists. The Privacy Policy says account records are "deleted or
anonymized after closure". For the rows erasure covers, that is the erasure path. For `jobs`,
`ai_usage_ledger`, `privacy_case`, `email_suppression` and `early_access_request` it is not shown.
Erasure does not list them, so they stay after an account's erasure, unless a cascade removes them.

## 5. Nothing is kept

| Data | Why |
| --- | --- |
| Marketing contact form submissions | `apps/marketing/app/server/actions/contact.ts` sends one email to the sales inbox and persists nothing (GDPR_ACCOUNTABILITY.md, "Established") |
| Prompts and model output in product analytics | `captureAiGeneration` in `apps/console/lib/analytics/server.ts` does nothing with them |

## Open: maintainer to confirm

1. The statutory accounting period for `commerce_order`, `invoice` and `factura`, and whether the
   ten years in the `factura` schema comment is it.
2. Whether the kubeconfig and rate-limit sweeps go into the retention register.
3. A period, or a recorded reason for none, for every row in section 4.
4. The PostHog retention for analytics and for operational logs. Also whether operational logs need
   their own register entry.
5. The value of `ALETHIA_AI_ANTHROPIC_RETENTION` in the production vault.
6. That production `backup.env` uses the `infra/backup-account` bucket in bucket mode. And who builds
   the tombstone replay on restore.
7. The Hetzner server-backup rotation, and the retention at SES and Cloudflare.
