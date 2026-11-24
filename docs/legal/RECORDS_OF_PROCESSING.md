<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Records of processing activities

**Status: Draft — pending maintainer legal review (#7351).** Written by an agent for LEG-L4 (#6922).
No lawyer has reviewed it.

Owner: LEG-L4 (#6922)

Effective: 2026-11-23

This is the record GDPR art. 30 asks for, in two parts:

- **Part A** covers what Alethia does as a **controller** (art. 30(1)).
- **Part B** covers what it does as a **processor** for its customers, under the Data Processing
  Addendum at `/legal/dpa` (art. 30(2)).

Every row is taken from the code, from a claim in `legal-set.json`, or from
`GDPR_ACCOUNTABILITY.md`, and each row names its source. Where neither the code nor the register
answers a question, the row says **Open: maintainer to confirm**. Those items are collected at the end.

`GDPR_ACCOUNTABILITY.md` has a processing inventory of its own. That file records it as undecided
whether its inventory is "the ROPA of record, or a public-facing summary of one held elsewhere". This
document is written to be the record. **Open: maintainer to confirm** that it is, and if so, cut the
inventory in `GDPR_ACCOUNTABILITY.md` down to a pointer here, so the two cannot drift.

Retention periods are not repeated here. Each row names the class of data, and `RETENTION_SCHEDULE.md`
gives the period and the code that enforces it.

## The controller

| Field | Value | Source |
| --- | --- | --- |
| Name | ALETHIA LABS (АЛЕТИЯ ЛАБС), a Bulgarian single-member variable capital company, EIK 208913663 | `packages/legal/src/entity.ts`; `GDPR_ACCOUNTABILITY.md` |
| Privacy contact | privacy@alethialabs.io | `LEGAL_ENTITY.privacyEmail` |
| Legal contact | legal@alethialabs.io | `LEGAL_ENTITY.contactEmail` |
| Representative in the EU | Not needed: the controller is established in the EU (Bulgaria) | `packages/legal/src/entity.ts` |
| Data protection officer | **Open: maintainer to confirm** whether one is required or appointed. No DPO is named anywhere in the repository | `GDPR_ACCOUNTABILITY.md`, "Not established" |

## Part A — Alethia as controller

### A1. Accounts and sign-in

| Field | Entry |
| --- | --- |
| Purpose | Create and secure accounts; let a person sign in |
| Data subjects | Users of the console and the CLI |
| Personal data | Email, name, avatar, provider handle and id (`user`, `profiles`, `account`); sessions with the IP address and user agent they were created from (`session`); CLI device-login records with the request IP (`cli_logins`); OAuth tokens and consents (`oauth_*`); sign-in rate-limit keys, which contain the client IP (`rate_limit`, `rate_limit_buckets`) |
| Sources | The person; the identity provider they chose (GitHub, GitLab, Bitbucket or Google), or a one-time email code (claim `privacy.sign-in-methods`) |
| Lawful basis | Contract; legitimate interests for security records (`GDPR_ACCOUNTABILITY.md`) |
| Recipients | The chosen identity provider, as an independent controller; Amazon SES for sign-in codes (claim `privacy.email-provider`, outside-repo); Hetzner hosting (claim `privacy.hosting-fsn1`) |
| Transfers outside the EEA | None for the data at rest (Hetzner `fsn1`, Germany). The identity providers act on their own account |
| Retention | `RETENTION_SCHEDULE.md` §4 (account rows); §1 (rate-limit counters) |

### A2. Organizations and access control

| Field | Entry |
| --- | --- |
| Purpose | Run multi-tenant organizations, roles and grants; record who could see and do what |
| Data subjects | Members of customer organizations |
| Personal data | Organization membership, role and team; every authorization decision (`authz_activity_log`); the audit trail of who approved what (`audit_log`); break-glass sessions and approvals |
| Lawful basis | Contract; legitimate interests (`GDPR_ACCOUNTABILITY.md`) |
| Recipients | None outside Alethia's hosting |
| Transfers | None |
| Retention | `RETENTION_SCHEDULE.md` §1 (`authz-activity`, 365 days); §4 (`audit_log`, break-glass) |

The authorization log records every allow and deny for every member, for a year. That is systematic
recording of how people in the customer's organization use the product. `DPIA.md` §3 assesses it.

### A3. Billing, invoicing and orders

| Field | Entry |
| --- | --- |
| Purpose | Take payment for paid plans; issue invoices and фактура; keep statutory records |
| Data subjects | Billing contacts; the person who placed an order |
| Personal data | Organization, plan, invoice, transaction and tax metadata (`commerce_order`, `invoice`, `factura`). Card data goes into Stripe-hosted fields and never reaches Alethia (claim `privacy.card-fields-stripe-hosted`) |
| Lawful basis | Contract; legal obligation |
| Recipients | Stripe Payments Europe, Ltd., active (claim `privacy.subprocessor.stripe`) |
| Transfers | `processing.ts` gives Stripe's region as "Ireland (EEA), with global card-network processing". **Open: maintainer to confirm** the transfer mechanism (`GDPR_ACCOUNTABILITY.md`, "Stripe DPA and transfer mechanism") |
| Retention | `RETENTION_SCHEDULE.md` §2. The statutory period is **not established** |

No paid market is open: `PAID_MARKETS` in `packages/legal/src/commerce.ts` is empty (claim
`gdpr-accountability.no-paid-market`). The activity exists in the code, and it records Early Access
grant requests (`early_access_request`, with the VIES result) today.

### A4. Support, privacy requests and correspondence

| Field | Entry |
| --- | --- |
| Purpose | Answer support requests; handle data-subject requests; establish or defend legal claims |
| Data subjects | Users and anyone who writes to a published address |
| Personal data | Contact details, messages, internal notes, attachments (`support_cases` and children); privacy cases and their append-only ledger (`privacy_case`, `privacy_case_event`); erasure tombstones, which hold a SHA-256 and no personal data (`privacy_erasure_tombstone`) |
| Lawful basis | Contract; legitimate interests; legal obligation (`GDPR_ACCOUNTABILITY.md`) |
| Recipients | Amazon SES for outbound mail; Cloudflare Email Routing for inbound mail to a destination mailbox. **Open: maintainer to confirm** the mailbox provider. It is supplied from the vault, not the repository (finding `module-processing.inbound-mailbox-unregistered`). Slack receives case number, subject, severity and organization id only if `SUPPORT_SLACK_WEBHOOK_URL` is set (finding `module-processing.slack-unregistered`) |
| Transfers | Cloudflare: "EEA and global edge network" (`processing.ts`). **Open: maintainer to confirm** the mechanism |
| Retention | `RETENTION_SCHEDULE.md` §1 (`support-cases`, 3 years after the matter closes, after #7388); §4 (privacy cases, tombstones) |

### A5. Security, operations and diagnostics

| Field | Entry |
| --- | --- |
| Purpose | Keep the service available and secure; diagnose faults |
| Data subjects | Users and visitors |
| Personal data | IP address, user agent, request metadata, minimized server and migration errors, structured operational logs |
| Lawful basis | Legitimate interests (`processing.ts`, PostHog's third purpose) |
| Recipients | Hetzner; Cloudflare (claim `privacy.cloudflare-edge`); PostHog EU Cloud (claims `privacy.operational-data-posthog`, `privacy.posthog-eu`) |
| Transfers | PostHog's region in `processing.ts` is "European Union". The contracting entity is PostHog, Inc. **Open: maintainer to confirm** whether any transfer mechanism is relied on |
| Retention | `RETENTION_SCHEDULE.md` §3: PostHog retention **not established** |

### A6. Product analytics (consent only)

| Field | Entry |
| --- | --- |
| Purpose | Understand and improve the product; client error diagnostics |
| Data subjects | Visitors and users who turned analytics on |
| Personal data | Internal account and organization ids, plan and role, pages, feature events, performance, client errors. No email, name or organization name (claim `privacy.analytics-internal-ids`). No session replay (claim `privacy.no-session-replay`) |
| Lawful basis | Consent. Off until given (claim `cookies.analytics-off-until-consent`); Global Privacy Control wins (claim `privacy.global-privacy-control`); withdrawal purges device storage (claim `privacy.withdrawal-purges-storage`) |
| Recipients | PostHog EU Cloud |
| Transfers | As A5 |
| Retention | `RETENTION_SCHEDULE.md` §3 (provider, **not established**); the consent cookie lasts 183 days (claim `cookies.consent-cookie.lifetime`) |

### A7. Marketing contact form

The form at the marketing site sends one email to the sales inbox and stores nothing
(`apps/marketing/app/server/actions/contact.ts`). Purpose: answer the enquiry. Basis: legitimate
interests or pre-contract steps. **Open: maintainer to confirm** the basis. Recipients: Amazon SES, and
the inbound mailbox in A4.

### A8. Backups

| Field | Entry |
| --- | --- |
| Purpose | Restore the service after loss |
| Data subjects | Everyone in A1 to A6 and Part B |
| Personal data | A copy of the database, the object-store buckets and the erasure tombstones, encrypted with `age` on the box before upload (`deploy/prod/backup/backup.sh`) |
| Lawful basis | Legitimate interests |
| Recipients | Hetzner (server backups, `infra/cp-hetzner/main.tf`; claim `subprocessors.hetzner-backups`); an off-box S3 store. The repository's IaC puts that store in a dedicated AWS account in `eu-central-1` (`infra/backup-account/`). **Open: maintainer to confirm** that production writes there, and register the provider (finding `module-processing.backup-store-unregistered`) |
| Transfers | None if the store is `eu-central-1` |
| Retention | `RETENTION_SCHEDULE.md` §3, "Off-box backups": at most 76 days, after #7388 |

## Part B — Alethia as processor for its customers

The Data Processing Addendum (`/legal/dpa`) makes Alethia a processor for what customers put into the
service. Processing is primarily in Germany (claim `dpa.processing-in-germany`).

### B1. Infrastructure control

| Field | Entry |
| --- | --- |
| Controller | The customer organization |
| Categories of processing | Store and run the customer's project configuration; plan, apply and destroy infrastructure in the customer's cloud; hold the OpenTofu state of what Alethia provisioned (claim `data-act.state-held`); read and write the GitOps repository the customer names; record job logs and the fleet action ledger |
| Personal data | Mostly incidental: names and emails in commit metadata, in configuration and in whatever the customer's tooling prints to a job log |
| Sub-processors | Hetzner (hosting); the cloud, git host and connectors the customer connects, which are customer-directed categories (`processing.ts`: `customer-cloud`, `customer-git`, `customer-connector`) |
| Credentials | Federated clouds: no key stored (claims `data-act.federated-clouds-store-no-key`, `security.federated-clouds-store-nothing`). Token clouds and connector keys: held encrypted at rest (claims `data-act.tokens-encrypted`, `security.token-clouds-encrypted`) |
| Transfers | Whatever region the customer chooses for its own cloud and git host. That is the customer's choice, not a transfer Alethia makes |
| Retention | `RETENTION_SCHEDULE.md` §1 (job logs, fleet actions, removed inventory); §4 (jobs, OpenTofu state) |

### B2. AI assistance on customer content

| Field | Entry |
| --- | --- |
| Controller | The customer organization |
| Categories of processing | Send the user's prompt and selected service context to a model provider and store the conversation. During a repository scan, send the text of selected repository files to the model to infer the stack. `AI_ACT_POSITION.md` §3 lists the files |
| Personal data | Whatever the user typed or pasted; names, emails and any secrets present in the repository files read by a scan |
| Sub-processors | Anthropic (default models; registered active in `processing.ts`; claim `subprocessors.anthropic-default-provider`, outside-repo). OpenAI only if an operator sets an `openai/*` model override (`apps/console/lib/config/ai.ts`) |
| Transfers | Anthropic's region in `processing.ts` is "United States". **Open: maintainer to confirm** the mechanism. It should be the value of `ALETHIA_AI_ANTHROPIC_TRANSFER` in the production vault |
| Not sent | Prompts and outputs do not go to product analytics (`captureAiGeneration` in `apps/console/lib/analytics/server.ts` is a no-op). The model never receives cloud credentials (`AI_SYSTEM_DISCLOSURE` in `apps/console/lib/ai/transparency.ts`) |
| Retention | `RETENTION_SCHEDULE.md` §1 (drafts); §3 (provider); §4 (conversations, scan digests in `jobs`) |

### B3. Support on the customer's behalf

Customer data a user shares inside a support case is processed under A4. **Open: maintainer to
confirm** whether that is processor or controller processing. The DPA does not say.

## Security measures (art. 30(1)(g), art. 32)

These are described only where a claim or a named file shows them.

- Hosted data stays in Hetzner `fsn1`, Germany (claim `privacy.hosting-fsn1`).
- Federated cloud access with no stored key. Token-cloud and connector credentials are encrypted
  before they are written (claims above; `encryptSecret` in `apps/console/lib/crypto/secrets.ts`).
- The authorization log and the privacy-case ledger are append-only, enforced by triggers in
  `programmables.sql`.
- Erasure is planned before anything is destroyed (`apps/console/lib/privacy/erasure-plan.ts`) and
  leaves a tombstone that a restore can replay.
- Backups are encrypted on the box before upload (`deploy/prod/backup/backup.sh`).
- Optional analytics is off until consent, and no session replay is configured (claims above).
- The assistant's chat routes refuse to call a provider until four evidence values are recorded for
  it (`isAiConfigured()`, `apps/console/lib/config/ai.ts`).

## Open: maintainer to confirm

1. That this document is the record of processing, and that `GDPR_ACCOUNTABILITY.md`'s inventory is
   cut down to a pointer here.
2. Whether a data protection officer is required or appointed.
3. The transfer mechanism for each of Stripe, Cloudflare, PostHog, Anthropic and Amazon SES, and the
   executed DPA reference for each. These are held outside the repository.
4. The inbound mailbox provider (A4) and the off-box backup provider (A8), so both can be registered.
5. Whether `SUPPORT_SLACK_WEBHOOK_URL` is set in production.
6. The lawful basis for the marketing contact form (A7).
7. Whether support handling of customer content (B3) is processor or controller processing.
