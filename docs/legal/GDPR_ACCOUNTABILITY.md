# GDPR accountability record

Owner: Alethia Labs legal/privacy

Effective: 2026-11-22

Review cadence: quarterly and before any new vendor or materially new processing

This is the operational record behind the public Privacy Policy, Cookie Notice,
Data Processing Addendum, and Subprocessors page. It is not a claim of
certification. The controller for the hosted service is ALETHIA LABS, a Bulgarian
single-member variable capital company, EIK 208913663. Registration does not prove that a vendor agreement, transfer
mechanism, retention setting, or technical control is active; each requires the
evidence described below.

## Processing inventory

| Activity | People and data | Purpose | GDPR basis | System / recipient | Retention |
| --- | --- | --- | --- | --- | --- |
| Account and authentication | Users; email, name, avatar, provider id, session and sign-in events | Create and secure accounts | Contract; legitimate interests | Alethia PostgreSQL; selected identity provider; Amazon SES (AWS, eu-central-1) | Account life plus closure workflow; security records as below |
| Organization and access control | Members; org id, role, grants, authorization decisions | Multi-tenant access and governance | Contract; legitimate interests | Alethia PostgreSQL | Active account; authorization activity 365 days |
| Infrastructure control | Customer users and incidental people in submitted content; configuration, repo/commit metadata, plans, state, job records, logs | Perform requested provisioning and management | Contract; customer instructions under DPA | Hetzner-hosted compute, PostgreSQL and object storage (which also holds the OpenTofu state of what Alethia provisioned, `apps/console/lib/storage/tofu-state.ts`); selected cloud and git providers | Active project; job logs 30 days; removed inventory 7 days |
| Cloud federation | Users and cloud-account administrators; issuer, audience, role, tenant, project and session metadata | Obtain short-lived access to customer cloud accounts | Contract; legitimate interests | Selected cloud provider | Configuration until disconnect; short-lived credentials expire at provider |
| Billing | Billing contacts; organization, plan, invoice, transaction and tax metadata. Card data is entered into the provider's hosted fields (Stripe for subscriptions started on Stripe; Paddle's checkout for card sales through the merchant of record) and is never received by Alethia | Take payment for paid plans and keep statutory records | Contract; legal obligation | Alethia PostgreSQL; **Stripe Payments Europe, Ltd. (active)**; Paddle.com Market Ltd / Paddle.com Inc. as **independent controller** (planned until `MOR_MARKETS` opens) | Statutory accounting period. **NOT ESTABLISHED — requires the retained period to be confirmed against Bulgarian accounting law and recorded here** |
| Support and legal requests | Users and correspondents; contact details, message, evidence and response | Resolve requests and establish legal claims | Contract; legitimate interests; legal obligation | Alethia PostgreSQL/email; Cloudflare routing to a mailbox whose provider is not named in this repository; Amazon SES (AWS, eu-central-1); Slack, for the case number, subject, severity and organization id, only when `SUPPORT_SLACK_WEBHOOK_URL` is set (`apps/console/lib/support/slack-notify.ts`) | Matter closure plus 3 years, unless a claim or law requires longer. **No code deletes support cases; the window is a policy applied by hand** |
| Security and operations | Users and visitors; IP, user agent, request, incident, audit and diagnostic data | Protect availability, integrity and tenants | Legitimate interests; legal obligation where applicable | Hetzner; Cloudflare; Alethia logs | Minimized by system; job logs 30 days; fleet actions 90 days; authorization activity 365 days |
| Product analytics and client diagnostics | Consenting users; pseudonymous internal ids, plan/role, pages, feature events, performance and client errors | Understand, improve and diagnose the Service | Consent | PostHog EU Cloud | Provider retention must be verified and recorded before release |
| Operational diagnostics | Users and visitors; minimized server and migration errors, request metadata and structured operational logs | Secure, diagnose and maintain the hosted Service | Legitimate interests | PostHog EU Cloud | Provider retention must be verified and recorded before release |
| AI assistance | Users and people in submitted context; prompt, selected Service context, response and usage | Provide a user-requested AI feature | Contract; customer instructions under DPA | Anthropic (the default models, on Alethia's own key; registered in `processing.ts`); OpenAI only if an operator sets an `openai/*` model override; Alethia PostgreSQL for conversations and unsent drafts | Provider retention governed by contracted configuration; Alethia product analytics receives no prompt or output; unsent Elench drafts deleted after 30 days unwritten; discarded drafts deleted after 24 hours by a daily sweep, so kept up to about 2 days |

## Data-flow and minimization rules

1. Hosted primary data remains in Hetzner `fsn1`, Germany. PostgreSQL and the
   S3-compatible object store are part of the same hosted control plane.
2. On AWS, Google Cloud, Azure and Alibaba Cloud, access uses short-lived
   workload-identity federation and no static cloud key is stored. Clouds with
   no federation (Hetzner, DigitalOcean, Civo) use a scoped API token the
   customer supplies, encrypted at rest (`apps/console/lib/cloud-providers/connections.ts`)
   and never held when the customer runs a self-managed runner.
3. Git OAuth tokens are encrypted at rest. Connector API keys and alert-channel
   secrets are encrypted with `encryptSecret` (`apps/console/lib/crypto/secrets.ts`)
   before they are written. Credentials and secrets must not be
   written to job logs, execution metadata, analytics, support messages, or
   evidence receipts.
4. Optional browser analytics defaults off. The first-party
   `alethia_consent_v2` record lasts 183 days and carries ONE optional choice.
   Global Privacy Control is honoured as a standing opt-out and overrides a
   stored acceptance. Withdrawal must stop future browser collection immediately
   AND delete the provider's identifiers and browser storage from the device
   (`purgePostHogStorage`, asserted by test).
5. Client analytics uses internal ids and low-cardinality plan/role data. It
   excludes email, name, organization name and slug. Server-side third-party
   product analytics is disabled because background contexts cannot prove a
   current browser consent decision.
6. PostHog browser analytics and client-error capture initialize only after
   analytics consent. There is no session replay: the SDK is initialised with
   `disable_session_recording` pinned on and no replay provider is configured or
   shipped. Server/migration errors and OTLP logs are limited to operational
   purposes and must pass the existing secret scrubber.
7. Marketing contact and privacy-request logs must not print message content or
   contact details to application logs.

## Vendors and transfers

`packages/legal/src/processing.ts` is the evidence-gated source for the public
subprocessor page. Only active or customer-directed entries may be rendered.
Inactive and planned systems must remain non-public operational records. Before
adding or activating a provider:

1. document purpose, data categories, legal role, locations, retention,
   security terms, DPA and transfer mechanism;
2. complete a proportional vendor-risk review;
3. prefer an EEA region and disable provider training or secondary use;
4. update the public register at least 14 days before processing where
   practicable;
5. update this inventory, the Privacy Policy, Cookie Notice, consent UI and
   telemetry gate where applicable.

Do not claim a transfer mechanism from configuration alone. Before production
release, record the AWS data processing addendum that covers Amazon SES
(eu-central-1) and any transfer mechanism it relies on, and the PostHog DPA, EU project location, retention setting, and secondary-use
settings. Store contracts and transfer-impact records in the restricted legal
drive, not this public repository. If evidence is missing, disable the provider
or block the release.

## Retention and deletion controls

These windows are no longer prose. `apps/console/lib/retention/registry.ts` is the typed
register they are published from, `apps/console/lib/reconcile/gc.ts` runs the same numbers,
and `apps/console/tests/privacy/retention-registry.test.ts` fails the build when this
document, the register and the SQL disagree — or when a new deletion job ships without an
entry here.

- `gc_job_logs`: 30 days by default.
- `gc_fleet_actions`: 90 days by default.
- `gc_authz_activity_log`: 365 days by default.
- `gc_pending_identities`: 1 day by default. Abandoned connect flows leave a `pending`
  cloud identity holding an account identifier the customer never finished authorising;
  it is deleted rather than kept as an orphan. (This deletion has run since the connect
  sheet shipped and was not recorded here until the register was introduced — which is
  what the register is for.)
- Removed inventory/capability observations: 7 days by default.
- Elench drafts (`elench_drafts`): unsent chat-composer text and the composer state
  stored with it, one row per user, org and conversation. Drafts may hold pasted
  secrets.
  These windows are enforced by `elench-drafts-sweep`
  (`apps/console/lib/elench/drafts-sweep.ts`), a task the reconcile loop runs once a
  day, not by a `gc_*` function. The sweep reads both windows from the register, so
  they have no environment override. The registry test above checks only the `gc_*`
  lines of this document; these two windows are not yet held to it.
  - `elench-drafts`: an active draft not written for 30 days (measured from
    `updated_at`) is deleted, whether or not its user is still a member of the org.
  - `elench-drafts-discarded`: a discarded draft is deleted 24 hours after it was
    discarded (measured from `discarded_at`); the 24 hours are its Undo window.
    Because the sweep runs daily, a discarded draft can stay up to about two days.
  - The sweep never deletes a draft that is being sent (status `sending`). Before it
    deletes, it settles claims that have gone silent past their 120-second lease, as
    a draft action would settle them: the row returns to `active` and `updated_at` is
    renewed, so the settled draft starts a new 30-day window.
  - Each phase of one run handles at most 500 rows per page and 20 pages, on each app
    instance. A settle that fails is rolled back and that row is skipped: it stays
    `sending`, is never deleted, and is retried on a later page or run. Rows beyond
    the bound are left for later runs, so a large backlog takes more than one day to
    clear.
  - On erasure, every draft the subject wrote is erased, in every org, keyed by
    `user_id` (the `elench_drafts` rule in `apps/console/lib/privacy/erasure-plan.ts`).
  - `retentionHealth()` in `apps/console/lib/retention/health.ts` measures both
    windows from the data — the oldest active draft by `updated_at`, the oldest
    discarded one by `discarded_at` — so a sweep that has stopped reads as overdue
    there. No console surface or job calls it yet; until one does, this is evidence
    to be gathered by hand for the quarterly review, not an alert.
- Record and periodically verify the configured PostHog retention for product
  analytics, error diagnostics, and operational logs; do not publish a maximum
  until each setting is evidenced.
- Account closure and privacy deletion requests are handled as recorded CASES
  (`privacy_case`), with an append-only ledger of every step
  (`privacy_case_event`, WORM-enforced in `programmables.sql`). The response
  clock is stored at receipt rather than recomputed, so an extension is visible
  as the decision it is. Nothing is disclosed or destroyed before identity is
  verified, and a refusal cannot be recorded without its grounds.
- What an erasure does is decided BEFORE anything is destroyed, by the register
  in `apps/console/lib/privacy/erasure-plan.ts`: rows that are the subject's
  alone are erased; rows another party's record depends on (a shared support
  thread, an audit entry proving who approved what) are pseudonymized so that
  party's data stays coherent; and rows a legal obligation requires — proof of
  which terms were accepted, statutory accounting records — are retained, each
  citing the obligation. The subject is told which, and why.
