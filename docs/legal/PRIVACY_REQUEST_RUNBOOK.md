# Privacy request runbook

Channel: `privacy@alethialabs.io`

Public intake: `/privacy/requests`

Target response: one month from receipt

Staff queue: `/privacy` in the staff console (`apps/admin`). Every case is listed
there with its deadline and an overdue flag; verifying, extending, holding,
refusing and fulfilling a case all happen there and are recorded in the case's
own ledger and in the operator audit log.

## Self-serve requests

Two requests need no email and no staff action:

- **Download my data** (Account settings). The console opens an export case,
  builds a JSON archive with a signed manifest, and emails the account a link
  that works for 72 hours, only while signed in to that account.
- **Delete account** (Account settings). The console checks for live
  environments, cloud connections, projects, teams the account alone owns that
  have other members, and paid subscriptions, and refuses with the reason while
  any remain. Otherwise it schedules the erasure 14 days out, emails a cancel
  link, and signs the account out everywhere. A reminder goes out 7 days before.
  Signing in again or the link cancels it; otherwise the privacy sweep erases the
  account on the day. If the erasure is refused on the day, the case stays open
  in the staff queue.

## Intake

1. Open the case from the staff queue ("Open a case from an email"), which
   records the receipt date, kind, deadline and the hash of the address. Keep
   the requester's correspondence and identity evidence in the restricted
   privacy-request register, never on the case.
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
- configured telemetry provider, only if the requester consented
- selected git, identity, cloud and AI providers where Alethia controls the data
- encrypted backups, recorded for expiry rather than selectively rewritten

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
minimal request log for three years to demonstrate handling, unless counsel
sets a different period.
