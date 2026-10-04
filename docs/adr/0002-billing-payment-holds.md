---
status: proposed
issue: "#5506"
date: 2026-10-04
---

# Payment holds: a write-ahead state machine for first-payment uncertainty

**Decision (proposed).** Every time a purchase flow is about to make an earlier subscription
unpayable (void its invoice, cancel it), it first writes a **payment hold** row. The hold is then
moved through one state machine until a Stripe read proves the subscription is settled. Every hold
reads only the invoice it was opened on. While a hold in a purchase **scope** is open, that scope
cannot mint. One function (`advanceHold`) is the only code that moves a hold. Three callers run it,
each under the payer's lease: the purchase flow (and the create-a-team link), a **required**
scheduled sweeper, and the operator command. The Stripe webhook only nudges the sweeper (rev 3).
Only an operator command can release a hold that the machine cannot settle.

This replaces the "refuse without memory" behaviour that #5489 shipped. It is written before any
code, as #5506 requires, and the maintainer reviews it. It meets the ADR bar: a new table and new
webhook behaviour are hard to reverse. A write-ahead row before a Stripe call is surprising without
this context. The alternatives (Stripe metadata as the store, holds written after the fact, one
global hold scope) were real and are recorded below.

Every claim about today's code cites `file:line` at `origin/dev` `857794cb9` (#5489 merged). The
billing code those citations name is unchanged at `fbe2409c8`, the `dev` head this revision was
rebased onto. **Every path is relative to `apps/console/`**, including `docs/stripe-prod-runbook.md`
and `scripts/stripe-setup.ts`, which exist only there. The one exception is this ADR's own folder,
`docs/adr/` at the repo root.

**Revision 2 (review of `c08eac188`).** Ten gaps were raised. Each is answered by a concrete change
below and marked **(rev 2)** where it lands: T3 now matches the post-void state and cancels only
after a proven void (G1); T11 re-reads before it alerts (G2); `subscription_id` is unique only among
open holds (G3); scope is classified by (scope, payer) (G4); the client secret leaves the server only
through a fenced gate (G5); a scheduled sweeper and webhook redelivery make every hold live (G6); a
refund is done only when Stripe says `succeeded` (G7); every outcome has copy and a carrier (G8); the
create-a-team link consults holds (G9); and the backfill has no lower bound (G10).

**Revision 3 (review of `70c5e23b7`).** Five gaps and seven advisories were raised. Each is answered
below and marked **(rev 3)**: the backfill opens a hold only on a subscription it can prove was a
checkout attempt that ended unpaid, and lists every other candidate for an operator (§8, H1); every
open state, `refund_pending` included, has a finite alert bound (I11, §5.4, H2); the link accepts an
`incomplete` subscription and defers the plan to the webhook instead of refusing it (§5.6, H3); the
copy is chosen from the hold's last observation as well as its state, so a payment that takes days
is never told "a few minutes" (§5.5, H4); and the gate covers every payable artifact a flow hands
out, not only a client secret: a Checkout URL, a trial subscription, and an earlier open Checkout
Session (I9, §4.4, H5). The advisories: §4.4 rule 3 no longer contradicts rule 1, because the
close-out is a stated exemption (rule 4); the webhook makes no Stripe call for a hold and holds no
connection for one, and `HoldDeferred` is gone, so no entitlement sync waits on a hold (§5.3); a
cancel the machine makes is stamped and sends no "subscription canceled" email (§5.3); the
reachability of each case is stated (§6); the operator release takes the payer's lease (T16); and
an adopted subscription gets its receipt (§5.3).

---

## 1. Context

### 1.1 What the flow does today (after #5489)

- **Three embedded purchase flows mint `default_incomplete` subscriptions:**
  - org plan: `createSubscriptionIntent` → `startOrgSubscription`, `app/server/actions/billing.ts:1172-1251`
  - create-a-team: `createNewOrgSubscriptionIntent` → `startNewOrgSubscription`, `billing.ts:1557-1745`
  - AI: `createAiSubscriptionIntent`, `billing.ts:1261-1315`

  Two more paths create subscriptions on the org's customer: hosted Checkout
  (`createCheckoutSession`, `billing.ts:1117-1155`) and the card-less trial (`startProTrial`,
  `billing.ts:1329-1398`).
- **The sweep.** Before minting, the org-plan and create-a-team flows list the customer's
  `status: "incomplete"` subscriptions (`cancelIncompleteSubscriptions`, `billing.ts:1066-1090`). The
  list call is `limit: 100` and ignores `has_more` (`billing.ts:1068-1072`). Each subscription is
  cancelled only when `readFirstPayment` proves it `never_paid`
  (`lib/billing/first-payment.ts:43-76`). The others are *kept*, and the purchase is refused.
- **Cancel, then prove.** `cancelNeverPaid` (`billing.ts:1022-1049`) cancels the subscription. When
  the cancel fails, it re-reads the subscription and counts only `canceled` or `incomplete_expired`
  as gone (`billing.ts:1002`, `1027-1046`). `settleCancelledSubscription` (`billing.ts:919-999`) then
  re-reads the payments (`readPaymentAfterCancel`, `first-payment.ts:99-124`) and does one of the
  following:
  - voids the invoice when no money moved (`voidPayableInvoice`, `billing.ts:860-893`);
  - refunds when money was taken (`refundTakenPayment`, `billing.ts:814-829`, with the idempotency
    key `refund-cancelled-first-payment-<pi>` at `billing.ts:820`);
  - in every other case, alerts (`alertPaymentNeedsSupport`, `lib/billing/payment-alert.ts:31-57`)
    and refuses.
- **Nothing is remembered.** The sweep lists only `incomplete`, so a subscription this flow
  cancelled is invisible to the next request. The `PaymentOutcome` docblock says so: "NOTHING HERE IS
  REMEMBERED BETWEEN REQUESTS" (`billing.ts:679-698`). Two tests pin the gap: the retry mints
  (`tests/actions/billing-subscription.test.ts:575-606` for the org plan, and `:1522-1545` for
  create-a-team).
- **Lock.** `withPurchaseLock` (`lib/billing/purchase-lock.ts:32-46`) runs
  `pg_advisory_xact_lock(hashtextextended('purchase:'+key))` in a transaction on a pooled service
  connection, with `lock_timeout = 30s` (`purchase-lock.ts:22`). The keys are `org-plan:<orgId>`
  (`billing.ts:1193`) and `new-org:<userId>` (`billing.ts:1576`). The AI flow, hosted Checkout and
  the trial take no lock. The pool is `poolMax`, default 10 (`lib/config/database.ts:20`,
  `lib/db/index.ts:22`). Nothing in the repo sets `idle_in_transaction_session_timeout`. A grep of
  `lib/db`, `lib/config` and `infra/` finds none.
- **The create-a-team record.** `pending_org_setups` (`lib/db/schema/pending-org-setups.ts:36-60`) is
  written before the client secret is returned (`billing.ts:1723-1743`). The customers of a user's
  unlinked records are reused and swept. That list is capped at 5 (`lib/billing/pending-org-setup.ts:212-230`).
- **A Stripe customer is not 1:1 with a payer (rev 2).** `ensureCustomer` stamps an org's customer
  with both `organization_id` and `created_by` (`billing.ts:660-664`). Create-a-team reuses any
  customer whose `created_by` is the caller, from the browser (`billing.ts:1651-1657`) or from a
  record (`ownedCustomer`, `billing.ts:1751-1761`), and never checks `organization_id`. Linking then
  rewrites that customer's `organization_id` to the new org (`billing.ts:1897-1900`). So one customer
  can carry `org_plan` subscriptions for two orgs.
- **The link does not read subscription status (rev 2).** `linkSubscriptionToNewOrg` retrieves the
  subscription (`billing.ts:1863`) and checks only its customer and metadata before it rewrites them
  and syncs the plan (`billing.ts:1863-1907`). `NewOrgSetupState` (`lib/billing/new-org-setup.ts:71-95`)
  carries `paid` and `linked`, and nothing about a hold.
- **Scheduled work already exists in-process (rev 2).** `instrumentation.ts:27-60` boots several
  `setInterval` loops, for example `startConnectionSweeper` (`instrumentation.ts:42-43`,
  `lib/cloud-providers/sweep.ts:204-212`, every 60s through `registerLoop`). Each has an optional
  externally-driven twin behind `ALETHIA_CRON_SECRET`
  (`app/api/internal/connections/sweep/route.ts:1-40`). The first revision's "there is no cron in the
  console" was wrong.
- **Webhook redelivery (rev 2).** The route marks an event done only when the handler returns. A
  thrown handler marks it `error` and returns 500 (`app/api/webhooks/stripe/route.ts:67-74`), and a
  later delivery of an event that is not `done` runs again (`lib/billing/webhook-events.ts:38-45`).
  **The handler runs inside one transaction that holds a per-event advisory lock**
  (`runWebhookEventExactlyOnce`, `webhook-events.ts:92-121`), so any Stripe call made from the
  handler holds a pooled connection for its duration (rev 3).
- **Every payable artifact a flow hands out (rev 3).** A client secret from `subscriptions.create`
  (org plan `billing.ts:1231-1250`, AI `:1293-1314`, create-a-team `:1704-1744`); a hosted Checkout
  URL (`createCheckoutSession`, `:1138-1154`), whose session stays payable until it expires; and a
  `trialing` subscription that is live at once and is synced before the action returns
  (`startProTrial`, `:1381-1391`, with `missing_payment_method: "cancel"` at `:1386`). Three other
  Stripe artifacts reach the browser and are **not** a second subscription: the credit-pack secret
  (`:2267-2287`, a one-off invoice, §7), the SetupIntent secret (`:2316-2333`, which saves a card and
  takes no payment), and the Customer Portal URL (`:2853-2857`, which acts on the existing
  customer). The mirrored `hosted_invoice_url` (`lib/billing/invoices.ts:91`) is written only for a
  paid invoice (`mirrorPaidInvoice`, `invoices.ts:64-70`), so it is never payable.
- **Embedded flows are card-only (rev 3).** The sheet confirms with `stripe.confirmCardPayment`
  (`components/billing/billing-checkout-form.tsx:8`, `:309`). A `processing` bank debit, and a
  subscription that goes straight to `active` (S4), reach these flows only through hosted Checkout
  (when the account enables a bank debit there, a dashboard setting outside this repo) or a payment
  confirmed outside the sheet.
- **Machine cancels leave no mark today (rev 3).** Every `subscriptions.cancel` the purchase code
  has ever made passes only an id: today at `billing.ts:1028` and `:1738`, and in every earlier
  shape in history (`git log -G'subscriptions\.cancel\('`, from `d975e9018` on). Between
  `3670dc7c7` (2026-07-04) and `28544dfbb` (2026-07-06) the org-plan flow also cancelled the org
  row's subscription whenever it was not `active` or `trialing`, `past_due` included. The other
  cancel in the console is the statutory withdrawal, which refunds a computed part of the payment
  first and then cancels (`app/server/actions/consumer-rights.ts:178-193`). The ordinary customer
  cancel is `cancel_at_period_end` (`billing.ts:2478`). The Customer Portal's cancellation mode is a
  dashboard setting; nothing in this repo fixes it.

### 1.2 What the reviews found

#5489 had five review rounds, and #5455 had its own. Between them they found a defect in every
version of a memory-less, or a written-after-the-fact, design. §6 lists all of them. They fall into
four families:

1. **Memory.** A refusal is forgotten, and the retry mints beside a payment that is still settling.
2. **Wrong object.** A hold reads `latest_invoice` and later refunds a *renewal* (blocker
   4177048230).
3. **Wrong scope.** An org-plan hold blocks the same user's create-a-team purchase and sends it down
   the wrong resume path, which refuses it permanently with false copy.
4. **Faults stacking.** A second failure, such as the hold write failing after the void failed,
   leaves no memory and no block.

### 1.3 Facts about Stripe this design relies on

The docs were read on 2026-10-04.

- **S1.** Cancelling a subscription sets `auto_advance=false` on its `open` and `draft` invoices. "You
  can still manually attempt to collect payment"
  (docs.stripe.com/billing/subscriptions/cancel, "invoices"). So a stale tab can still pay them.
  After a cancel, only the `metadata` and `cancellation_details` can be updated (same page).
- **S2.** A `void` invoice is terminal and not payable. Only an `open` or `uncollectible` invoice can
  be voided (docs.stripe.com/invoicing/overview, "Void invoices").
- **S3.** "Voided invoices don't affect subscription status"
  (docs.stripe.com/billing/subscriptions/overview). Voiding the first invoice of an `incomplete`
  subscription leaves it `incomplete` until it expires after about 23h, when Stripe itself voids the
  invoice.
- **S4.** A subscription paid with a delayed-notification method (ACH Direct Debit) "can move directly
  to `active` after creation and bypass `incomplete`. If the payment fails later, Stripe voids the
  invoice but the subscription remains `active`" (same page). **So `active` does not prove that a
  first payment was taken**, and the `incomplete`-only sweep never sees such a subscription.
- **S5.** A PaymentIntent that fails returns to `requires_payment_method`. It can then be confirmed
  again from any page that holds its client secret.
- **S6.** An idempotency key replays the first saved result, a failure included, for 24h.
  `refundTakenPayment`'s own docblock already says this (`billing.ts:806-813`).
- **S7 (unverified; a §8 step 2 task, rev 3).** Stripe is said to refuse to void an invoice while its payment is
  `processing`. The reviewers stated it, and I found no doc that says it. **The design does not
  depend on it.** Every void is followed by a payment re-read.
- **S8 (rev 2, reviewer-stated, not re-read).** Voiding an invoice cancels its PaymentIntent, so
  after a void the payments read `canceled` (`pay = failed`), not `awaiting`. **The design does not
  depend on which one is read:** T3 and T3v treat `awaiting` and `failed` alike.
- **S9 (rev 2, reviewer-stated, not re-read).** A refund on a bank debit starts `pending` and can
  later become `failed` (for example, a closed account), while the charge's `amount_refunded` already
  counts it. **The design reads each refund's `status`**, and only `succeeded` counts (§3.5).
- **S10 (rev 2, not re-read).** Stripe retries a webhook delivery that did not get a 2xx, with
  backoff, for a bounded period. **Liveness does not depend on it**: the scheduled sweeper (§5.4)
  is the backstop, and redelivery only makes the webhook path faster.

The following were read from the type definitions of the `stripe` SDK this repo pins (22.6.1,
`esm/resources/…` in the package) on 2026-10-04 (rev 3):

- **S11.** A subscription's `canceled_at` is the time of the cancellation; "if the subscription was
  canceled with `cancel_at_period_end`, `canceled_at` will reflect the time of the most recent
  update request, not the end of the subscription period". `ended_at` is "the date the
  subscription ended" (`Subscriptions.d.ts:137-139`, `:189-191`). **So the backfill compares a
  payment with `ended_at`, never `canceled_at`** (§8).
