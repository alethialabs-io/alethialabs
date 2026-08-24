# GDPR accountability record

Owner: Alethia Labs legal/privacy

Effective: 2026-08-12

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
| Account and authentication | Users; email, name, avatar, provider id, session and sign-in events | Create and secure accounts | Contract; legitimate interests | Alethia PostgreSQL; selected identity provider; Resend | Account life plus closure workflow; security records as below |
| Organization and access control | Members; org id, role, grants, authorization decisions | Multi-tenant access and governance | Contract; legitimate interests | Alethia PostgreSQL | Active account; authorization activity 365 days |
| Infrastructure control | Customer users and incidental people in submitted content; configuration, repo/commit metadata, plans, state, job records, logs | Perform requested provisioning and management | Contract; customer instructions under DPA | Hetzner-hosted compute, PostgreSQL and object storage; selected cloud and git providers | Active project; job logs 30 days; removed inventory 7 days |
| Cloud federation | Users and cloud-account administrators; issuer, audience, role, tenant, project and session metadata | Obtain short-lived access to customer cloud accounts | Contract; legitimate interests | Selected cloud provider | Configuration until disconnect; short-lived credentials expire at provider |
| Billing | Billing contacts; organization, plan, invoice, transaction and tax metadata. Card data is entered into Stripe-hosted fields and is never received by Alethia | Take payment for paid plans and keep statutory records | Contract; legal obligation | Alethia PostgreSQL; **Stripe Payments Europe, Ltd. (active)** | Statutory accounting period. **NOT ESTABLISHED — requires the retained period to be confirmed against Bulgarian accounting law and recorded here** |
| Support and legal requests | Users and correspondents; contact details, message, evidence and response | Resolve requests and establish legal claims | Contract; legitimate interests; legal obligation | Alethia PostgreSQL/email; Cloudflare routing; Resend | Matter closure plus 3 years, unless a claim or law requires longer |
| Security and operations | Users and visitors; IP, user agent, request, incident, audit and diagnostic data | Protect availability, integrity and tenants | Legitimate interests; legal obligation where applicable | Hetzner; Cloudflare; Alethia logs | Minimized by system; job logs 30 days; fleet actions 90 days; authorization activity 365 days |
| Product analytics and client diagnostics | Consenting users; pseudonymous internal ids, plan/role, pages, feature events, performance and client errors | Understand, improve and diagnose the Service | Consent | PostHog EU Cloud | Provider retention must be verified and recorded before release |
| Operational diagnostics | Users and visitors; minimized server and migration errors, request metadata and structured operational logs | Secure, diagnose and maintain the hosted Service | Legitimate interests | PostHog EU Cloud | Provider retention must be verified and recorded before release |
| AI assistance | Users and people in submitted context; prompt, selected Service context, response and usage | Provide a user-requested AI feature | Contract; customer instructions under DPA | Configured Anthropic or OpenAI endpoint | Provider retention governed by contracted configuration; Alethia product analytics receives no prompt or output |

## Data-flow and minimization rules

1. Hosted primary data remains in Hetzner `fsn1`, Germany. PostgreSQL and the
   S3-compatible object store are part of the same hosted control plane.
2. Static customer cloud keys are prohibited. Cloud access uses short-lived
   workload-identity federation.
3. Git OAuth tokens are encrypted at rest. Credentials and secrets must not be
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
release, record the executed Resend DPA and applicable transfer mechanism, and
the PostHog DPA, EU project location, retention setting, and secondary-use
settings. Store contracts and transfer-impact records in the restricted legal
drive, not this public repository. If evidence is missing, disable the provider
or block the release.

## Retention and deletion controls

- `gc_job_logs`: 30 days by default.
- `gc_fleet_actions`: 90 days by default.
- `gc_authz_activity_log`: 365 days by default.
- Removed inventory/capability observations: 7 days by default.
- Record and periodically verify the configured PostHog retention for product
  analytics, error diagnostics, and operational logs; do not publish a maximum
  until each setting is evidenced.
- Account closure and privacy deletion requests are currently handled through
  the verified privacy-request runbook. Automated deletion must not ship until
  it covers dependent tenant data, billing/legal holds, backups, and connected
  vendors.
- Backups are protected from ordinary use and expire on the configured rotation.
  If restored, the deletion queue must be replayed before normal operation.

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
and cannot back up, produced while landing #2371, for the maintainer to work
through with counsel.

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
| **Paid markets are unrecorded while billing is live** | `PAID_MARKETS` in `packages/legal/src/processing.ts` is empty, yet Stripe billing is active and the pricing page advertises per-seat monthly charging. Either the markets where charging is offered are recorded there, or the commerce gates in #2372 are enforcing against an empty set. This is the most consequential gap in this table |
| Stripe DPA and transfer mechanism | The executed DPA reference and the transfer mechanism relied on for card-network processing outside the EEA. Registered as active with no safeguard named |
| Resend DPA and transfer mechanism | `processing.ts` records `region: "United States"` with no SCC or transfer-impact record anywhere in the tree. #2370 forbids claiming one from configuration |
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
