# GDPR accountability record

Owner: Alethia Labs legal/privacy

Effective: 2026-07-29

Review cadence: quarterly and before any new vendor or materially new processing

This is the operational record behind the public Privacy Policy, Cookie Notice,
Data Processing Addendum, and Subprocessors page. It is not a claim of
certification. While formation is pending, the controller is Borislav Borisov,
trading as Alethia Labs. Replace the controller details after Alethia Labs DPK
receives its EIK and accepts the relevant contracts.

## Processing inventory

| Activity | People and data | Purpose | GDPR basis | System / recipient | Retention |
| --- | --- | --- | --- | --- | --- |
| Account and authentication | Users; email, name, avatar, provider id, session and sign-in events | Create and secure accounts | Contract; legitimate interests | Alethia PostgreSQL; selected identity provider; AWS SES | Account life plus closure workflow; security records as below |
| Organization and access control | Members; org id, role, grants, authorization decisions | Multi-tenant access and governance | Contract; legitimate interests | Alethia PostgreSQL | Active account; authorization activity 365 days |
| Infrastructure control | Customer users and incidental people in submitted content; configuration, repo/commit metadata, plans, state, job records, logs | Perform requested provisioning and management | Contract; customer instructions under DPA | Hetzner-hosted compute, PostgreSQL and object storage; selected cloud and git providers | Active project; job logs 30 days; removed inventory 7 days |
| Cloud federation | Users and cloud-account administrators; issuer, audience, role, tenant, project and session metadata | Obtain short-lived access to customer cloud accounts | Contract; legitimate interests | Selected cloud provider | Configuration until disconnect; short-lived credentials expire at provider |
| Billing | Billing contacts; organization, plan, invoice, transaction and tax metadata | Charge paid plans and keep accounting records | Contract; legal obligation | Stripe; Alethia PostgreSQL; AWS SES | Contract life; statutory accounting/tax period |
| Support and legal requests | Users and correspondents; contact details, message, evidence and response | Resolve requests and establish legal claims | Contract; legitimate interests; legal obligation | Alethia PostgreSQL/email; Cloudflare routing; AWS SES | Matter closure plus 3 years, unless a claim or law requires longer |
| Security and operations | Users and visitors; IP, user agent, request, incident, audit and diagnostic data | Protect availability, integrity and tenants | Legitimate interests; legal obligation where applicable | Hetzner; Cloudflare; Alethia logs | Minimized by system; job logs 30 days; fleet actions 90 days; authorization activity 365 days |
| Product analytics | Consenting users; pseudonymous internal ids, plan/role, pages, feature events, performance, client errors | Understand and improve the Service | Consent | PostHog EU or self-hosted Umami | Maximum 12 months |
| Session replay | Separately consenting users; masked page and interaction recording | Reproduce interface failures | Consent | PostHog EU and/or configured OpenReplay | Maximum 30 days |
| AI assistance | Users and people in submitted context; prompt, selected Service context, response and usage | Provide a user-requested AI feature | Contract; customer instructions under DPA | Configured Anthropic or OpenAI endpoint | Provider retention governed by contracted configuration; Alethia product analytics receives no prompt or output |

## Data-flow and minimization rules

1. Hosted primary data remains in Hetzner `fsn1`, Germany. PostgreSQL and the
   S3-compatible object store are part of the same hosted control plane.
2. Static customer cloud keys are prohibited. Cloud access uses short-lived
   workload-identity federation.
3. Git OAuth tokens are encrypted at rest. Credentials and secrets must not be
   written to job logs, execution metadata, analytics, support messages, or
   evidence receipts.
4. Optional analytics and replay default off. The first-party
   `alethia_consent_v1` record lasts 183 days and keeps independent boolean
   choices. Withdrawal must stop future collection immediately.
5. Client analytics uses internal ids and low-cardinality plan/role data. It
   excludes email, name, organization name and slug. Server-side third-party
   product analytics is disabled because background contexts cannot prove a
   current browser consent decision.
6. PostHog replay masks all inputs and page text. OpenReplay obscures input
   values and email-like text. Sensitive product subtrees should also carry
   provider-specific masking attributes.
7. Marketing contact and privacy-request logs must not print message content or
   contact details to application logs.

## Vendors and transfers

The public `apps/marketing/app/legal/subprocessors/page.tsx` register is the
source presented to customers. Before adding a provider:

1. document purpose, data categories, legal role, locations, retention,
   security terms, DPA and transfer mechanism;
2. complete a proportional vendor-risk review;
3. prefer an EEA region and disable provider training or secondary use;
4. update the public register at least 14 days before processing where
   practicable;
5. update this inventory, the Privacy Policy, Cookie Notice, consent UI and
   telemetry gate where applicable.

Restricted transfers rely on an adequacy decision or the 2021 EU Standard
Contractual Clauses incorporated by the DPA, plus encryption, access control,
minimization and a transfer-impact review. Store executed vendor DPAs and TIAs
in the restricted legal drive, not this public repository.

## Retention and deletion controls

- `gc_job_logs`: 30 days by default.
- `gc_fleet_actions`: 90 days by default.
- `gc_authz_activity_log`: 365 days by default.
- Removed inventory/capability observations: 7 days by default.
- Replay: configure provider retention at 30 days or less.
- Product analytics: configure provider retention at 12 months or less.
- Account closure and privacy deletion requests are currently handled through
  the verified privacy-request runbook. Automated deletion must not ship until
  it covers dependent tenant data, billing/legal holds, backups, and connected
  vendors.
- Backups are protected from ordinary use and expire on the configured rotation.
  If restored, the deletion queue must be replayed before normal operation.

## Controls and evidence

Quarterly review evidence should include:

- consent banner and preferences screenshots;
- configuration showing analytics/replay retention and EU region;
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