- **S12.** `cancellation_details.reason` is one of `cancellation_requested`, `payment_failed`,
  `payment_disputed`, `canceled_by_retention_policy` (`Subscriptions.d.ts:570`).
  `subscriptions.cancel` accepts `cancellation_details.comment` (`Subscriptions.d.ts:2709`, `:2728`),
  and the subscription returns it (`:364`). The design stamps every cancel it makes with it (§5.3).
- **S13.** An invoice has `billing_reason` (`subscription_create` for a subscription's first
  invoice, `Invoices.d.ts:474`) and `status_transitions.paid_at` (`Invoices.d.ts:740-743`).
- **S14.** A Checkout Session's `expires_at` can be set from 30 minutes to 24 hours after creation
  and defaults to 24 hours (`Checkout/Sessions.d.ts:2225-2227`). `checkout.sessions.list` filters on
  `customer` and `status` (`:5074` on), and `checkout.sessions.expire` exists (`:42`). That only an
  `open` session can be expired, and that an expired one cannot be completed, is from Stripe's
  docs as reviewers stated them, **not re-read**. The design re-reads the session after every
  expire, so it does not depend on either.
- **S15 (reviewer-stated, not re-read).** An uncaptured card authorisation (`requires_capture`) is
  released by Stripe after about 7 days. The design never waits on it (T7 cancels it when the
  subscription is ended), and the copy for it promises nothing shorter (§5.5).

---

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **Purchase scope** | The product a flow sells, and so the subscriptions it may sweep and the holds it reads: `org_plan`, `new_org`, `ai`. |
| **Payer key** | Who pays for a scope. `org_plan` and `ai` use the org id. `new_org` uses the user id, because there is no org yet. |
| **Classification (rev 2)** | The `(scope, payer_key)` a subscription belongs to, read from **its own metadata** (§4.2). A flow sweeps, live-checks and holds only subscriptions whose classification equals its own. A shared customer is never evidence. |
| **Payment hold** | A row saying that one subscription, which a purchase flow touched, is not yet proven settled. While it is open, it blocks minting in its `(scope, payer_key)`. |
| **Held invoice** | The invoice the hold was opened on: `latest_invoice` at the moment of the write-ahead. **This is the only invoice a hold ever reads, voids or refunds.** |
| **Settled** | The held invoice is `void`, or is `paid` and fully refunded. Or the subscription became a live purchase that the product now owns (adopted). |
| **Live subscription** | Stripe status `active`, `trialing`, `past_due`, `unpaid` or `paused`. A purchase in the same scope must never mint beside one. |

`PAID_SUBSCRIPTION_STATUSES` (`lib/billing/new-org-setup.ts:96-100`) is `active`, `trialing` and
`past_due`. **Live** is deliberately wider: an `unpaid` or `paused` subscription still exists and can
come back.

---

## 3. The state machine

### 3.1 States

| State | Meaning | Blocks its scope? |
|---|---|---|
| `closing` | Written **before** the void and the cancel (write-ahead). The flow means to make this subscription unpayable, and has not yet proven that it has. | yes |
| `cancel_unproven` | The void or the cancel failed, and a re-read did not prove it done (rev 2: a failed void now lands here too, with no cancel attempted). The subscription may still be `incomplete`, and its invoice may be payable. T3 or T3v retries on every observe. | yes |
| `payment_in_flight` | The subscription is ended, but a PaymentIntent on the held invoice is `processing` or `requires_capture`. | yes |
| `invoice_payable` | The subscription is ended and no money was taken, but the held invoice is not proven unpayable: a failed void, or a `draft` not yet deleted. | yes |
| `refund_due` | A PaymentIntent on the held invoice `succeeded` after our cancel, and no refund covering it is created and alive (every refund on it is absent, `failed` or `canceled`). | yes |
| `refund_pending` (rev 2) | Refunds covering every succeeded PaymentIntent exist, and at least one of them is `pending` or `requires_action`, not yet `succeeded`. | **no** (see below, Q10) |
| `needs_operator` | The machine cannot settle this hold. Only an operator can release it. | yes |
| `released` | Terminal for this row. It is kept for audit, with `release_reason`. A later E0 on the same subscription writes a **new** row (§4.1). | no |

**Why `refund_pending` does not block (rev 2).** The block exists to stop a *second payment for the
same product* while an earlier one may still land. In `refund_pending` the earlier payment has
landed and is on its way back; a new purchase is the one the customer now wants, and blocking it for
the days a bank refund takes punishes them for our cancel. The risk it leaves is a refund that later
**fails**: the hold then returns to `refund_due` (T10f) and the machine refunds again, or an operator
does (T14). The customer is never left with two payments and no live process to return one. Q10 asks
the maintainer to confirm. **Not blocking is not the same as not watched (rev 3):** a refund that
neither succeeds nor fails, for example one left in `requires_action`, would otherwise be observed
every hour indefinitely with nobody told. I11 gives `refund_pending` its own alert bounds (§5.4).

Every open state sets a non-null `next_check_at` when it is entered (rev 2), so the sweeper (§5.4)
reaches every open hold: `closing` and `cancel_unproven` 5m, `invoice_payable` 15m,
`payment_in_flight` 1h, `refund_due` the §3.5 backoff, `refund_pending` 1h, `needs_operator` 24h
(observe only). Every state entry also writes `state_since` (rev 3), and every successful
observation writes `last_pay` (the `pay` component of O) and, for `refund_pending`,
`refund_action_since` (the earliest time a covering refund was seen in `requires_action`, null when
none is). The age alerts (I11) and the copy (§5.5) read those three columns.

`release_reason` is one of the following:

| Reason | When |
|---|---|
| `voided_unpaid` | The held invoice is void and no PaymentIntent on it succeeded. |
| `deleted_draft` | The held invoice was a draft and was deleted. |
| `refunded` | Refunded in full by this machine, and every refund that covers it reads `succeeded` (rev 2). |
| `already_refunded` | Stripe reports refunds this hold did not create, and they cover the charge and read `succeeded` (rev 2). |
| `adopted` | The subscription went live while it was still ours to keep. Only `closing` and `cancel_unproven` can reach this, because an ended subscription never goes live. |
| `expired_unpaid` | `incomplete_expired`, with the held invoice void or unpaid. |
| `operator` | An operator released it. |

A failed **observation** (a Stripe read error) is **not** an event. It never moves a hold. It only
writes `attempts`, `last_error` and `next_check_at`.

### 3.2 Events

| Event | Raised by |
|---|---|
| **E0 `open`** | The purchase flow, under the lock, just before it voids or cancels a swept or prior subscription. |
| **E1 `observe`** | `advanceHold(hold)` reads the subscription, the held invoice, that invoice's payments (each PaymentIntent), and their refunds. It classifies the result as the observation **O** below. Callers, **each holding the payer's lease** (rev 2): (a) a purchase in the hold's scope, for **every** open hold in the scope, and the create-a-team link for a hold on its subscription (§5.6, rev 3); (b) the scheduled sweeper, for every hold whose `next_check_at <= now()` (§5.4), which the webhook brings forward by writing `next_check_at = now()` and waking it (§5.3, rev 3: the webhook itself no longer runs `advanceHold`); (c) the operator's `show` and `reconcile` (§5.4). |
| **E2 `operator_release`** | The audited operator command (§5.4). |

**O** is a tuple. Each component is read from Stripe in this request. The reads are sequential, not
atomic, and run in this order (rev 2): subscription, **invoice, then payments**, then refunds. A
payment that lands between two reads therefore shows up in the later payments read, not only in the
invoice. The order narrows the read race; it does not close it, so T11 also re-reads (rev 2).

- `sub`: `incomplete` · `ended` (`canceled` or `incomplete_expired`) · `live` · `missing`
- `inv`: `open` · `uncollectible` · `draft` · `void` · `paid` · `none`
- `pay`: one of the following:
  - `awaiting`: every PaymentIntent is `requires_payment_method`, `requires_confirmation` or `requires_action`, or there is no payment at all
  - `failed`: a PaymentIntent is `canceled`, and none is in flight or succeeded
  - `in_flight(pi)`: `processing`
  - `capturable(pi)`: `requires_capture`
  - `succeeded(pis)`
  - `unrecognised`: a payment that is not a PaymentIntent, or the payment list has `has_more`
- `refund` (rev 2), for each succeeded PaymentIntent, from `refunds.list({ payment_intent })`:
  - `none`: no refund, or every refund is `failed` or `canceled`
  - `pending`: refunds that are not `failed` or `canceled` cover `amount_received`, and at least one
    is `pending` or `requires_action`
  - `done`: refunds with `status = succeeded` alone cover `amount_received`
  - `partial`: anything else (live refunds that do not cover the amount)

  `amount_refunded` is **not** read as proof. It counts a refund from the moment it is created (S9).

When the first `observe` of `closing` finds the subscription `incomplete` with `pay = awaiting`, it is
the normal path. The flow then **voids first, then cancels** (§3.4).

### 3.3 Transition table

The rows are evaluated top to bottom, and the first match wins. "→ act" means `advanceHold` performs
the Stripe write, then observes again in the same call, up to a bound of 3 steps per call.

