# Claims ledger: the audit's written record

Effective: 2026-11-22

Owner: LEG-L1 (#6920)

This is the written record of the LEG-L1 audit: every legal page in the unit's scope, read
against what the code does with personal data. The machine-checked part lives in
[`legal-set.json`](legal-set.json): each statement listed below is either a **claim** there (tied
to the code that makes it true, or `outside-repo` with what would settle it) or a **finding**
(a statement the code does not bear out, with the unit that fixes it). This file says what was
read, what was decided, and what was left, so the next reader can tell an examined page from an
unexamined one.

No lawyer reviewed this. By the maintainer's decision of 2026-11-17, agents write and audit the
legal set.

## What "data statement" meant

A sentence about what is collected, why, where it is stored or sent, who processes it, how long it
is kept, how it is deleted, cookies and device storage, analytics, or the email provider. Pure
contract language (liability, governing law, audit rights) and descriptions of a person's rights
were read but are not data statements and are not listed.

## Sealed pages could not be edited here

The Privacy Policy, the Cookie Notice and the imprint are hash-sealed in
`packages/legal/src/documents.ts`, which belongs to LEG-L2 (#6949), the unit that re-seals after
LEG-L1 and LEG-L4. Changing a sealed page without re-sealing fails CI. So where a sealed page is
wrong, this audit records a finding owned by LEG-L2 with proposed replacement text, and LEG-L2
applies it when it re-seals. The unsealed pages were corrected directly.

## Page by page

### Privacy Policy (`/privacy`, sealed)

| Statement | Result |
| --- | --- |
| Social sign-in providers; email one-time code | claim `privacy.sign-in-methods` |
| Cloud connections keep only federation configuration; "Alethia does not store static cloud access keys" | finding `privacy.static-cloud-keys` (LEG-L2): true only for the federated clouds |
| Stripe is the payment processor | claim `privacy.subprocessor.stripe` (LEG-S1) |
| Card fields are Stripe-hosted | claim `privacy.card-fields-stripe-hosted` (replaced on 2026-11-24 by `privacy.card-fields-paddle-checkout` when card sales moved to Paddle) |
| No session replay; GPC honoured; withdrawal purges storage | claims `privacy.no-session-replay`, `privacy.global-privacy-control`, `privacy.withdrawal-purges-storage` |
| Analytics uses internal identifiers | claim `privacy.analytics-internal-ids` |
| Server errors and operational logs go to PostHog | claim `privacy.operational-data-posthog` |
| Infrastructure and service data categories | finding `privacy.ai-conversations-not-listed` (LEG-L2): assistant conversations are missing |
| Hetzner `fsn1` hosts the control plane, database and object store | claim `privacy.hosting-fsn1` |
| Cloudflare processes edge data | claim `privacy.cloudflare-edge` |
| Email through Amazon SES, eu-central-1 | claim `privacy.email-provider` (outside-repo: the vault may name the SMTP rollback) |
| PostHog EU Cloud | claim `privacy.posthog-eu` |
| Job logs 30 days; fleet actions 90; authorization activity 365; removed inventory 7 | claims `privacy.retention.*` |
| Support correspondence up to 3 years | finding `privacy.support-retention-not-enforced` (LEG-L4, #7220): nothing deletes it |
| Backup rotation; restores re-apply deletion | claim `privacy.backup-rotation-and-replay` (outside-repo: that the timers run in production) |
| Account records deleted or anonymized after closure | read against `apps/console/lib/privacy/erasure-plan.ts`; deletion is a case a person fulfils, and no staff screen exists yet (#7222) |
| Invoices kept for the statutory period | not tied: the period is unconfirmed, as `GDPR_ACCOUNTABILITY.md` already records |
| PostHog retention "available on request" | not tied: provider configuration, recorded as not established in `GDPR_ACCOUNTABILITY.md` |

### Cookie Notice (`/cookies`, sealed)

| Statement | Result |
| --- | --- |
| One optional choice, off until turned on | claim `cookies.analytics-off-until-consent` (LEG-S1) |
| Session cookie names | claim `cookies.session-cookie-name` |
| Consent cookie name, contents and 183 days | claim `cookies.consent-cookie.lifetime` (LEG-S1) |
| PostHog EU after consent; internal identifiers | claims `cookies.posthog-eu-after-consent`, `cookies.analytics-attributes` |
| Recording cannot start; GPC wins | claims `cookies.no-session-replay`, `cookies.global-privacy-control` (LEG-S1) |
| Interface storage (theme, workspace, local state) | read: next-themes `theme`, a session-change broadcast key, and per-tab drafts in sessionStorage. Not tied: the line is a category, not a list |

No finding. The Cookie Notice matches the code.

### Company information (`/imprint`, sealed)

Claim `imprint.not-vat-registered`. The rest is the entity record, not data processing.

### Privacy requests (`/privacy/requests`) — corrected

- "analytics and replay consent" → "your analytics choice": there is no replay consent (closes the
  LEG-S1 finding `privacy-requests.replay-consent`).
- Added the console's **Delete account** request: claim
  `privacy-requests.console-deletion-request`.

### Subprocessors (`/legal/subprocessors`) — corrected through `processing.ts`

The page renders `PROCESSING_PARTIES` and `CUSTOMER_DIRECTED_PARTIES`. Against the services the
code calls:

| Service | Called by | Register |
| --- | --- | --- |
| Hetzner | control plane, runners, server backups | listed (claim `subprocessors.hetzner-backups`) |
| Cloudflare | tunnel, DNS, email routing, admin access | listed |
| PostHog EU | consented analytics; operational logs | listed |
| Stripe | billing | listed |
| Amazon SES | transactional email | listed |
| **Anthropic** | the assistant's default models, on Alethia's own key | **added** (claim `subprocessors.anthropic-default-provider`, outside-repo: whether the assistant is on) |
| "The AI model endpoint you configure" | nothing: the hosted product offers no such choice | **removed** |
| OpenAI | only an operator's `openai/*` model override | not listed; no default resolves to it |
| Off-box backup store | `deploy/prod/backup/backup.sh` | finding `module-processing.backup-store-unregistered` (#7223) |
| Inbound mailbox | Cloudflare Email Routing destination | finding `module-processing.inbound-mailbox-unregistered` (#7223) |
| Slack | support-case notifications, if configured | finding `module-processing.slack-unregistered` (#7223) |
| Odoo | invoice of record, if configured | not listed: self-hosted on Hetzner, so covered by Hetzner |
| Rekor (Sigstore) | evidence-receipt anchoring, if enabled | not listed: receives a hash only, no personal data |
| GitHub, GitLab, Bitbucket, Google | sign-in and repositories | customer-directed categories and independent controllers for sign-in |

### Data Processing Addendum (`/legal/dpa`)

Claim `dpa.processing-in-germany`. The 14-day notice for new subprocessors is a procedure, not
code; adding Anthropic to the list now is recorded in #7223 with the question of whether it already
receives data.

### Switching and data portability (`/legal/data-act`) — corrected

- "under credentials we never store" was false for token clouds and connector keys: now says the
  federated clouds store no key and the others are held encrypted (claims
  `data-act.federated-clouds-store-no-key`, `data-act.tokens-encrypted`).
- "their state … stay where they are" was false: Alethia holds the OpenTofu state (claim
  `data-act.state-held`).
- "You can export all of it … from the console" was false: there is no export yet (LEG-L3 builds
  it). Now says so and offers the export by email (claim `data-act.no-self-service-export`; closes
  the LEG-S1 finding `data-act.console-export`).
- Deletion at the end of the retrieval window is a procedure (claim
  `data-act.deleted-after-retrieval`, outside-repo); what is kept is tied
  (`data-act.retained-after-deletion`).

### Consumer rights (`/consumer-rights`) — corrected

- The missing VAT registration was given as the reason no individual can pay; the reason is that
  no market is open (claim `consumer-rights.no-consumer-market`; closes the LEG-S1 finding).
- "from the billing settings in the console": no component calls the withdrawal action. Now says
  email, and that the console control comes before consumer sales (finding
  `consumer-rights.withdrawal-control-missing`, REL-L4, #7221).
- 2026-11-23, the maintainer's legal review (#7351): the control exists (#7221), so the page names it
  again (claim `consumer-rights.console-withdrawal`; the finding is removed). It adds the sentence
  for an owed refund that could not be issued automatically (claim `consumer-rights.refund-arranged`,
  outside-repo: a person acts on the operator alert), and a Bulgarian section, `#bg`. The page is now
  hash-sealed in `LEGAL_DOCUMENTS` for `en` and `bg-BG`.

### Security (`/security`) — corrected

- Token clouds encrypted, federated clouds hold nothing: claims `security.token-clouds-encrypted`,
  `security.federated-clouds-store-nothing`.
- "What we do hold" named only the identity provider's signing key; it now also says Alethia holds
  the credentials given for git providers and connectors.

### Acceptable Use Policy, legal index, source offer

Read. No data statements beyond enforcement wording; nothing to tie.

## Internal records

- `GDPR_ACCOUNTABILITY.md`: the cloud-key rule now matches the token clouds; the AI row names
  Anthropic; support rows name Slack and the unnamed mailbox; backups describe the real rotation;
  the paid-markets gap pointed at the wrong file and said billing was live while no market is open;
  three recipients configured outside the repository are listed as not established.
- `PRIVACY_REQUEST_RUNBOOK.md`: intake now uses the console's privacy cases and says which steps have
  no screen yet (#7222); the search map adds the AI provider, Slack and both backups; "counsel" is
  gone.
- `PERSONAL_DATA_BREACH_RUNBOOK.md`: "counsel" is gone; points at the subprocessor register.

## Left open, and why

- Sealed-page corrections wait for LEG-L2's re-seal (#6949): `privacy.static-cloud-keys`,
  `privacy.ai-conversations-not-listed`.
- Code changes are filed, not made here: #7220 (support retention, stale register entries), #7221
  (consumer withdrawal control), #7222 (staff screen for privacy cases).
- Facts held outside the repository are asked of the maintainer in #7223.