- A legal hold PAUSES the destructive half. It never converts the request into
  a refusal, and the paused scope is still enumerated so the subject can see
  what is held.
- Recipients are notified under art. 19 (`VENDOR_ERASURES`). A vendor with no
  erasure API is recorded as `manual`, and the ledger records when a person did
  it — which is more honest than an automated step that quietly does nothing.
- Backups are protected from ordinary use and expire on the configured rotation.
  Two kinds exist. Hetzner server backups of the control-plane box
  (`backups = true` in `infra/cp-hetzner/main.tf`). And a nightly off-box copy
  (`deploy/prod/backup/backup.sh`: the Postgres dump, the object-store buckets
  and the erasure tombstones), encrypted with `age` on the box before upload,
  kept as 14 daily and 8 weekly copies by default (`BACKUP_KEEP_DAILY`,
  `BACKUP_KEEP_WEEKLY`), and written to an S3-compatible store at a provider
  that is deliberately not Hetzner. **NOT ESTABLISHED — which provider holds the
  off-box store, and that the timer runs in production.** The provider is set
  in `/etc/alethia/backup.env` on the box, not in this repository, so it is not
  in the subprocessor register; the restore drill record that
  `docs/ops/restore-runbook.md` names is what shows it runs, and none is in the tree yet. A restore
  reinstates erased data, so every erasure writes a
  `privacy_erasure_tombstone` that outlives it and carries no personal data (the
  identifier is a SHA-256). A restored instance must replay every unreplayed
  tombstone before serving traffic; `unreplayedTombstones()` is that list.