| # | From | Observation / event | Action | To |
|---|---|---|---|---|
| T0 | — | E0 `open`, and the row is written | — | `closing` |
| T0f | — | E0 `open`, and the **write fails** | Nothing is voided or cancelled. The purchase is refused (`UNCONFIRMED`, with no promise of a block). The subscription is still `incomplete`, so Stripe remembers it and the next sweep finds it. | (no row) |
| T0h (rev 3) | — | E0 `open`, and the insert conflicts with an **open** hold on the same subscription (the partial unique index, §4.1). This happens when a subscription changed classification after its hold was opened, for example a `new_org` subscription linked while T4-shaped (§5.6) and then swept as `org_plan`. | No new row, and nothing is voided or cancelled. The flow refuses with that hold's clause (§5.5). It does not advance the hold, whose lease is another payer's; the sweeper does (§5.4). | (the existing row) |
| T1 | any open state | `sub = missing` (`resource_missing`) | alert | `needs_operator` |
| T2 | `closing`, `cancel_unproven` | `sub = live` | none. The flow treats it as a live purchase (§4.3). | `released(adopted)` |
| T3 (rev 2) | `closing`, `cancel_unproven` | `sub = incomplete`, `pay ∈ {awaiting, failed}`, `inv ∈ {open, uncollectible}` | → act: **void the held invoice**, then **re-read it**. **Only when the re-read shows `inv = void`** does the same call go on to cancel (T3v). A void that throws, or a re-read showing anything but `void` (for example `paid`, because the payment just landed), **makes no `subscriptions.cancel` call** and goes to T3a. | the next observe decides |
| T3v (rev 2) | `closing`, `cancel_unproven` | `sub = incomplete`, `inv = void`, `pay ∈ {awaiting, failed}` | → act: **cancel the subscription**, stamped `cancellation_details.comment = "alethia:checkout_closed:<hold id>"` (rev 3, S12, §5.3), then re-read it. This is the row a hold reaches after a void that succeeded and a cancel that did not (S8: the void cancels the PaymentIntent, so `pay` reads `failed`). A crash between the void and the cancel lands here too. | `ended` → the next observe (T9, `released(voided_unpaid)`); a cancel failure → `cancel_unproven`, which matches T3v again on the next observe |
| T3a | `closing` | `sub = incomplete`, and the void or the cancel threw, or the void's re-read did not show `void` | **No alert here (rev 2, advisory 5).** Most of these are the benign case of a payment that just landed. `attempts += 1`. | `cancel_unproven` |
| T3b (rev 2) | `cancel_unproven` | T3 or T3v's act fails a **second** consecutive time (`attempts >= 2`) | alert | `cancel_unproven` |
| T4 (rev 2) | `closing`, `cancel_unproven` | `sub = incomplete`, `pay ∈ {in_flight, capturable, succeeded}` | Nothing. A payment is under way or has landed, and the subscription will go live (T2) or fall back to `failed` (T3 / T3v). | unchanged (blocks) |
| T5 | any of `closing`, `cancel_unproven`, `payment_in_flight`, `invoice_payable`, `refund_due` | `sub = ended`, `pay = succeeded(pis)`, some PaymentIntent with `refund = none` or `partial` | → act: refund the uncovered amount of each one (§3.5) | `refund_pending`, or `released(refunded)` when every refund already reads `succeeded`; on failure T13 / T14 |
| T6 | (same set as T5) | `sub = ended`, `pay = in_flight(pi)` | none | `payment_in_flight` |
| T7 | (same set as T5) | `sub = ended`, `pay = capturable(pi)` | → act: `paymentIntents.cancel(pi)` (advisory 1 #3) | the next observe decides |
| T8 | (same set as T5) | `sub = ended`, `pay ∈ {awaiting, failed}`, `inv ∈ {open, uncollectible}` | → act: void (S5: a failed PaymentIntent can be confirmed again, so the void comes **before** the release) | `released(voided_unpaid)`, or on failure `invoice_payable` |
| T8d | (same set as T5) | `sub = ended`, `inv = draft` | → act: `invoices.del` (a draft cannot be voided, S2) | `released(deleted_draft)`, or on failure `invoice_payable` |
| T9 | (same set as T5) | `sub = ended`, `inv ∈ {void, none}`, `pay ≠ succeeded`, `pay ≠ in_flight` | none | `released(voided_unpaid)`, or `released(expired_unpaid)` when the status is `incomplete_expired` |
| T10 (rev 2) | (same set as T5), `refund_pending` | `sub = ended`, every succeeded PaymentIntent has `refund = done` | none | `released(refunded)` when this hold created the refunds, else `released(already_refunded)` |
| T10p (rev 2) | (same set as T5), `refund_pending` | `sub = ended`, every succeeded PaymentIntent has `refund ∈ {pending, done}`, at least one `pending` | none. `next_check_at = now + 1h`. | `refund_pending` |
| T10f (rev 2) | `refund_pending` | some succeeded PaymentIntent reads `refund ∈ {none, partial}` again (a refund `failed` or was `canceled`) | `refund_attempt += 1`, alert once | `refund_due`, which T5 acts on with the next attempt's key (§3.5) |
| T11 (rev 2) | any open state | `pay = unrecognised` | alert, with copy per §5.5 (never "no PaymentIntent took the money") | `needs_operator` |
| T11r (rev 2) | any open state | `inv = paid` and no succeeded PaymentIntent | → act: **re-read the payments once** (R5 advisory 1, now in the observation). A `succeeded` re-read is matched against the table again (T5 when ended, T4 or T2 when not). Only a second read with no succeeded PaymentIntent alerts. | as matched, else `needs_operator` |
| T12 | `invoice_payable` | the void fails | → act: re-read the payments **once** (advisory 3 #3). `succeeded` goes to T5, `in_flight` to T6, anything else stays. | as matched |
| T13 | `refund_due` | `refunds.create` fails, and the budget is left (§3.5) | `refund_attempt += 1`, `next_check_at = now + backoff` | `refund_due` |
| T14 | `refund_due` | the refund fails and the budget is exhausted | alert | `needs_operator` |
| T15 | `needs_operator` | E1 `observe` | Observe and record only. It never auto-releases. | `needs_operator` |
| T16 | any open state | E2 `operator_release(reason)` | **Under the payer's lease (rev 3)**, taken with up to a 30s wait and refused when still busy, so a sweeper, webhook nudge or purchase that is mid-step finishes first. Then the command prints the live Stripe observation (rev 2), so an operator sees an `incomplete` subscription before releasing it, and writes `released_by`, `release_note` and an audit event with a compare-and-set on the row's `version` (§4.1). A write by any holder that read an older `version` changes nothing, so a step already in flight cannot overwrite `released`. | `released(operator)` |
| T17 | any open state | `sub` reads a status outside these rows (`unpaid`, `paused` on an ended sub, an unknown value) | alert | `needs_operator` |
| T18 | `released` | any event | none (inert). A new E0 on the same subscription opens a new row (§4.1). | `released` |

### 3.4 Why void before cancel

Today the order is cancel, read, then void (`billing.ts:1028`, then `:925`, then `:940`). Between the
cancel and the void, the subscription is `canceled` while its invoice is still payable (S1). That
window is where blockers 4176267018 and 4176778630 live.

The design voids first. Voiding an `incomplete` subscription's invoice does not end the subscription
(S3), so the cancel still follows. But a stale tab or a 3DS page loses the ability to pay at the
earliest point. A void that **succeeds** proves the invoice was not `paid` at that instant (S2). If
S7 is false and a `processing` payment survives the void, the observe after it still sees
`in_flight` (T6). So that case is handled, not assumed away.

One consequence for code that already exists: `readFirstPayment` (`first-payment.ts:65-74`) would
read an `incomplete` subscription whose invoice is `void` and whose PaymentIntent is `canceled` as
`not_proven_unpaid`, and would keep it for 23h. The design adds one rule to it: invoice `void` and no
payment succeeded or in flight means `never_paid`.

**The transition table had its own copy of that misreading (rev 2).** The first revision's T3 required
`pay = awaiting`, but a void leaves `pay = failed` (S8), so a hold whose void succeeded and whose
cancel failed fell to T4 and sat for 23h. T3 and T3v now accept `awaiting` and `failed`, and T3v is
the row that retries the cancel. The other half of that review: **a void that fails stops the
cancel.** If the void fails because the invoice is now `paid`, cancelling would end a purchase the
customer just completed in another tab, and T5 would then refund it. T3 cancels only after its
re-read shows `void`.

### 3.5 Refunds and the 24h idempotency replay (AC2, S6)

- Before every attempt, read `refunds.list({ payment_intent })` and classify it as `refund` in §3.2
  (rev 2). `done` goes to T10, `pending` to T10p, and only `none` or `partial` creates a refund, for
  the amount live refunds do not cover. **The read decides, not the key, and the read is of each
  refund's `status`, never `amount_refunded`** (S9). A refund that is created but has not succeeded
  is `refund_pending`: it does not release the hold, and it does not produce the "refunded in full"
  clause (§5.5).
- A refund that later fails or is cancelled is seen two ways: the sweeper observes `refund_pending`
  every hour (§3.1), and the webhook handles `charge.refund.updated` for a PaymentIntent that has an
  open hold (§5.3). Either one fires T10f, which returns the hold to `refund_due` with the next
  attempt number. `requires_action` (the refund needs the customer's details) counts as `pending`.
  **Rev 3:** the first revision said the 72h age alert reached a refund left there, but that alert
  covered blocking states only, and `refund_pending` does not block. Now `refund_pending` has its
  own two bounds (I11, §5.4): a covering refund in `requires_action` for 24h alerts, because only
  support can reach the customer for the details, and any `refund_pending` hold older than 14 days
  alerts. Neither moves the hold: a refund that is still alive is not retried, because a second
  refund beside a live one could over-refund.
- The key is `hold-refund-<pi>-<refund_attempt>`. The attempt number goes into the key so that a retry
  after a *failed* attempt is not replayed as the same failure for 24h. A double refund is
  impossible: a full refund of an already refunded charge is refused by Stripe
  (`charge_already_refunded`), and that already maps to `already_refunded` at `billing.ts:824-826`.
  The read above runs first anyway. After a *failed* refund the charge is not refunded, so the new
  attempt's full refund is accepted, and the failed one no longer covers anything.
- The budget is 5 attempts with exponential backoff (5m, 30m, 2h, 6h, 24h), then T14. Q4 asks the
  maintainer for these numbers.

### 3.6 Invariants

Each invariant is tested (§6).

- **I1, mint gate.** A purchase in `(scope, payer)` calls `subscriptions.create` only when, under the
  payer's lease, and **in this order** (rev 2, advisory 3): (a) every hold in `(scope, payer)` is
  `released` or `refund_pending` after one `advanceHold` pass; (a′, rev 3, `org_plan` only) every
  `open` Checkout Session classified `(org_plan, payer)` on the payer's customers was expired and
  re-read as not `open` (§4.4, "Earlier artifacts"); (b) the sweep of the `incomplete`
  subscriptions **classified** `(scope, payer)` (§4.2), paged in full, left none open; and (c) a list
  read **after** (a) and (b) finds no live subscription classified `(scope, payer)` on any customer
  the payer uses (§4.3). Reading (c) last means a subscription that went live during (a), and was
  adopted, is still seen by (c).
- **I2, held invoice only.** `advanceHold` reads, voids, deletes and refunds only `hold.invoice_id`,
  never `sub.latest_invoice`. A renewal invoice can never be refunded by a hold.
- **I3, refund preconditions.** A refund requires all of the following: the PaymentIntent is on the
  held invoice, its status is `succeeded`, and the subscription reads `ended` in the same observation.
  `adopted` holds never refund.
- **I4, write-ahead.** No code path voids or cancels a subscription in a purchase flow unless an open
  hold row for it was committed first. With this, *two faults in a row* (AC6) cannot leave an ended
  subscription without memory: the second fault happens with the row already written.
- **I5, failures don't move state.** A Stripe or DB failure during `observe` never transitions a hold
  and never mints.
- **I6, release is the only exit.** Rows are never deleted. A released row blocks nothing and is
  never acted on again. At most one **open** row exists per subscription (rev 2, §4.1); a released
  row never stops a new one from being opened.
- **I7, scope and payer isolation.** A flow reads only holds of its own `(scope, payer_key)`. It
  sweeps, live-checks and routes to resume logic only for subscriptions classified to its own
  `(scope, payer_key)` (rev 2, §4.2). A subscription on the same customer that is classified to a
  different payer is never voided, cancelled, held or counted, and is alerted on (§4.2).
- **I8, copy is true.** Every customer message is derived from the set of hold states and outcomes in
  this request, per §5.5. It claims an alert only when `alertPaymentNeedsSupport` returned true
  (`payment-alert.ts:27-30`). It claims a block only for states that block. It says "refunded" only
  for a refund that reads `succeeded` (rev 2). Every reachable outcome has a clause, and every
  response shape that can carry one has a `notice` field (rev 2, §5.5).
- **I9, the artifact gate (rev 2, widened in rev 3).** No flow hands out a **payable artifact**, or
  syncs a live subscription to the org row, until a fenced compare-and-set on the lease, made
  **after** the Stripe call that created the artifact returned, succeeds (§4.4). The artifacts are
  every one §1.1 lists: a client secret (three flows), a Checkout Session URL, and a `trialing`
  subscription. A Stripe write cannot be fenced, so the fence is on the things a customer can pay
  with or already holds. A failed gate closes the artifact before anything is returned (§4.4 rule 4).
  Together with I1 (a′) and (b), **at most one payable artifact exists per `(scope, payer)` at a
  time**: an earlier secret's subscription is swept, an earlier Checkout Session is expired.
- **I10, liveness (rev 2).** Every open hold has a non-null `next_check_at`, and a scheduled sweeper
  observes every hold whose `next_check_at` has passed (§5.4). No hold depends on a purchase or a
  webhook delivery to move again.
- **I11, every open hold is watched (rev 3).** Every open state, blocking or not, has a finite age
  bound after which the sweeper alerts an operator once per state entry (§5.4). There is no open
  state, and no observation shape inside one, that the sweeper can observe indefinitely without an
  operator being told.
- **I12, a hold's scope is fixed (rev 3).** `scope` and `payer_key` are written at E0 and never
  change, whatever the subscription's metadata becomes later (a `new_org` subscription linked to an
  org is `org_plan` from then on, §4.2). The hold keeps blocking the scope it was opened in, and a
  second flow that meets the same subscription gets T0h, not a second row.

---

## 4. Where each piece of state lives

### 4.1 The `payment_holds` table

The table is new, service-role only, with RLS enabled and no app policy, like the shape in
`04dee418c`. It has these columns, with the changes from `04dee418c` noted:

- `id`
- `subscription_id`: **unique among open rows only** (rev 2): `CREATE UNIQUE INDEX … ON
  payment_holds (subscription_id) WHERE state <> 'released'`. A plain unique constraint would turn
  an operator release of a hold whose subscription is still `incomplete` into a 23h dead end: the
  next sweep reads it `never_paid`, raises E0, and the insert fails as T0f on every purchase until
  Stripe expires it. With the partial index, E0 inserts a new row, and the released row stays as
  history.
- `customer_id`
- `scope`: `org_plan | new_org | ai`. **New.** It replaces the cross-flow lookup by `user_id`.
- `payer_key`: the org id or the user id. **New**, NOT NULL. Index on `(scope, payer_key) WHERE state <> 'released'`.
- `invoice_id`: **new**, the held invoice (I2)
- `payment_intent_id`: nullable
- `state`
- `release_reason`, `released_at`, `released_by` (a user id, or null for the system), `release_note`
- `refund_attempt`: int, default 0
- `attempts`, `last_error`, `next_check_at`, `alerted_at`
- `notice_last_sent_at` (rev 2, was `customer_notified_at`): when a response last **carried** this
  hold's clause. It never means "delivered" (§5.5).
- `opened_by_user_id`
- `opened_by`: `purchase | backfill` (rev 3), and `open_note`: for a backfill row, the evidence
  the listing matched (§8), so an operator can see why it was opened.
- `state_since`, `last_pay`, `refund_action_since`, `age_alerted_at` (rev 3): what I11's age alerts
  and §5.5's clause choice read (§3.1). `age_alerted_at` is cleared on every state change, so each
  state entry can alert once.
- `receipt_owed_invoice_id`, `receipt_sent_at` (rev 3): a receipt the webhook held back for a
  subscription that was not yet live, sent once on adoption (§5.3 (2)).
- `version` (rev 3): an integer bumped by every write. Every update is
  `… WHERE id = $1 AND version = $2`, in addition to the lease's `holder` fence, so a write made on
  an older read changes nothing (T16).
- `created_at`, `updated_at`

There is no FK to `organization` on `payer_key`. A hold is about money and outlives the org.
`04dee418c` used `set null` for the same reason.

**Why the database and not Stripe metadata.** S1 allows metadata writes after a cancel, so a
`alethia_hold_*` stamp on the subscription was a real option. It was rejected for four reasons:

1. Discovering a hold would need `subscriptions.list({ status: "canceled" })` paged per customer, for
   every purchase. The search API lags, which is #5455 blocker 4174185555.
2. An operator release needs audit fields.
3. Scope and payer queries would be scans.
4. The write-ahead (I4) is just as atomic in Postgres, and Postgres is where the lock already lives.

### 4.2 Scope: which subscriptions belong to which flow

A subscription is classified to a `(scope, payer_key)` from **its own metadata** (rev 2: the payer
is part of the classification, not only the scope):

| Scope | Metadata | Payer key | Source |
|---|---|---|---|
| `ai` | `product_type = "ai_subscription"` | `metadata.organization_id` | `billing.ts:1302` |
| `org_plan` | `organization_id` set, no `product_type` | `metadata.organization_id` | `billing.ts:1238`, `:1143`, `:1387` |
| `new_org` | `created_by` set, no `organization_id` | `metadata.created_by` | `billing.ts:1711`. It becomes `org_plan` for the new org once it is linked (`billing.ts:1901-1903`). |

A subscription with none of these shapes is **unclassified**. It is never swept or held, and it is
alerted on as below.

**Checkout Sessions (rev 3).** Today a session carries the org only inside `subscription_data`
(`billing.ts:1142-1143`), which a session list does not filter on. `createCheckoutSession` also
writes the session's own `metadata.organization_id`, and a `mode: "subscription"` session with it is
classified `(org_plan, organization_id)`. A session without it was created before this release, and
it is unclassified: it is left alone, and the §7 detector covers it until it expires, at most 24h
after it was created (S14).

The sweep and the live check filter on the full classification. Today the org-plan sweep cancels and
keeps the AI flow's `incomplete` subscriptions as well (`billing.ts:1068-1072` lists every
`incomplete` one on the customer). That is AC11.

**Why the payer, not only the scope (rev 2).** A Stripe customer is not 1:1 with a payer (§1.1). An
org's customer carries `created_by` (`billing.ts:660-664`), create-a-team reuses any customer whose
`created_by` is the caller without checking `organization_id` (`billing.ts:1651-1657`, `:1751-1761`),
and the link rewrites the customer's `organization_id` (`billing.ts:1897-1900`). So customer C can
hold an `org_plan` subscription for O and another for O2. Filtering on scope alone, O2's live check
refused on O's plan with false copy, and O2's sweep voided and cancelled O's `incomplete` plan under
lease `org:O2`, while O's purchase ran under `org:O`. Two changes close it:

1. **Classification by `(scope, payer)`** (I7). On a shared customer, a subscription classified to a
   different payer is left alone: not swept, not held, not counted by the live check. It is reported
   to the operator with the subscription as the alert's subject, so the alert rule's throttle
   collapses repeats for the same one, as `alertPaymentNeedsSupport` already does
   (`lib/billing/payment-alert.ts:23-25`, `resource_id` at `:50`). Its summary must not reuse that
   function's fixed "which the purchase flow cancelled or was replacing" (`:38-40`), which would be
   false here; the alert takes its own summary. A shared customer is then visible to an operator
   rather than silently skipped. The purchase is **not** refused for it: it
   cannot double-charge this payer.
2. **No new sharing.** `ownedCustomer` and the browser-customer branch (`billing.ts:1651-1657`)
   also require that the customer has **no** `organization_id`. An org's customer is never reused for
   create-a-team. Existing shared customers are handled by (1).

A hold blocks only its own `(scope, payer_key)`. A payment settling on an AI subscription cannot
double-charge an org plan. So an AI hold does not block an org-plan purchase, and the reverse holds
too. An org-plan hold never reaches `createNewOrgSubscriptionIntent` (AC8).

### 4.3 The live check, against webhook lag (AC12)

Before minting, and after the hold pass and the sweep (I1 order), the flow lists
`subscriptions.list({ customer, status: "all" })`, fully paged, filters it to the flow's
`(scope, payer_key)` classification (§4.2, rev 2), and refuses on any **live** one. A live
subscription classified to another payer on a shared customer is not this payer's, and does not
refuse. This list is used instead of
`organization_billing.status`, which the webhook writes late. Today the flow checks only that row,
and only for `active` and `trialing` (`billing.ts:1181-1189`). So a `past_due` org plan can be
replaced by a second one, and an ACH subscription that went straight to `active` (S4) is invisible
until its webhook lands.

| Flow | What a live subscription in scope means |
|---|---|
| `org_plan` | Refuse with "This organization already has a subscription — change the plan instead." |
| `ai` | The same, for AI. |
| `new_org` | A live **unlinked** `new_org` subscription with `created_by = user` returns `kind: "resume"`, through `newOrgSetupStateFor` (`billing.ts:1961`), as the paid-prior path does at `billing.ts:1597-1604`. A live linked one is not in scope (it is `org_plan` now). |

### 4.4 The lock

**Shared keys (AC11).** There is one key per **payer**, not per flow:

- `org:<orgId>` for the org plan, AI, hosted Checkout and the trial. These share the org's Stripe
  customer and `ensureCustomer` (`billing.ts:633-677`). Two flows that run it at once on an org with
  no customer each create a customer, and the later `upsertOrgBilling` wins (`billing.ts:660-675`).
  One of the two customers is then never swept.
- `user:<userId>` for create-a-team.

Holds are still per scope (§4.2). The lock is wider than the hold because it also protects
`ensureCustomer`.

**Pool and timeout budget (the issue's "Also").** Today the lock holds 1 pooled connection in an open
transaction for the whole Stripe sequence, plus up to 30s waiting (`purchase-lock.ts:22`, `:36-45`),
while `fn` takes other connections from the same pool. With `poolMax = 10`
(`lib/config/database.ts:20`), about 10 waiters on one key starve the holder. Nothing sets the Stripe
client timeout (`lib/billing/stripe.ts:15-18`), so the SDK defaults apply.

A purchase with *h* open holds and *n* swept subscriptions makes up to about 6·(h+n)+4 Stripe calls.
At p99 that is several seconds, and unbounded when Stripe stalls.

**Recommendation (Q2):** replace the transaction-held advisory lock with a **lease row**,
`purchase_leases(key PK, holder uuid, expires_at)`. The lease is taken with
`INSERT … ON CONFLICT (key) DO UPDATE … WHERE purchase_leases.expires_at < now()`, and **no
connection is held** while Stripe is called. The lease is 120s. Every hold write checks `holder` (a
fencing token).

**The lease can expire mid-purchase, and fencing cannot stop a Stripe write (rev 2).** The 20s × 2
client timeout bounds one *step*, not the sequence of about 6·(h+n)+4 calls, so a purchase can
outlive its lease. `subscriptions.create`, `voidInvoice`, `cancel` and `refunds.create` are Stripe
writes, which no fencing token reaches. And `startOrgSubscription` writes nothing to the database
between the mint and returning the secret (`billing.ts:1231-1250`), so in the first revision no
fenced write ever rejected a stale holder. With A stalled past its lease, B could take over, mint Y
and return its secret, and then A's calls return and A mints Z and returns its secret: two payable
subscriptions. Four rules close it (rule 4 is rev 3):

1. **Renew before every Stripe write.** Before each Stripe write, the holder runs
   `UPDATE purchase_leases SET expires_at = now() + 120s WHERE key = $1 AND holder = $2`. Zero rows
   means the lease is lost: the holder stops, makes no further Stripe write, and refuses with
   `PURCHASE_IN_PROGRESS`. This bounds what a stale holder can do to one in-flight call.
2. **A mint deadline.** `subscriptions.create` is called only when the renewal just made leaves more
   than the mint's worst case (2 × 20s) plus a 10s margin. It always does right after a renewal; the
   rule exists so that no later change can put a slow step between the renewal and the mint.
3. **The artifact gate (I9, widened in rev 3).** After the Stripe call that creates a payable
   artifact returns, and before the artifact leaves the server or is synced, the holder runs the
   same fenced renewal. **Only a renewal that returns a row lets the artifact out.** The gate sits
   at one point per flow:

   | Flow | Artifact | The gate runs after | and before |
   |---|---|---|---|
   | `createSubscriptionIntent`, `createAiSubscriptionIntent` | client secret | `subscriptions.create` (`billing.ts:1231`, `:1293`) | the secret is returned (`:1246-1250`, `:1310-1314`) |
   | `createNewOrgSubscriptionIntent` | client secret | `subscriptions.create` (`:1704`) | `recordPendingOrgSetup` and the return (`:1723-1744`) |
   | `createCheckoutSession` | the session URL | `checkout.sessions.create` (`:1138`), which also sets `expires_at` to creation + 30 minutes (S14), the shortest Stripe allows, so a delivered URL stays payable for as short a time as possible | `session.url` is returned (`:1153-1154`) |
   | `startProTrial` | a `trialing` subscription, live at once | `subscriptions.create` (`:1381`) | `syncSubscriptionToBilling` (`:1391`) and the trial burn (`:1394-1397`) |

   If the renewal returns no row, another holder has taken the lease and may have handed out an
   artifact of its own. The stale holder closes what it just created (rule 4) and refuses with
   `PURCHASE_IN_PROGRESS`. Its artifact never left the server, so nothing can pay it.
4. **The close-out exemption (rev 3).** Rule 1 forbids a holder that lost its lease any further
   Stripe write, and every hold write checks `holder`, so the first revision's "open E0 on Z and
   advance it" could not run as written: the E0 write would be rejected and the void would break
   rule 1. The close-out is therefore a **stated exemption**, and it is the only one. After a failed
   gate, the stale holder may make exactly the Stripe writes that close the artifact it created in
   this request, and nothing else:
   - a subscription from an embedded flow: void its first invoice, then cancel it, stamped
     `alethia:closeout` (S12);
   - a Checkout Session: `checkout.sessions.expire`;
   - a trial subscription: cancel it, stamped the same way. It took no payment (`missing_payment_method:
     "cancel"`, `billing.ts:1386`, and a trial invoice is for 0). This is the design's only cancel
     of a live subscription. Q8's "the machine never cancels a live subscription" is about a
     subscription a customer holds or has paid for; nobody was told of this one, and it was never
     synced to the org.

   It writes **no hold row** and syncs nothing. I4 (write-ahead) does not apply, because I4 exists so
   that a payment landing after the cancel is remembered, and no payment can land on an artifact
   whose payable handle never left the server. The exemption cannot harm the new holder: every
   target is an object only this request created and named, and the new holder never adopts an
   unpaid subscription of another request as its own purchase. If the new holder's sweep already
   reached Z, both close it, and a second void or cancel fails harmlessly. **If the close-out
   fails**, the artifact is still unreachable: Z stays `incomplete` with no secret anywhere and is
   swept by the next purchase in its scope (or expires after about 23h, S3); an expire that fails
   leaves a session whose URL nobody holds, which expires at its 30-minute `expires_at`; a trial
   whose cancel fails is a live subscription, so it is alerted on with the trial as the subject, and
   the §7 detector reports it too.

**Earlier artifacts (rev 3, I1 (a′)).** The gate stops a stale holder; it does not stop a payable
artifact handed out by an **earlier**, finished request from being paid beside a new one. For a
client secret, the sweep already handles that: the earlier subscription is `incomplete`, and the
sweep voids and cancels it under a hold. A Checkout Session has no subscription until it completes,
so the sweep cannot see it. So, for `org_plan`, the flow lists the `open` sessions on the payer's
customers (`checkout.sessions.list({ customer, status: "open" })`, S14) and, for each one classified
to its own `(org_plan, payer)`, expires it and re-reads it. A re-read that shows `complete` means the
customer finished it first: its subscription now exists, and the sweep (b) and the live check (c),
which run after (a′), see it. A re-read that still shows `open` refuses the purchase (`UNSETTLED`).
This is the same "close the earlier one first" rule as void-first (§3.4), applied to the other
artifact. Q11 asks the maintainer to confirm that a new purchase may expire a hosted Checkout the
customer opened earlier, rather than refuse until it expires.

A Stripe call can still complete server-side after the SDK gave up on it. Such a subscription has no
secret anywhere, and is swept by the next purchase like any other `incomplete` one. **What the design
guarantees is "at most one payable artifact per `(scope, payer)`" (I9), not "at most one
`subscriptions.create` call".** The second is not achievable without fencing Stripe, and the first is what stops a double
charge.

The idempotency key on `subscriptions.create` is `mint-<lease key>-<holder>`. It only makes the SDK's
own retry of one call safe. It is not the safety mechanism, and it differs between holders on
purpose: a shared key would replay A's subscription to B even after B's sweep had cancelled it.

If the maintainer keeps the advisory lock instead, the requirements are as follows:

- `idle_in_transaction_session_timeout` must be unset or above the worst-case purchase for the
  service role. If Postgres kills that session, **the lock is released while `fn` is still
  running**, and a second purchase can enter.
- The artifact gate still applies: after the create, a query on the lock's own transaction (for
  example `SELECT 1`) must succeed before the artifact is returned. A killed session fails it, and
  the artifact is closed as in rule 4.
- `poolMax` must be at least 2 × the number of same-key waiters expected per process.

### 4.5 Pagination (AC10)

- `subscriptions.list` is paged to the end with `starting_after`, capped at 1000 subscriptions per
  customer. **Over the cap, the flow refuses** ("could not check every earlier checkout") and alerts.
- `invoicePayments.list` and `has_more` are already fail-closed (`first-payment.ts:57`, `:111`), and
  stay as they are.
- `unlinkedPendingOrgSetupCustomers` (`pending-org-setup.ts:212-230`, `limit = 5`) moves to keyset
  pages over all of the user's unlinked records, capped at 50 customers. Over the cap, the flow
  refuses.

---

## 5. Failure handling for every external call

### 5.1 Stripe calls inside `advanceHold` and the purchase flow

Every read goes through `readTwice` (`billing.ts:836-842`). The second failure is an observation
failure (I5). Every Stripe **write** below is preceded by the fenced lease renewal (§4.4, rule 1).

| Call | On error (429, 5xx, network, other) | Never |
|---|---|---|
| `subscriptions.list` (sweep and live check) | Refuse the purchase (`UNSETTLED`). | mint |
| `subscriptions.retrieve` | `resource_missing` → T1. Anything else is an observation failure, and the hold stays. | read as "gone" |
| `invoices.retrieve` | Observation failure. | read as "void" |
| `invoicePayments.list`, `paymentIntents.retrieve` | Observation failure. | read as "unpaid" |
| `refunds.list` (rev 2) | Observation failure. | read as "refunded" |
| `invoices.voidInvoice` | Re-read the invoice once. `void` counts as done (a lost response). Otherwise, from `closing` or `cancel_unproven`, T3a **with no cancel** (rev 2). From an ended subscription, `invoice_payable` and T12. | release; cancel |
| `invoices.del` (draft) | Re-read. If the draft is gone, done. Otherwise `invoice_payable`. | release |
| `subscriptions.cancel` | Re-read. `ended` counts as done. Otherwise `cancel_unproven`, where T3v retries it (rev 2). | mint |
| `paymentIntents.cancel` (`requires_capture`) | Re-read the PaymentIntent. `canceled` counts as done. Otherwise stay `payment_in_flight`. | release |
| `refunds.create` | Re-read the refunds (§3.5). `done` means T10, `pending` means T10p (rev 2). Otherwise T13 or T14. | release |
| `subscriptions.create`, `checkout.sessions.create` | Throws. No artifact is returned. The lease is released. A successful create whose gate fails is closed by the close-out exemption (§4.4 rules 3–4, rev 3). | return an artifact, or sync a trial, without the gate |
| `checkout.sessions.list` (rev 3, I1 (a′)) | Refuse the purchase (`UNSETTLED`). | mint |
| `checkout.sessions.expire` (rev 3) | Re-read the session. Not `open` counts as done (`complete` is then seen by the sweep and the live check). Still `open`, or unreadable, refuses (`UNSETTLED`). | mint |

### 5.2 Database writes

| Write | On error |
|---|---|
| E0 hold insert | T0f: nothing is voided or cancelled, and the purchase is refused. The subscription stays `incomplete`, so Stripe keeps the memory. |
| Hold state update after a Stripe write succeeded | The Stripe write already happened, so the row is stale but **still open**. The next observe re-derives the state from Stripe. Because rows never move on stale data, the result is a delay, never a wrong release. |
| Lease acquire, or a lease renewal returning no row | Refuse with `PURCHASE_IN_PROGRESS` (`billing.ts:787-788`). After a mint, see §4.4 rule 3. |
| `recordPendingOrgSetup` after the mint | As today (`billing.ts:1728-1743`): cancel the new subscription, throw, and never hand out the secret. Rev 3: this is a close-out in the sense of §4.4 rule 4, because the secret never left the server: void, then cancel stamped `alethia:closeout`, and no hold row. A close-out that fails leaves the subscription `incomplete` with no secret, which the next sweep closes. |

### 5.3 The webhook (`lib/billing/webhook-handler.ts`)

**The webhook makes no Stripe call for a hold (rev 3).** The handler runs inside
`runWebhookEventExactlyOnce`'s transaction, which holds a pooled connection and a per-event advisory
lock until the handler returns (`webhook-events.ts:92-121`). Running `advanceHold` there, as revision
2 did, held both across up to three steps of Stripe calls, which is the cost §4.4 removes from
purchases. And revision 2's `HoldDeferred` threw the whole event back to Stripe when the lease was
busy, which also delayed that event's entitlement sync until the redelivery. Both are replaced by a
**nudge**: the handler only *reads* holds (one indexed query) and *writes* `next_check_at = now()` on
the ones the event names, in the same transaction that marks the event `done`. After the response,
the route wakes the in-process sweeper (§5.4) without awaiting it. The sweeper advances the hold
under the payer's lease, outside any transaction, with its own bounds. If this process dies first,
the next tick on any instance finds `next_check_at <= now()`. **No event is ever deferred or failed
because of a hold**, so the entitlement sync for the same event is never delayed by one.

Five changes. Two of them fix cases that today's code reaches with a hold *or* without one:

1. **No backup-card retry on a held or ended subscription's invoice.** On `invoice.payment_failed`,
   the handler calls `attemptBackupPayment` (`webhook-handler.ts:163-180`), which runs
   `invoices.pay(invoiceId, { payment_method })` with each backup card
   (`lib/billing/payment-methods.ts:67-…`). On a cancelled subscription's still-open invoice (S1), or
   on an `incomplete` first invoice that a sweep is closing, **that is us charging a checkout we
   cancelled**. The fix: skip the retry when the subscription is not live, or when an open hold names
   the invoice. Then nudge.
2. **A superseded subscription's events must not overwrite the org row, and receipts follow the
   subscription's state (rev 3).** `syncSubscriptionToBilling` (`lib/billing/sync.ts:93-160`) upserts
   `organization_billing` unconditionally on `organization_id` (`lib/billing/queries.ts:90-118`). A
   late `invoice.payment_succeeded` or `customer.subscription.deleted` for a swept subscription X
   therefore writes `status = canceled, plan = community, stripeSubscriptionId = X` over the live
   subscription Y. It also sends a receipt for X (`webhook-handler.ts:147-160`). The fix: when the
   row names a different subscription that is live, an event for an ended X writes nothing to the
   row. The receipt is decided by the subscription `subForInvoice` just retrieved from Stripe
   (`webhook-handler.ts:47-53`), not by whether a
   hold exists (revision 2 suppressed it for any held subscription, including one the same pass then
   adopted, so a customer who paid got no receipt):
   - **live**: send it, as today. This covers a subscription that a hold is about to adopt (T2).
   - **ended**: no receipt. The payment landed after our cancel and is being refunded (T5); the
     refund is what the customer is told about (§5.5, Q3).
   - **`incomplete` with an open hold** (the invoice settled a moment before the subscription
     turned `active`): no receipt now; write `receipt_owed_invoice_id`. When the hold is released
     `adopted` (T2), the sweeper sends that receipt once (`receipt_sent_at` is set with a
     compare-and-set, so two instances cannot both send it). Any other release clears it unsent.
3. **Events nudge holds.** The triggers are `invoice.payment_succeeded`, `invoice.payment_failed`,
   `customer.subscription.updated` and `customer.subscription.deleted`, each for a subscription with
   an open hold, and (rev 2) `charge.refund.updated` for a PaymentIntent with an open hold.
4. **Liveness without redelivery (rev 3, replaces rev 2's `HoldDeferred`).** The nudge commits with
   the `done` mark, so a nudged event is never lost: either both commit, or the handler threw for
   another reason, the event is not `done`, and Stripe redelivers it (S10). Redelivery is not needed
   for a hold to move: the sweeper reaches every hold whose `next_check_at` has passed (I10).
5. **A cancel the machine made sends no "subscription canceled" email (rev 3).** On
   `customer.subscription.deleted`, the handler syncs, tracks `subscription_canceled` and emails
   "subscription canceled" (`webhook-handler.ts:107-113`, `lib/email/billing-email.ts:262`). Today
   that already fires for every never-paid checkout the sweep closes, about a checkout the customer
   never completed, and the design adds cancel paths (T3v and the close-out). Every cancel the machine makes is stamped in `cancellation_details.comment`
   (`alethia:checkout_closed:<hold id>` or `alethia:closeout`, S12), and the subscription carries
   the stamp in the event itself (`Subscriptions.d.ts:364`), so the handler needs no lookup: a
   stamped deletion is synced under (2) and sends no email and no revenue event. The customer
   cancel (`cancel_at_period_end`, `billing.ts:2478`) and the withdrawal (`consumer-rights.ts:193`)
   are not stamped and keep their email.

`WEBHOOK_EVENTS` (`scripts/stripe-setup.ts:67-75`) already includes the four events in (3), and not
`charge.refund.updated`. `invoice.voided` is handled (`webhook-handler.ts:193-196`) but not
subscribed to, and the runbook lists `payment_intent.succeeded` (`docs/stripe-prod-runbook.md:33`),
which the code does not subscribe to. Q6 asks the maintainer to settle the set.

### 5.4 The sweeper and the operator commands

**The sweeper is required (rev 2, was Q5).** `startPaymentHoldSweeper()` is booted from
`instrumentation.ts` beside `startConnectionSweeper` (`instrumentation.ts:42-43`), with the same
`registerLoop` / `setInterval` shape (`lib/cloud-providers/sweep.ts:204-212`), every 5 minutes. Each
tick selects the open holds with `next_check_at <= now()`, oldest first, and for each one takes the
payer's lease with a 0s wait: a busy lease skips that hold for this tick (the holder is a purchase or
another instance's sweeper, and it will observe the hold itself), and `next_check_at` is left as it
is, so the next tick tries again. It runs on every app instance; the lease is what serialises them.
It also has the externally-driven twin the other sweepers have, a `POST` route behind
`ALETHIA_CRON_SECRET`, on the pattern of `app/api/internal/connections/sweep/route.ts:1-40`. That
route is optional and nothing has to call it.

**Wake-up (rev 3).** `wakePaymentHoldSweeper()` schedules one immediate tick in this process
(coalesced: a wake during a tick runs one more tick after it). The webhook route calls it after its
response is decided (§5.3), and it never awaits it. A tick handles at most a fixed number of holds
(50) and each hold at most 3 steps, with the Stripe client's timeout (§4.4), so a tick is bounded.

**Age alerts (rev 3, I11, replaces "72h for a blocking state").** Each tick alerts once, per hold and
per state entry (`age_alerted_at`), when a hold has been in its state longer than the bound below.
The bound reads the state **and the last observation**, because one state can hold a normal
multi-day settlement or a stuck machine. Every open state has a row; `needs_operator` alerts on
entry (T1, T11, T11r, T14, T17), so its age row exists only for an entry whose alert did not reach a
channel (`alertPaymentNeedsSupport` returned false, `payment-alert.ts:27-30`).

| State | Last observation | Alert after | Why this bound |
|---|---|---|---|
| `closing`, `cancel_unproven` | `last_pay ∈ {awaiting, failed}` (the machine is retrying a void or cancel) | 24h | T3b already alerts on the second failed act; 24h catches a retry loop that never acts. |
| `closing`, `cancel_unproven` | `last_pay = in_flight` (T4 shape) | 14 days | A bank debit can take several business days to settle; this is the longest settlement the design waits on silently. |
| `closing`, `cancel_unproven` | `last_pay = capturable` (T4 shape) | 8 days | An authorisation is released after about 7 days (S15). |
| `closing`, `cancel_unproven` | `last_pay = succeeded` (T4 shape: paid, not yet `active`) | 1h | The payment succeeded and only the invoice's settlement is outstanding (`first-payment.ts:7-10`); an hour without `active` is not a bank delay. |
| `payment_in_flight` | `in_flight` / `capturable` | 14 days / 8 days | As above. |
| `invoice_payable` | any | 24h | A void retried every 15m for a day is stuck. |
| `refund_due` | any | the §3.5 budget, then T14 alerts | Already bounded (about 32h). |
| `refund_pending` | a covering refund in `requires_action` since `refund_action_since` | 24h | Only support can reach the customer for the details the refund needs. |
| `refund_pending` | any | 14 days | A refund still neither `succeeded` nor `failed` after two weeks needs a person. |
| `needs_operator` | entry alert not delivered | 24h, then every 7 days | The state exists to reach a person. |

These numbers are part of Q4.

With the sweeper, every input that used to depend on a later purchase is driven by time:
`next_check_at` backoff (T13), the refund budget (§3.5), `refund_pending` (T10p, T10f) and the age
alerts above.

**Commands.** The script is `scripts/payment-holds.ts`. It follows the `resync-member-tuples.ts`
pattern.

- `list [--open] [--scope …] [--payer …]` and `show <sub>`: read-only. `show` prints the live Stripe
  observation next to the row.
- `reconcile [--backfill]`: runs one sweeper pass now, under the same leases. With `--backfill`, it
  first runs the unbounded backfill listing (§8) and opens a hold for each hit.
- `release <sub> --reason "<text>" --operator <userId>`: T16. It refuses when there is no reason. It
  takes the payer's lease (rev 3, waiting up to 30s, refusing if still busy), prints the live
  observation, then writes, with the `version` compare-and-set, an audit event (`billing.payment_hold.released`) with the
  before-state. It is the documented way out of `needs_operator` and of the `unpaid` or `paused` dead
  end (AC9). Releasing a hold whose subscription is still `incomplete` is allowed: the next sweep opens
  a new row for it (§4.1).

### 5.5 Customer copy

There is one message per *set*, and every clause in it is true. This covers C26, C29, C31 and C32,
and replaces "the most serious one wins" (`billing.ts:795-804`).

**A clause is chosen by the hold's state and its last observation (rev 3).** Revision 2 chose by
state alone, so a `closing` or `cancel_unproven` hold that T4 keeps because a bank debit is
`processing` said "try again in a few minutes" for days. A hold's `last_pay` (§3.1) now picks the
clause, and the same payment gets the same words whether it sits on an ended subscription
(`payment_in_flight`), on an `incomplete` one under a hold (T4 shape) or on one the sweep kept with
no hold.

| Present in this request | Clause |
|---|---|
| a payment under way: a hold in `payment_in_flight`, or in `closing` / `cancel_unproven` with `last_pay = in_flight`, or a subscription the sweep **kept** with a `processing` payment | "An earlier checkout's payment is still being processed, so nothing new was started. A bank debit can take several business days; you can try again once it settles." This replaces `PAYMENT_MAY_BE_UNDER_WAY` (`billing.ts:740-741`). It is true for as long as the payment takes (I1). |
| an authorisation: the same states with `last_pay = capturable`, or a kept subscription with a `requires_capture` payment | "An earlier checkout's payment was authorised but not completed, so nothing new was started. Your bank can show the authorisation for up to 7 days before it is released or completed; you can try again once it is." (S15) |
| `closing` / `cancel_unproven` with `last_pay = succeeded`, or a kept subscription whose payment succeeded | "An earlier checkout's payment has just gone through and is being confirmed, so nothing new was started. Try again in a few minutes." The minutes are true here: only the invoice's settlement is outstanding (§5.4's 1h bound). |
| `closing` or `cancel_unproven` with `last_pay ∈ {awaiting, failed}` or no observation yet (blocking) | "We could not confirm an earlier checkout was closed, so nothing new was started. Try again in a few minutes." True: the machine retries every 5 minutes, and 24h of failure alerts (§5.4). |
| a kept subscription with no payment, or with `has_more` (C39) | "An earlier checkout is still open and we could not confirm it is unpaid, so nothing new was started. Try again later; it closes on its own within a day." True: Stripe expires it after about 23h (S3). |
| `invoice_payable` (rev 2) | "We could not yet close an earlier checkout's invoice, so nothing new was started. Try again in a few minutes." |
| `refund_due` | "An earlier payment went through after that checkout was cancelled. Its refund has not gone through yet; nothing new can be started until it has." |
| `refund_pending` (rev 2) | "An earlier payment went through after that checkout was cancelled. We have issued its refund, and it is on its way back to you." (No "in full", no "refunded".) |
| `needs_operator` | "…contact support at <email>…", plus "we have raised an alert" **only when alerted**. |
| `released(refunded)` or `released(already_refunded)` released in the last 14 days (rev 2) | It is **appended** to any of the above, never dropped (C26): "An earlier payment was refunded in full; it can take 5–10 business days to reach you." Reached only once every covering refund reads `succeeded` (T10). |
| a held new-org setup at link or resume time (rev 2, §5.6) | The clause of that hold's state and last observation, from this table. |
| a link that succeeded on an `incomplete` subscription (rev 3, §5.6) | "Your team is ready. Its payment is still being processed, and the plan switches on as soon as the payment settles; a bank debit can take several business days. If the payment fails, the team stays on the free plan and nothing is charged." |
| T0h (rev 3) | The clause of the existing hold, by its state and last observation. |
| T0f (hold write failed) | `UNCONFIRMED` text. It promises no block and no "won't be charged twice". |

"You won't be charged twice" appears **nowhere**, including `PAYMENT_MAY_BE_UNDER_WAY`
(`billing.ts:740-741`), which says it today (C32).

**Where a clause travels when the request mints (rev 2).** A refund clause on a request that goes on
to mint had nowhere to go: `SubscriptionIntent` (`billing.ts:1157-1163`) and the create-a-team
`{ kind: "intent" }` (`billing.ts:1744`) carry no message. Both gain an optional `notice: string`,
which the checkout UI shows above the Payment Element. A refusal carries its message as it does
today.

**When `notice_last_sent_at` is written (rev 2).** It is written when a response that carries the
clause is **returned**, and it means only that. The server cannot know the browser received it, so
nothing treats it as delivery: the `released(refunded)` clause is appended to every response in that
`(scope, payer)` for 14 days after `released_at`, not "once". A lost response then costs a repeat of a
true sentence, never a lost notice. A delivery-guaranteed channel is Stripe's own refund email, or the
email in Q3.

### 5.6 The create-a-team link and resume (rev 2)

The blocker 4176267018's create-a-team half: tab 1 pays X after X was cancelled, then calls
`linkSubscriptionToNewOrg`, which links the `canceled` subscription and syncs a cancelled plan. The
customer pays and gets no team and no message. Today the link checks the customer and metadata only
(`billing.ts:1863-1872`) before it rewrites the customer and the subscription (`billing.ts:1897-1903`)
and syncs (`billing.ts:1907`). With holds, X can be ended with a hold in `payment_in_flight` or
`refund_due`, for example when ACH confirms as `processing` and the client proceeds.

- **`linkSubscriptionToNewOrg` consults holds, and refuses only an ended subscription (rev 3).**
  Revision 2 refused whenever X's status was not live. That also refused the normal case: the sheet
  calls the link right after `confirmCardPayment` resolves (`components/org/pending-paid-setup.ts:516`,
  after creating the org at `:472`), and Stripe keeps X `incomplete` until its invoice settles
  (`lib/billing/first-payment.ts:7-10`). Under revision 2 a refused X carried no `organization_id`, so
  when it went `active` the webhook's sync ignored it (`lib/billing/sync.ts:96-101`), and the team stayed on
  `community` although the customer had paid. Today's link does not read the status at all, and
  that is right for an `incomplete` X. The rule is now this. Right after the retrieve
  (`billing.ts:1863`), **under the `user:<userId>` lease** (the create-a-team key, so the link and
  that user's sweep cannot interleave), and **before any Stripe write**:

  | X, and any open hold naming X | The link does |
  |---|---|
  | X is ended (`canceled` or `incomplete_expired`) | **Refuse.** Copy: that hold's clause (§5.5), or with no hold, "This checkout was closed before its payment completed, so it was not linked to the new team." X keeps `new_org` metadata, so its hold keeps scope `new_org` and the refund still runs (I12 holds either way). |
  | an open hold in `payment_in_flight`, `invoice_payable`, `refund_due`, `refund_pending` or `needs_operator` | **Refuse** with that hold's clause. Every one of these states but `needs_operator` means X is ended; `needs_operator` waits for a person. |
  | an open hold in `closing` or `cancel_unproven` | Run `advanceHold` on it first (the link holds the lease). `released(adopted)` (T2): X is live, link as below. Still open with a T4-shaped observation (`last_pay ∈ {in_flight, capturable, succeeded}`): **link and defer**. Otherwise T3 / T3v closed X, which is now ended: refuse as in the first row. |
  | X `incomplete`, no hold | **Link and defer.** This is the ordinary state right after payment. |
  | X live | Link, as today. |

  **Link and defer** is today's link, unchanged: the customer and subscription metadata writes
  (`billing.ts:1897-1903`), then `syncSubscriptionToBilling` (`:1907`), which for a subscription
  that is not live keeps the org on `community` (`sync.ts:124-130`). What changes is that X now
  carries `organization_id`, so the webhook that reports X `active` applies the plan (it is
  ignored only without that metadata, `sync.ts:96-101`). The link returns `planPending: true`, and
  the sheet shows the §5.5 "link that succeeded on an `incomplete` subscription" clause instead of
  a paid plan. If X's payment later fails, a hold that names X voids and cancels it (with no hold,
  Stripe expires it, S3), and the team stays on `community` with nothing charged, as the clause
  says. A hold on X keeps scope
  `new_org` and payer U (I12): U's next create-a-team stays blocked while X settles, and the new
  org's own `org_plan` sweep, which now sees X, keeps it while its payment is under way and, if it
  later tries to close X, meets T0h rather than opening a second hold.
- **Reachability.** The sheet is card-only (§1.1), so a T4-shaped X at link time is mostly the
  seconds between a succeeded card payment and the invoice settling. A `processing` X at link time
  needs a payment confirmed outside the sheet. The rule does not depend on which.
- **The resume lookups report a held setup.** `NewOrgSetupState` (`lib/billing/new-org-setup.ts:71-95`)
  gains `hold: { state; notice } | null`. `resolveNewOrgSetup` (`billing.ts:2031`) and
  `findUnfinishedNewOrgSetup` (`billing.ts:2082`) fill it from the `new_org` holds of that
  subscription, and the sheet shows the notice instead of offering to resume. A held setup is never
  reported as resumable.

## 6. Every case, its transitions, and the test that proves it

Case sources:

- **5506** is the issue body or its comment.
- **AC n** is #5506 acceptance criterion n.
- **Rn** is #5489 review round n, and its advisories (R1 `bd6f7c5b0`, R2 `2f86fea6e`, R3 `7cf098978`,
  R4 `04dee418c`, R5 `5ea1bdaf1`).
