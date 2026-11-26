# Privacy request runbook

Channel: `privacy@alethialabs.io`

Public intake: `/privacy/requests`

Target response: one month from receipt

## Intake

1. Record the request as a privacy case. The console keeps cases in
   `privacy_case`, with every step appended to `privacy_case_event` (WORM in
   `apps/console/lib/db/programmables.sql`); the response clock is stored at
   receipt. A signed-in user who presses **Delete account** in the account
   settings opens an erasure case themselves (`requestMyErasure` in
   `apps/console/app/server/actions/privacy/self-serve.ts`), recorded as
   session-verified, and the privacy inbox is emailed. A request that arrives
   by email is recorded by a platform admin on the staff app's **Privacy**
   page (`apps/admin/app/privacy`), with the day it arrived so the clock starts
   at receipt. The same page lists every overdue and open case, and each case
   page verifies identity, extends once, applies a legal hold, fulfils an
   erasure (behind a typed confirmation) or refuses with grounds. Every step
   is written to the case ledger and to `platform_audit`. The case table does
   not hold jurisdiction, systems searched or evidence location: keep those in
   the restricted privacy-request register, never in a case reason.
2. Acknowledge promptly. Never copy the request or identity evidence into Git,
   issue trackers, analytics, or ordinary chat.
3. Triage whether Alethia is controller. If a business customer is controller,
   notify that customer and assist under the DPA.

## Verification

Use the least intrusive method proportionate to the request:

- signed-in confirmation for an authenticated account;
- one-time confirmation sent to the account email;
- organization-admin confirmation for organization-scoped data;
- proof of authority plus separate account-holder verification for an agent.

Do not request a government identity document unless a concrete, documented
risk makes weaker methods insufficient. Keep verification evidence separate
from the response bundle and delete it when no longer needed.

## Search map

- Better Auth account/session and organization membership
- project, environment, connector, job, evidence and activity tables
- object storage and state objects
- support cases and inbound/outbound email
- Stripe customer, subscription, invoice and transaction records
- configured telemetry provider (PostHog EU), only if the requester consented,
  and its operational logs
- the AI provider (Anthropic by default) where Alethia sent the requester's
  prompts, and the stored assistant conversations
- Slack, if support notifications are configured (case subject only)
- selected git, identity, cloud and connector providers where Alethia controls
  the data
- encrypted backups (Hetzner server backups and the off-box copy), recorded for
  expiry rather than selectively rewritten; the erasure tombstone makes a
  restore replay the deletion

Use tenant-scoped access and the break-glass process where required. Export only
the requester’s personal data, review third-party data and secrets, and provide
a common, machine-readable format for portability where applicable.

## Decision and execution

1. Determine applicable right, basis and any exemption with reasons.
2. Place a legal hold only for a defined obligation or claim, with scope and
   review date.
3. Correct, restrict, export, object, or delete across each system. Revoke
   sessions and connected tokens on account deletion.
4. Send processor requests to applicable vendors and record completion.
5. Record backup expiry and ensure restored data is re-deleted.
6. Have a second person review an access export or high-impact deletion when
   staffing permits.

## Response

Respond securely with actions taken, requested data or refusal reasons, any
extension, recipients and retention information where required, and the right
to complain to the Bulgarian Commission for Personal Data Protection or the
requester’s local authority. Complex or numerous requests may be extended by up
to two months; notify the requester within the first month.

Close only after every system and vendor action has evidence. Retain the
minimal request log for three years to demonstrate handling. There is no counsel
to set a different period (decision of 2026-11-17); a change is the maintainer's.