## AI transparency and provider evidence

The assistant is a deployer use of a general-purpose model. It is **not** an
Annex III high-risk system: it drafts infrastructure configuration a human
reviews and approves, and decides nothing about a person's access to services,
employment, credit, education or justice. The art. 50 transparency duty applies
and is discharged by `AI_SYSTEM_DISCLOSURE` (rendered in the console and at
`/ai-transparency`). The classification is re-examined if the assistant ever
gains the ability to apply a change without approval.

A prompt can carry a customer's infrastructure, their code, and whatever they
pasted into it. Before any of it reaches a third-party provider, four things
must be recorded per provider — the data-processing agreement, the transfer
mechanism, the provider's retention, and a no-training commitment — and the
assistant **fails closed** until they are. This is enforced in
`isAiConfigured()`, not documented as an intention: with any of them unset the
routes return 503 and `aiDisabledReason()` names the variable to set.

**NOT ESTABLISHED — requires the four values to be recorded per provider in the
production vault** (`ALETHIA_AI_<PROVIDER>_{DPA,TRANSFER,RETENTION,NO_TRAINING}`).
They are published verbatim at `/ai-transparency`, so a placeholder becomes a
false public statement.

## Controls and evidence

Quarterly review evidence should include:

- consent banner and preferences screenshots;
- configuration showing analytics, error, and log retention, EU region, access
  controls, and disabled provider training/secondary use, and that PostHog
  Session Replay is OFF at the project level;