- The thread ids are the #5489 inline comments.
- **P** is a #5455 thread or advisory.
- **New** marks a case found while writing this, verified in code.

Test files are within #5506's `scope:`, except where marked †, which needs the scope widened (Q7):

- `A` = `tests/actions/billing-subscription.test.ts`
- `H` = `tests/lib/billing/payment-holds.test.ts`, the pure `advanceHold` table tests with Stripe mocked
- `W` = `tests/lib/billing/webhook-holds.test.ts`
- `I` = `tests/integration/payment-holds.test.ts`, against real Postgres
- `L` = `tests/integration/payment-hold-lease.test.ts`

Every new test must fail on `857794cb9` on its assertion.

**Reachability (rev 3).** The embedded flows are card-only (§1.1). A case that needs a `processing`
bank debit, or a subscription that is `active` before it is paid (S4), is reached through hosted
Checkout or a payment confirmed outside the sheet, never through the sheet's own confirm. Those
rows say so (C1, C9, C43, C61). The tests mock Stripe, so they reach every row regardless.

| ID | Case | Source | Transitions | Test (file: what it asserts) |
|---|---|---|---|---|
| C1 | After the cancel, the PaymentIntent is `processing`, and the retry mints. If the payment succeeds, the customer has paid twice. Reached through hosted Checkout or an out-of-sheet confirm. | 5506; AC1; 4176221898 | T0, then T3, then T6. Retry: E1 on `payment_in_flight`, so I1 refuses. | A: the two-request test at `:575-606`, flipped. The retry is refused and `subscriptions.create` is not called. |
| C2 | After the cancel, the payments cannot be read, twice. | 5506 | T0, T3, then an observation failure (I5). Stays `closing`. | A: the retry is refused. H: a read failure leaves the state and `updated_at` unchanged except `attempts`. |
| C3 | After the cancel, the invoice cannot be voided, so it stays payable. | 5506; AC4; 4176267018 | With void-first: T3a to `cancel_unproven`, or on an ended subscription T8 to `invoice_payable`. | A: a void rejection, then the retry is refused. H: `invoice_payable` plus a void success gives `released(voided_unpaid)`. |
| C4 | After the cancel, the refund fails. | 5506; AC2 | T5 to `refund_due`, then T13. | A: refused. H: the second attempt uses key `-1`. |
| C5 | A payment that is not a PaymentIntent, or `paid` with no PaymentIntent. | 5506 | T11 to `needs_operator`. `paid` with no PaymentIntent goes through T11r first (rev 2, C50). | H: no refund is called and the copy has no "went through". |
| C6 | Create-a-team passes the same `priorSubscriptionId`. A `canceled` prior with a `paid` invoice is left alone and a new one is minted. | 5506 | Its hold, opened on the first request, is read by scope (I7), with no reliance on `priorSubscriptionId`. A `canceled`, `paid` prior with **no** hold is a finished purchase that was cancelled later, and is left alone. | A: the prior `canceled` with a hold in `payment_in_flight` is refused. With no hold, it mints (the regression guard). |
| C7 | A lost read-to-cancel race across retries, tabs and devices, when the browser lost `priorSubscriptionId` and `customerId`. | AC1; P adv 3 | Holds are found by `(scope, payer_key)` from the session (org id or user id), never from browser input. | A: three variants (same args, no prior, no customer). Each is refused. |
| C8 | The refund's idempotency key replays a saved failure for 24h. | AC2; R2 adv 3 | §3.5: the key carries the attempt number, and the refund read runs first. | H: attempt 0 fails, attempt 1 succeeds, giving `released(refunded)`. A refund already present gives T10 with no `refunds.create`. |
| C9 | A processing payment later succeeds: refund it, tell the customer the truth, release. Reached through hosted Checkout or an out-of-sheet confirm. | AC3 | T6, then (webhook E1) T5, then `refund_pending` (T10p), then `released(refunded)` (T10) once the refund reads `succeeded` (rev 2). Every response in the scope for 14 days carries the refund clause in `notice` (§5.5, rev 2). | W: `invoice.payment_succeeded` on a held invoice whose subscription is ended sends no receipt and nudges the hold (rev 3: the webhook calls no Stripe write); one sweeper tick then refunds. A: the next purchase mints and its `SubscriptionIntent.notice` has the refund clause; a second purchase within 14 days has it again. |
| C10 | A processing payment later fails. The PaymentIntent is back at `requires_payment_method`, so the invoice is voided before release. | AC3; 4176267018 | T6, then T8: void, then release. | H: the void is called before the state becomes `released`. A void failure gives `invoice_payable`. |
| C11 | A stale tab pays a cancelled subscription's open invoice (3DS in progress). | AC4; 4176267018; R3 verified list | Void-first (§3.4). A payment that wins the race is seen as T5. | A: `voidInvoice` is called before `subscriptions.cancel` (call order). |
| C12 | A payment lands between the read and the void, and the alert says "no PaymentIntent took the money", which is false. | AC4; R5 adv 1; 5506 comment (1) | T12: a void failure triggers a re-read, which goes to T5 (refund). The alert copy never claims "no PaymentIntent". | H: a void failure plus a re-read showing `succeeded` gives a refund. The alert summary does not match `/no PaymentIntent .* took/`. |
| C13 | The cancel fails on 429, 5xx or a network error, and the flow mints. | AC5; 4176778630 | T3a to `cancel_unproven`, which blocks. | A: kept from #5489 (the cancel rejection is refused), plus a retry that is also refused. |
| C14 | Retrieve and void errors, each mapped to a state. None maps to mint. | AC5 | §5.1 table. | H: a parameterised table over every call in §5.1 × {429, 500, ECONNRESET}. `subscriptions.create` is never called. |
| C15 | The hold write fails. Refuse, and promise no block. | AC6; R2 adv 4 | T0f. | A: the insert rejects, and `voidInvoice` and `cancel` are not called. The copy does not match `/blocked|won't be charged/`. |
| C16 | Two faults in a row (the void fails, then the write fails) lead to a second purchase. | AC6; R3 adv 2 | I4: the write is first, so the second fault is either T0f (nothing done) or a stale-but-open row (§5.2). | I: an update that fails after a successful Stripe void leaves the row open, and the next purchase is refused. |
| C17 | A held subscription later reads paid and never clears. Later, a cancel-and-resubscribe refunds a renewal. | AC7; 4177048230 | T2 to `released(adopted)`. I2 (held invoice only). I3. | H: `cancel_unproven` with the subscription `active` is `adopted`, with no refund. A: the 4177048230 replay (503 on cancel, then `active`, then `canceled` with a renewal paid) calls no `refunds.create`. |
| C18 | An org-plan hold blocks create-a-team, or routes it to `resumePaidNewOrgSetup` with the false copy "not an owner", permanently. | AC8; 4177048230 (2); R4 adv 2 | I7: scope isolation. | A: an `org_plan` hold for user U, then U's create-a-team mints. I: the scope index query returns only its scope. |
| C19 | No operator release. A hold on an `unpaid` or `paused` subscription alerts and refuses forever. | AC9; R4 adv 3 | T17 to `needs_operator`, then T16. | H: `unpaid` gives `needs_operator`. I†: `release` writes `released_by` and the audit row, and needs `--reason`. |
| C20 | `subscriptions.list({limit:100})` ignores `has_more`. | AC10; R4 adv 4 | §4.5: page fully, fail closed over the cap. | A: page 1 is clean and page 2 holds a `processing` one, so the purchase is refused. Over the cap, refused. |
| C21 | `unlinkedPendingOrgSetupCustomers` defaults to 5. | AC10; R1 adv 1 | §4.5. | I: 7 unlinked customers are all returned. Over 50, the flow refuses. |
| C22 | The AI flow shares the customer with no lock, no holds and no sweep, and the org-plan sweep cancels the AI flow's `incomplete` subscriptions. | AC11; R4 adv 5 | §4.2 scope filter. §4.4 shared `org:` key. The AI flow gains a sweep, holds and a live check. | A: the org-plan sweep leaves an AI `incomplete` alone. The AI flow refuses beside its own `processing` one. |
| C23 | Hosted Checkout (`createCheckoutSession`) takes no lock and does no sweep. Hosted and embedded at once give two subscriptions. | R3 adv 4 | It takes the `org:` lease and runs I1 (a)–(c) before creating a session. Rev 3: a session created earlier is expired by I1 (a′) before any new artifact, and the new URL passes the gate (I9). | A: an open `org_plan` hold refuses `createCheckoutSession`. A (rev 3): an earlier `open` session classified to the org is expired before the embedded flow's `subscriptions.create`; an expire whose re-read shows `open` refuses with no create. |
| C24 | An `active` subscription not yet seen because of webhook lag, and a second plan is minted. | AC12; R4 adv 1 | §4.3 live check (I1c). | A: `organization_billing` is empty, Stripe lists an `active` `org_plan`, so the flow refuses. |
| C25 | The lock holds a pooled connection inside a transaction. Pool exhaustion, and `idle_in_transaction_session_timeout`. | 5506 "Also"; R3 adv 1; R4 adv 6; R5 adv 4 | §4.4 lease row with fencing. | L: two holders. The second waits without holding a connection, and an expired lease is taken over. A stale holder's hold write is rejected (fencing). The double-mint case is C52. |
| C26 | After a refund, the copy still says "may be blocked", and mixed outcomes drop the refund notice. | R1 adv 2; R5 adv 2; 5506 comment (2) | §5.5: the refund clause is appended; a pending refund has its own clause (rev 2). | A: one swept subscription refunded and one `in_flight`. The message contains both clauses. |
| C27 | `requires_capture` after the cancel: no refund and no PaymentIntent cancel, so the authorisation holds the card until it expires. | R1 adv 3 | T7. | H: `paymentIntents.cancel` is called, then T8 voids. |
| C28 | Concurrent requests are not serialised (two tabs). | R2 adv 1 | §4.4. Holds are read under the lease. | L, and A's existing `two concurrent org purchases` case, kept. |
| C29 | `NEEDS_SUPPORT` says "went through" when that is not proven (`unrecognised`, a missing subscription). | R2 adv 2 | T1 and T11 copy, §5.5. | H: the copy for T1 and T11 does not match `/went through/`. |
| C30 | The `held.paid` branch is unreachable: a cancelled subscription never becomes active. | R2 adv 5 | T2 applies only from `closing` and `cancel_unproven`. Other states cannot read `live`. If one does, T17. | H: `payment_in_flight` with the subscription `active` gives `needs_operator`, with no refund. |
| C31 | "Our team has been alerted" is false when nothing reached a channel. | 4176778633 | I8. | A: kept from #5489. With the variable unset, the text does not match `/raised an alert/`. |
| C32 | `PAYMENT_MAY_BE_UNDER_WAY` promises "you won't be charged twice". | R5 adv 3; 5506 comment (3) | §5.5. | A: no refusal text matches `/charged twice/`. |
| C33 | A `canceled` prior whose latest invoice is `draft` is a dead end on every retry. | R5 adv 5; 5506 comment (4) | T8d: delete the draft. | H: a draft gives `invoices.del` and `released(deleted_draft)`. |
| C34 | Create-a-team: "canceled + paid + no team → refund" is re-issued through the idempotency replay and refuses for 24h. | #5489 body, "Removed" | Not reintroduced. A refund happens only from a hold (I3), with keys per attempt (§3.5). | A: a `canceled` prior with a `paid` invoice and no hold calls no `refunds.create`. |
| C35 | `priorSubscriptionId` from the browser: a paid subscription is cancelled and its record deleted. | P 4174412523 | It stays fixed (`ownNewOrgSubscription`, `billing.ts:1768-1780`). Holds open only on server-read, `created_by`-checked subscriptions. | A: kept. Plus a prior minted by another user is never held or cancelled. |
| C36 | `incomplete` is not "never paid". | P 4174573734 | T3 and T3v act only on `pay ∈ {awaiting, failed}`; T4 keeps everything else (rev 2). | A: kept (`readFirstPayment` cases). |
| C37 | Search indexing lag offers a charged customer a second purchase. | P 4174185555 | Hold discovery is a DB query by `(scope, payer_key)`. It never uses `subscriptions.search`. | H: a hold lookup makes no search call. |
| C38 | A lost `customerId` while the first payment is `processing` leads to a fresh customer and a double purchase. | P ac002 adv 5 | Holds are keyed by payer, not customer. The recorded customers are swept in full (§4.5). | A: no `customerId`, and a hold on another customer, so the flow is refused. |
| C39 | An `incomplete` subscription with zero payments, or with `has_more`, is refused until expiry, and the copy says "a minute". | P adv 4 | The sweep keeps it (T4 equivalent). The copy is the §5.5 "kept" clause (rev 2; no "minute"). | A: a zero-payment `incomplete` is refused, and the copy does not match `/a minute/`. |
| C40 | Records never dropped hide older ones, and OFFSET paging skips a row. | P adv 6; P ac002 adv 2 | Fixed by keyset paging (#5489). Unchanged here. | I: kept (`pending-org-setups.test.ts`). |
| C41 | **New.** `invoice.payment_failed` on a held or ended subscription's open invoice runs `attemptBackupPayment`, which `invoices.pay`s it with a backup card. | New: `webhook-handler.ts:163-180`, `payment-methods.ts:67-…` | §5.3 (1). | W: an ended subscription with an open invoice and a ranked backup card calls no `invoices.pay`, and the hold is nudged (`next_check_at` = now). |
| C42 | **New.** A late event for a superseded subscription X overwrites the org row of live Y with `canceled` / `community`, and emails a receipt for X. | New: `sync.ts:93-160`, `queries.ts:90-118`, `webhook-handler.ts:147-160` | §5.3 (2). | W: the row names live Y, and `invoice.payment_succeeded`(X ended) leaves the row unchanged and sends no receipt. |
| C43 | **New.** ACH: the subscription goes straight to `active` (S4), so the `incomplete`-only sweep and the row check both miss it. Reached through hosted Checkout only. | New: S4; `billing.ts:1068-1072`, `:1181-1189` | §4.3 live check. | A: Stripe lists an `active` `org_plan` with an `open`, processing invoice, so the flow refuses. |
| C44 | **New.** `createSubscriptionIntent` refuses only on `active` / `trialing`, so a `past_due` org mints a second plan. | New: `billing.ts:1182-1185` | §4.3 (live includes `past_due`, `unpaid`, `paused`). | A: a `past_due` org plan refuses. |
| C45 | **New.** `ensureCustomer` races across the org's flows: two customers, one of which is never swept. | New: `billing.ts:633-677`; the AI flow and Checkout are unlocked (`:1261-1315`, `:1117-1155`) | §4.4 shared `org:` key. | A: concurrent AI and org-plan on an org with no customer call `customers.create` once. |
| C46 | **New.** The trial (`startProTrial`) mints on the org customer outside the lock and the hold check. | New: `billing.ts:1329-1398` | It takes the `org:` lease and refuses on an open `org_plan` hold or a live `org_plan`. Rev 3: its subscription passes the gate before it is synced. | A: an open hold refuses `startProTrial`. |
| C47 | **New.** After void-first, `readFirstPayment` reads `incomplete` + `void` + a `canceled` PaymentIntent as `not_proven_unpaid`, which is a 23h dead end. | New: `first-payment.ts:61-74` and §3.4 | The §3.4 rule added to `readFirstPayment`. | new `tests/lib/billing/first-payment.test.ts`: `incomplete`, invoice `void`, PaymentIntent `canceled` gives `never_paid`. |
| C48 | **Rev 2 (review G1).** The void succeeds and the cancel 503s (or the process dies between them). Every later observe reads `incomplete`, `void`, `pay = failed` (S8), which the first revision sent to T4: blocked about 23h with "try again in a few minutes". | #5511 review | T3v matches `inv = void ∧ pay ∈ {awaiting, failed}` and retries the cancel; then T9. | H: `cancel_unproven` + `incomplete` + `void` + `failed` calls `subscriptions.cancel` and reaches `released(voided_unpaid)`. |
| C49 | **Rev 2 (review G1).** The void fails because the payment just landed (invoice `paid`), and the cancel then runs anyway: a purchase completed in another tab is cancelled and refunded. | #5511 review | T3 cancels only after its re-read shows `void`; otherwise T3a with no cancel; the next observe sees `live` (T2) or `in_flight` (T4). | H: `voidInvoice` rejects and the re-read shows `paid`: **no** `subscriptions.cancel` call, state `cancel_unproven`. |
| C50 | **Rev 2 (review G2).** A PaymentIntent succeeds between the payments read and the invoice read: `inv = paid` with no succeeded PI, so T11 sent it to `needs_operator` instead of a refund. | #5511 review; R5 adv 1 | Reads are ordered invoice then payments (§3.2), and T11r re-reads the payments once before alerting. | H: the first payments read is empty and the second shows `succeeded`: T5 runs and no alert is sent. A single-read implementation fails this test. |
| C51 | **Rev 2 (review G3).** An operator releases a `cancel_unproven` hold whose subscription is still `incomplete`; the next purchase's E0 for it hits the unique `subscription_id` and becomes T0f on every purchase for about 23h. | #5511 review | Partial unique index `WHERE state <> 'released'` (§4.1); E0 inserts a new row. | I: release → sweep → E0 inserts a second row for the same subscription; a second open row for it is refused by the index. |
| C52 | **Rev 2 (review G5).** The lease expires mid-purchase: B takes over and returns Y's secret, then A's stalled calls return and A mints Z and returns its secret. Two payable subscriptions; no fenced write ever rejected A. | #5511 review; R4 adv 6 (lease analogue) | §4.4 rules 1–4: fenced renewal before every Stripe write, a mint deadline, the artifact gate (I9), and the close-out exemption. Rev 3: A's gate fails, so A voids and cancels Z under the exemption, writes no hold row, and makes no other Stripe write. | L: expire A's lease between its pre-mint checks and `subscriptions.create`; B mints. Exactly **one** client secret is returned across A and B; A's only Stripe writes after the failed gate are `voidInvoice(Z's invoice)` and `subscriptions.cancel(Z)` stamped `alethia:closeout`; A's hold insert is never attempted. A second variant fails A's close-out: Z stays `incomplete`, and B's next purchase sweeps it. |
| C53 | **Rev 2 (review G6).** A hold in `payment_in_flight` whose ACH debit settles while another tab holds the lease, or while the webhook's `advanceHold` gets a 5xx: the webhook returned 200, nothing ran again, and the customer is never refunded. | #5511 review; AC3 | Rev 3: §5.3's nudge (`next_check_at = now()` committed with the `done` mark) and §5.4's wake-up; the required sweeper (I10). `HoldDeferred` is gone. | W: the handler calls no Stripe write for a held subscription, sets `next_check_at` to now, and returns 2xx. I: a hold with a past `next_check_at` and no purchase or webhook is advanced by one sweeper tick. |
| C54 | **Rev 2 (review G7).** A SEPA refund is created, `amount_refunded` reads full, the hold releases as `refunded` and the customer is told "refunded in full"; the refund then fails. | #5511 review | §3.2 `refund` by status; `refund_pending` (T10p); T10f back to `refund_due`; `charge.refund.updated` (§5.3). | H: a `pending` refund gives `refund_pending` and no "in full" clause; a later `failed` gives `refund_due` with `refund_attempt = 1`; only `succeeded` gives `released(refunded)`. |
| C55 | **Rev 2 (review G4).** A customer shared by orgs O and O2 (create-a-team reused O's customer, then the link rewrote its `organization_id`): O2's live check refuses on O's plan, and O2's sweep cancels O's `incomplete` plan under the wrong lease. | #5511 review; `billing.ts:660-664`, `:1651-1657`, `:1751-1761`, `:1897-1900` | §4.2: classification by `(scope, payer)` (I7), and no reuse of a customer with `organization_id`. | A: one customer with an `incomplete` and an `active` `org_plan` for O; O2's purchase calls no `voidInvoice` or `cancel` on O's, is not refused for O's `active`, and raises the foreign-payer alert. A: create-a-team does not reuse a customer that has `organization_id`. |
| C56 | **Rev 2 (review G8).** Three outcomes had no copy: `invoice_payable`, a subscription the sweep kept, and a refund clause on a request that mints (whose response shape had no message field). | #5511 review | §5.5: a clause for each, `notice` on `SubscriptionIntent` and `{ kind: "intent" }`, and `notice_last_sent_at` meaning "returned", not "delivered". | A: each blocking state and the kept outcome produce a non-empty message; a minting response with a refund in the last 14 days carries `notice`. |
| C57 | **Rev 2 (review G9, the create-a-team half of 4176267018).** Tab 1 pays X after X was ended and then calls `linkSubscriptionToNewOrg`, which links the ended subscription, rewrites it to `org_plan` and syncs a cancelled plan: a team with no plan and no message. | 4176267018; #5511 review | §5.6: the link refuses before any Stripe write when X is ended or an open hold on X is in an ended-subscription state (rev 3: no longer "not live"); the resume lookups report a held setup with its notice. | A: X `canceled` with a `refund_due` hold: the link makes no `customers.update` / `subscriptions.update` and returns the §5.5 clause. A: `findUnfinishedNewOrgSetup` returns the setup with `hold` set and not as resumable. |

| C58 | **Rev 3 (review H1).** The backfill matches a subscription the customer paid for and later cancelled, holds its latest renewal and T5 refunds it: a refund for a period the customer used (4177048230 again). | #5511 review 2 | §8: B1–B6; only a never-activated subscription whose single, first invoice was unpaid when it ended is held. Everything else is listed, not held. | I†: `reconcile --backfill` against a mocked Stripe holding (i) July–September paid, cancelled at period end, (ii) a first invoice paid after `ended_at` on a card, (iii) the same on a bank debit, (iv) a withdrawal, (v) a `past_due` subscription cancelled in July with its renewal paid later. Only (ii) gets a hold; (i), (iii), (iv) and (v) are printed in the review list; no `refunds.create` for any but (ii). |
| C59 | **Rev 3 (review H2).** A refund stays in `requires_action`: the hold sits in `refund_pending`, observed hourly forever, and no operator is told. | #5511 review 2 | I11; §5.4 age alerts: 24h in `requires_action`, 14 days in `refund_pending`. | I: a `refund_pending` hold with `refund_action_since` 25h ago alerts once on the next tick and stays `refund_pending`; a second tick does not alert again. |
| C60 | **Rev 3 (review H3).** The link refuses a paid `incomplete` X; the org is created without a plan, and the webhook ignores X because it has no `organization_id`. | #5511 review 2; `pending-paid-setup.ts:472`, `:516`; `sync.ts:96-101` | §5.6: link and defer. | A: X `incomplete` with a `processing` payment and no hold: the link writes `organization_id` to X, returns `planPending: true`, and the org row is `community`; then `customer.subscription.updated` for X `active` syncs the paid plan (W). |
| C61 | **Rev 3 (review H4).** A T4-shaped hold (`cancel_unproven`, `processing` bank debit) tells every purchase "try again in a few minutes" for days, and the 72h age alert fires on a normal settlement. Reached through hosted Checkout or an out-of-sheet confirm. | #5511 review 2 | §5.5 by `last_pay`; §5.4's 14-day bound for `in_flight`. | A: the refusal for that hold matches `/several business days/` and not `/few minutes/`. I: no age alert at 72h; one at 14 days. |
| C62 | **Rev 3 (review H5).** A stale holder's `checkout.sessions.create` returns after B handed out Y's secret, and A returns `session.url`: two subscriptions. The same with `startProTrial`, which syncs its trial over B's row. | #5511 review 2; `billing.ts:1138-1154`, `:1381-1391` | I9 widened; §4.4 rules 3–4. | L: A stalls in `checkout.sessions.create`, B mints; A returns no URL and calls `checkout.sessions.expire` on its session. L: the same with `startProTrial`: no `syncSubscriptionToBilling`, no trial burn, and `subscriptions.cancel` on A's trial. |
| C63 | **Rev 3 (advisory).** The machine's own cancels email "subscription canceled" about a checkout the customer never completed. | #5511 review 2; `webhook-handler.ts:107-113`, `billing-email.ts:262` | §5.3 (5): the stamp. | W: `customer.subscription.deleted` with `cancellation_details.comment` starting `alethia:` sends no email and no `subscription_canceled` event; an unstamped one still does. |
| C64 | **Rev 3 (advisory).** A subscription adopted by the same pass that suppressed its receipt: the customer paid and gets no receipt. | #5511 review 2 | §5.3 (2): the receipt follows the retrieved subscription; an owed receipt is sent on T2. | W: `invoice.payment_succeeded` with the subscription `active` and an open `closing` hold sends the receipt. H: `incomplete` with an open hold writes `receipt_owed_invoice_id`; T2 sends it once; two concurrent T2s send one. |
| C65 | **Rev 3 (advisory).** The operator release races an in-flight sweeper step, which overwrites `released`. | #5511 review 2 | T16 under the payer's lease, and the `version` compare-and-set. | I: a sweeper write prepared on `version` n, then a release that commits n+1: the sweeper's write changes no row, and the hold stays `released(operator)`. |
| C66 | **Rev 3 (advisory).** `advanceHold` inside the webhook's exactly-once transaction holds a pooled connection and an advisory lock across Stripe calls, and `HoldDeferred` delays the event's entitlement sync. | #5511 review 2; `webhook-events.ts:92-121` | §5.3: the nudge; no Stripe call for a hold inside the handler. | W: for an event naming an open hold, the Stripe mock records no write, and `syncSubscriptionToBilling` runs on the first delivery even when the payer's lease is held. |

That is 66 cases: 34 from #5489 and #5506, 6 from #5455, 7 found while writing revision 1, 10 from
the review of revision 1 (C48–C57), and 9 from the review of revision 2 (C58–C66). The review's
backfill findings (G10, H1) are rollout changes; H1's test is C58, and the rule lives in §8.

---

## 7. Out of scope

- **Checkout Sessions created before this release (rev 3).** Rev 3 brings open sessions into scope:
  I1 (a′) expires an earlier session classified to the same `(org_plan, payer)` before any new
  artifact (§4.4). What stays out is a session created before the release, which carries no
  session-level `organization_id` and so cannot be classified (§4.2); it expires within 24h of the
  release (S14). **A detector is in scope (rev 2, advisory 4), and covers that window:** on
  `checkout.session.completed` and `customer.subscription.created`, the webhook lists the payer's
  subscriptions classified to the same `(scope, payer)` and alerts when a second live one exists. It
  does not cancel anything (the machine never cancels a live subscription, Q8); it makes the known
  double-charge path visible within one webhook delivery.
- **AI credit packs** (`createCreditPackIntent`, `billing.ts:2233-2307`). These are one-off invoices
  with no subscription, so the sweep never touches them, and no hold is opened on them.
- **Plan changes, cancels and resumes on a live subscription** (`billing.ts:2465-2555`). These are not
  first payments.
- **Disputes and chargebacks** on a refunded payment.
- **Self-hosted or community deployments with no Stripe.** `requireHostedBilling` (`billing.ts:585-591`)
  refuses before any of this.
- **Moving `pending_org_setups` into the hold table.** They answer different questions: "where is my
  paid setup?" and "what payment is unsettled?". They stay separate, and a hold carries the
  subscription id they share.
- **Emailing the customer when a hold settles asynchronously.** This is Q3. Without it, the customer
  learns from the next purchase's `notice` (§5.5) or from Stripe's own receipt or refund email.

---

## 8. Migration and rollout

Each step is a separate PR into `dev`. A step that adds a migration rebases first (CLAUDE.md §5).

1. **The lease (§4.4).** Add `purchase_leases`, then make `withPurchaseLock`
   (`purchase-lock.ts:32-46`) a lease under the same signature, so callers do not change. Keys move
   from `org-plan:<org>` and `new-org:<user>` (`billing.ts:1193`, `:1576`) to `org:<org>` and
   `user:<user>`. Add the fenced renewal before every Stripe write, the artifact gate and the
   close-out (§4.4 rules 1–4), and give the purchase-path Stripe client a timeout. Tests: L, C25, C52.

   **Rolling deploy (rev 2, advisory 1).** During this release, old pods take
   `pg_advisory_xact_lock('purchase:org-plan:<org>')` and new pods take the `org:<org>` lease, and
   nothing excludes one from the other until the old pods drain. So for this one release the new
   code takes **both**: the lease, and the old advisory key in a transaction for the duration. The
   next step's PR removes the advisory half. (Deploying with no overlap is the alternative, and needs
   the maintainer's deploy settings; taking both needs nothing.)
2. **The table, the machine and the sweeper, behind no caller.** Add the `payment_holds` migration
   (with the partial unique index, §4.1), RLS in `programmables.sql`, the store, `advanceHold` as a
   pure transition function over an injected Stripe reader and writer, and `startPaymentHoldSweeper`
   (§5.4). With no holds written yet, the sweeper selects nothing. Also settle S7 once in Stripe test
   mode (an ACH or SEPA test PaymentIntent left `processing`, then `voidInvoice`) and record the
   answer in §1.3. Nothing is built on it: if Stripe refuses, T3 is a true conditional cancel and
   `payment_in_flight` becomes rare (rev 3, was Q1). Tests: H (every row of §3.3), I,
   and the sweeper half of C53.
3. **The webhook (§5.3), before the purchase flows (rev 2, advisory 2).** The backup-retry guard and
   the superseded-row guard fix today's code with or without holds, and the first revision's order
   left `attemptBackupPayment` running on held invoices between the purchase-flow step and this one.
   It also silences a stamped cancel (§5.3 (5)), and stamps today's two cancels (`billing.ts:1028`,
   `:1738`), which fixes the email the sweep's closed checkouts send today. The nudges and the owed receipt are inert until holds
   exist. Tests: W.
4. **The purchase flows.** In order:
   - Replace `cancelNeverPaid` and `settleCancelledSubscription` (`billing.ts:919-1049`) with open →
     advance.
   - Change `cancelIncompleteSubscriptions` (`:1066-1090`) to classification-filtered (§4.2) and
     fully paged, and stop create-a-team reusing a customer that has `organization_id`
     (`:1651-1657`, `:1751-1761`).
   - Add the live check (§4.3) to the org plan, AI and create-a-team.
   - Replace the create-a-team `canceled` arm (`:1627-1644`) with the scope's holds.
   - Add the hold check to `linkSubscriptionToNewOrg` and the resume lookups (§5.6).
   - Replace `refusalFor` (`:795-804`) with the §5.5 composer, and add `notice` to both intent shapes.
   - Flip the two gap-pinning tests (`billing-subscription.test.ts:575-606`, `:1522-1545`).

   Tests: A.
5. **The other org flows.** Bring `createAiSubscriptionIntent`, `createCheckoutSession` and
   `startProTrial` under the `org:` lease, the hold check, the live check and the artifact gate
   (I9), with the 30-minute session `expires_at` and session-level `organization_id`, add I1 (a′),
   and add the Checkout detector (§7). Tests: C22, C23, C45, C46, C62.
6. **Operator script and runbook.** Add `scripts/payment-holds.ts` (needs the scope widened). Add a
   section to `docs/stripe-prod-runbook.md` covering `list`, `show`, `release` and `reconcile`, and
   the alert rule `system.platform.payment_needs_support`. Without that rule the alert is only a
   `console.error` (`payment-alert.ts:41-43`).

**Backfill (rev 2, G10).** None is possible from our own records: the memory-less code left no record
of the subscriptions it cancelled. The first revision bounded the listing at "since 2026-10-04", and
that was too narrow twice over. The memory-less era began when the sweep first shipped, not with
#5489: `cancelIncompleteSubscriptions` arrived in `28544dfbb` (#114, 2026-07-06) and reached `main`
in `d17e76ea2` (#146) the same day, and before #5489 it cancelled never-paid subscriptions **without**
voiding their invoices, so a stale tab or a processing-then-succeeded payment could land on a
cancelled subscription from then on. And 2026-10-04 is #5489's `dev` merge, not a production deploy
date. A `main` merge is also not proof of a deploy date (the prod deploy history is not in this
repo), so the listing takes **no lower bound**: listing every ended subscription per customer is a
one-off paging cost, and a wrong lower bound silently misses money.

Before step 4 deploys, an operator runs `payment-holds reconcile --backfill` (part of step 6's script,
so step 6 lands before step 4 if the scope allows, Q7).

**What the backfill may hold (rev 3, H1).** Revision 2 opened a hold on any ended subscription whose
latest or first invoice had a succeeded payment with no succeeded refund. That matches every
subscription a customer paid for and then cancelled, and E0 holds `latest_invoice`, so T5 would
refund the last renewal: the 4177048230 defect. It also contradicted C6 and C34. The memory-less
code left no mark on what it cancelled (§1.1: every cancel passed only an id), so the discriminator
has to come from Stripe facts, and it has to prove **"a checkout attempt that ended before it was
ever paid"**, not "paid and cancelled". A subscription is opened as a hold only when **all** of the
following hold, each read from Stripe:

- **B1, ours.** It is classified to a `(scope, payer)` by its own metadata (§4.2).
- **B2, ended by a request, not by Stripe's dunning.** `canceled` with
  `cancellation_details.reason = cancellation_requested` (S12), or `incomplete_expired`. A
  `payment_failed`, `payment_disputed` or retention-policy cancel is Stripe's own lifecycle on a
  subscription that was live.
- **B3, never renewed or changed.** It has exactly **one** invoice (`invoices.list({ subscription })`,
  paged), with `billing_reason = subscription_create` (S13). A subscription that ever renewed or
  changed plan has a second invoice. That one invoice is both the first and the latest, so the
  invoice the listing checked is the invoice E0 holds (I2); revision 2's "latest or first" could
  check one and hold the other.
- **B4, unpaid when it ended.** That invoice is `open`, `uncollectible` or `draft`; or it is `paid`
  with `status_transitions.paid_at` **after** the subscription's `ended_at`; or it has a
  PaymentIntent that is `processing` or `requires_capture`. `ended_at`, not `canceled_at`: for a
  `cancel_at_period_end` cancel, `canceled_at` is the time of the request (S11), so a renewal paid
  between the request and the period end would read as "paid after cancel". A trial's first invoice
  is paid at creation and fails B4.
- **B5, a card.** Every PaymentIntent on that invoice used a card. A card subscription created
  `default_incomplete` stays `incomplete` until its first invoice is paid, so B4 then proves it was
  **never live**: the payment, if one landed, bought no period at all. That is the property a refund
  needs, and it holds whoever made the cancel. In practice the cancel was our purchase code (the
  sweep at `billing.ts:1028`, the record-failure cancel at `:1738`, or the 2026-07-04 org-row cancel,
  §1.1); the customer cancel is `cancel_at_period_end` (`billing.ts:2478`) and cannot end an
  `incomplete` subscription before Stripe expires it, and an expired one has its invoice voided (S3).
  A bank debit fails B5 on purpose: it can make a subscription `active` before it is paid (S4), so
  "unpaid when it ended" no longer proves "never live", and a customer who used such a subscription
  and then cancelled it at once (the Customer Portal's mode is a dashboard setting, §1.1) would look
  the same.
- **B6, not a withdrawal.** No `commerce_order` row names it (`stripe_subscription_id`,
  `lib/db/schema/legal.ts:180`) with state `withdrawn` or `refunded`. A withdrawal refunds a computed
  part and keeps the rest (`consumer-rights.ts:166-193`); a hold's full refund would override that.

Each hit is opened as a hold (E0, `opened_by = backfill`, `open_note` naming B1–B6's evidence) and
advanced at once, so the machine settles it (an ended subscription goes straight to T5, T6, T8 or
T9), and a hit it cannot settle reaches `needs_operator`.

**Everything else is listed, never held.** A subscription that matches revision 2's broad listing
(ended, with an open invoice, or a succeeded payment that no succeeded refund covers, or a payment
still `processing`) but fails any of B1–B6 is printed in a review list, with the failed test named,
and nothing is written for it: no hold, no void, no refund. The list includes the 2026-07-04 to
07-06 cancels of `past_due` subscriptions (§1.1), which fail B3 or B5, and bank-debit checkouts,
which fail B5. Each is an operator's call, made with `show` and, if a refund is owed, the Stripe
dashboard.

There is no lower date bound, for the reason above. Hits dated before 2026-07-06 are not expected;
the operator reads any as a sign the listing is wrong.

**After this release** every machine cancel is stamped (§5.3 (5)) and has a hold row, so no later
backfill is needed.

**Rollback.** Steps 1 to 5 are code plus two additive tables. Reverting a step leaves the rows
unused. A hold left open by a reverted build blocks nothing, because nothing reads it, and the
sweeper advances it after redeploy.

---

## 9. Open questions for the maintainer

Revision 2 removed Q5 (whether `reconcile` runs on a schedule): it is now a requirement (§5.4, I10).
Revision 3 removed Q1 (whether Stripe refuses to void while a payment is `processing`): it is a fact
to look up in test mode, not a decision, and the design is correct either way, so it is a §8 step 2
task. Every question left is a decision only the maintainer can make, or needs a resource only the
maintainer has. Each carries a recommended answer.

- **Q2.** Should the lease row replace the transaction advisory lock, or should the advisory lock
   stay with the stated `idle_in_transaction_session_timeout` and `poolMax` floor? What is the managed
   Postgres's current `idle_in_transaction_session_timeout` for the service role? It is not set in
   this repo. **Recommended:** the lease, with the artifact gate (§4.4). Both options need the gate;
   only the lease stops holding a pooled connection across Stripe calls.
- **Q3.** When a hold settles from the webhook or the sweeper (a refund succeeded, or a processing
   payment failed and was voided), should the customer get an email now, or only the `notice` at
   their next purchase? **Recommended:** an email on `released(refunded)` and on `refund_pending`'s
   first entry, because a customer who never buys again otherwise learns of the refund only from
   their bank, and `notice_last_sent_at` cannot prove delivery (§5.5). The webhook already sends no
   receipt for a payment that is being refunded (§5.3 (2)), so this email is the only word from us.
- **Q4.** The numbers: the refund budget before `needs_operator`, and the age-alert bounds of
   §5.4's table. **Recommended:** 5 attempts over about 32h (5m, 30m, 2h, 6h, 24h), and the table as
   written: 24h for a stuck retry or a refund in `requires_action`, 1h for a paid-but-not-active
   subscription, 8 days for an authorisation, 14 days for a bank debit or a pending refund.
- **Q6.** The webhook event set. Should `invoice.voided` be subscribed to, since it is handled at
   `webhook-handler.ts:193` but not listed at `scripts/stripe-setup.ts:67-75`? Should the runbook's
   `payment_intent.succeeded` (`docs/stripe-prod-runbook.md:33`) be added to the code or dropped from
   the doc? And rev 2 adds `charge.refund.updated` (§5.3), which changes the live endpoint's
   subscription, an operator action on the Stripe account. **Recommended:** add
   `charge.refund.updated` and `invoice.voided`; drop `payment_intent.succeeded` from the runbook,
   since `invoice.payment_succeeded` already carries the first payment.
- **Q7 (scope).** #5506's `scope:` does not cover the migration and schema (`lib/db/**`),
   `programmables.sql`, `instrumentation.ts` and the sweeper (rev 2), `scripts/payment-holds.ts`,
   `scripts/stripe-setup.ts` or `docs/stripe-prod-runbook.md`. Widen it, or split the steps in §8 into
   issues with their own scopes? **Recommended:** split, one issue per §8 step, chained, so each
   carries the scope it touches and step 6's script can land before step 4.
- **Q8.** Should a `released(adopted)` org-plan subscription (C17) whose org already has a different
   live plan be cancelled for the customer, or alerted on for an operator? The same question covers
   the Checkout detector (§7) and a trial whose close-out failed (§4.4 rule 4). **Recommended:**
   alert only. The machine never cancels a live subscription.
- **Q9.** Is the `org:` lease key acceptable for the AI flow, so that an org-plan purchase and an AI
   purchase in two tabs run one after the other? Or should the AI flow keep its own key and a
   separate guard on `ensureCustomer`? **Recommended:** the shared key. The cost is seconds of
   serialisation on a rare two-tab case; the alternative needs a second guard to stop the
   two-customer race (C45).
- **Q10 (rev 2).** Should `refund_pending` block the scope? **Recommended:** no (§3.1). A refund in
   flight is money going back, not a payment that may land, and a bank refund can take days. A refund
   that later fails returns the hold to `refund_due` (T10f), and the machine or an operator refunds
   again, and a refund that neither succeeds nor fails reaches an operator (I11).
- **Q11 (rev 3).** When a customer starts a purchase while a hosted Checkout Session for the same
   org plan is still `open` (another tab, or one abandoned up to 30 minutes ago), should the new
   purchase **expire** that session, or **refuse** until it expires? **Recommended:** expire it
   (§4.4, "Earlier artifacts"). It is the same rule as void-first: the newest purchase is the one
   the customer wants, and a session they finished first is seen as a subscription by the sweep and
   the live check. Refusing would block a customer for up to 30 minutes behind a tab they closed.
- **Q12 (rev 3).** The backfill's review list (§8) holds the candidates it cannot prove were never
   live: bank-debit checkouts, and the 2026-07-04 to 07-06 cancels of `past_due` subscriptions. Who
   works that list, and is a refund for one of them a support decision per case? **Recommended:**
   yes, per case, by whoever owns Stripe support, with `payment-holds show` as the evidence; the
   design writes nothing for them.