- a network test proving no optional telemetry before consent and shutdown after
  withdrawal;
- current subprocessor contracts and transfer records;
- retention job health;
- a sample completed privacy request with personal details redacted;
- incident tabletop notes;
- review of public policy dates and controller details.

Legal/privacy owner records the review in the restricted legal drive. Do not
commit personal data, signed DPAs, identity documents, request registers, or
incident evidence to Git.

## Established, and not established

This section exists because the alternative is worse. A compliance record that
simply omits what nobody has evidenced reads, to a reader and to a regulator, as
a record with no gaps — and the gaps are the part that matters. Everything below
is stated as one of two things: **ESTABLISHED**, meaning a named file in this
repository proves it and CI keeps it true, or **NOT ESTABLISHED**, meaning it
requires evidence that does not exist here and must not be asserted anywhere
public until it does.

Nothing here is a legal opinion. It is an inventory of what the repository can
and cannot back up, produced while landing #2371 and re-audited for LEG-L1 (#6920),
for the maintainer to work through. There is no counsel: by the decision of
2026-11-17, agents write and audit the legal set.

### Established — provable from this repository

| Claim | Proof |
| --- | --- |
| Optional analytics is off until affirmative consent | `apps/console/tests/components/analytics-consent-gate.test.tsx` — asserts the SDK is never imported before a decision, and a positive control proves the harness is live |
| Global Privacy Control is honoured and overrides a stored acceptance | `analyticsAllowed()` in `packages/privacy/src/consent.ts`; asserted in `tests/lib/privacy/consent.test.ts` and in the gate test |
| Withdrawal deletes the provider's identifiers and browser storage | `purgePostHogStorage()`; asserted from both the provider and the gate test |
| There is no session replay, and no choice that could enable one | `disable_session_recording` pinned in `analytics-provider.tsx`; no replay provider ships; `processing.test.ts` asserts the register describes no replay purpose |
| The public register lists only active parties plus conditional customer-directed categories | `publicProcessingParties()`; asserted in `packages/legal/src/processing.test.ts` |
| The disclosed consent-cookie name is the one the browser receives | `CONSENT_COOKIE_NAME` is consumed by the cookie notice and asserted equal to `CONSENT_COOKIE` |
| Contact submissions are used only to reply | `apps/marketing/app/server/actions/contact.ts` sends one email to the sales inbox and persists nothing |
| Server-side third-party product analytics is disabled | `apps/console/lib/analytics/server.ts` is a deliberate no-op |

### NOT ESTABLISHED — required before the corresponding claim may be made

| Gap | Requires |
| --- | --- |
| **No paid market is open** | `PAID_MARKETS` in `packages/legal/src/commerce.ts` is empty, so the commerce gate refuses every paid purchase, for businesses and individuals alike. Opening a cell is the maintainer's switch (decisions of 2026-11-17); `docs/legal/PAID_MARKETS.md` lists the evidence a cell needs |
| Off-box backup provider | `deploy/prod/backup/backup.sh` writes an encrypted nightly copy to an S3-compatible store at a provider other than Hetzner. The provider is named only in the box's `backup.env`, so it is not in `processing.ts`. It holds ciphertext only, but it is still a recipient and belongs in the register once named |
| Inbound mailbox provider | Cloudflare Email Routing forwards the published addresses (support@, sales@, legal@, privacy@, security@) to one destination mailbox (`email_forward_to` in `infra/cp-hetzner/email-routing.tf`, supplied from the vault). The provider of that mailbox receives every privacy request and support email and is not in the register |
| Slack support notifications | When `SUPPORT_SLACK_WEBHOOK_URL` is set, each new support case and reply posts its subject, severity and organization id to Slack. Whether it is set in production is a vault fact; Slack is not in the register |
| Anthropic DPA and transfer mechanism | `processing.ts` lists Anthropic because the hosted assistant's default models are Anthropic's. The assistant stays off until `ALETHIA_AI_ANTHROPIC_{DPA,TRANSFER,RETENTION,NO_TRAINING}` are recorded; whether they are, and so whether Anthropic receives prompts today, is a vault fact |
| Stripe DPA and transfer mechanism | The executed DPA reference and the transfer mechanism relied on for card-network processing outside the EEA. Registered as active with no safeguard named |
| AWS (Amazon SES) DPA and transfer mechanism | `processing.ts` records `aws-ses` as active in `Germany (eu-central-1, Frankfurt)`, contracted with Amazon Web Services EMEA SARL. No executed DPA reference or transfer-impact record is in the tree, and AWS support access from outside the EEA is not assessed. #2370 forbids claiming one from configuration |
| Resend, the previous email processor | Removed from the processing register and from the code when hosted email moved to Amazon SES. The maintainer closed the Resend account on 2026-11-21 and the DNS records that authorised it to send for the domain were deleted the same day. Resend's own retention of message data after closure follows its terms; no deletion confirmation from Resend is on file |
| PostHog DPA, EU project location, retention settings, secondary-use settings | Provider-side configuration evidence. Until recorded, no retention maximum may be published |
| Statutory billing retention period | Confirmation against Bulgarian accounting law, then recorded in the processing inventory above |
| Data Protection Officer | Whether a DPO is appointed, and if so the appointment record and published contact point. No DPO is named anywhere in this repository, and absence of a name is not evidence that none is required |
| Data Protection Impact Assessment | Whether a DPIA has been carried out for the AI feature and for infrastructure-control processing, and where the assessment is retained |
| Digital Services Act scope | Whether the Service falls in scope, and on what analysis. No DSA material exists in this repository |
| Accessibility conformance | No WCAG claim is publishable today. `apps/console/e2e/helpers/a11y.ts` returns an empty result set when axe is unavailable, so the harness is fail-open and proves nothing about conformance |
| Personal-data breach log | The runbook exists (`PERSONAL_DATA_BREACH_RUNBOOK.md`); the register of actual incidents is a restricted record and its location is not named |
| Records of Processing Activities, as a maintained artefact | The processing inventory above is the closest thing and is maintained in Git. Whether it is the ROPA of record, or a public-facing summary of one held elsewhere, is undecided |
| Vendor-risk reviews | The procedure is written above; no completed review is referenced for any active provider |

### How to use this table

An entry moves from the second table to the first only when a **file in this
repository** proves it, or when a restricted evidence record is created and this
table names it. Deleting a row without doing either is how a compliance record
becomes fiction.
