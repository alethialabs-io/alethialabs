---
status: proposed
issue: "#5506"
date: 2026-10-04
---

# Payment holds on the first payment of a paid team setup

**Decision (proposed).** The paid create-a-team setup is the purchase that charges a card before the
organization it pays for exists. Before that flow makes an earlier first-payment subscription
unpayable (voids its invoice or cancels it), it first writes a **payment hold** row. The hold then
moves through one state machine until a Stripe read proves the subscription settled. Each hold reads
only the invoice it was opened on. While a hold is open, the same user cannot mint another
create-a-team subscription. One function, `advanceHold`, is the only code that moves a hold. Three
callers run it, each under the user's lease: the purchase flow (and the create-a-team link), a
**required** scheduled sweeper, and the operator command. The Stripe webhook only nudges the
sweeper. Only an operator command can release a hold that the machine cannot settle.

**Scope (rev 5, maintainer decision 2026-10-04).** This design covers holds on the **first payment
of the paid org-setup path** and nothing else. That means:

- the create-a-team purchase (`createNewOrgSubscriptionIntent`);
- its server-side record (`pending_org_setups`, migration `0159_ancient_lily_hollister`);
- the link (`linkSubscriptionToNewOrg`), the resume lookups, and the sheet that runs the
  post-payment steps;
- the #5489 fail-closed refuse path **as the create-a-team flow uses it**.

Renewals, plan changes, dunning, and every other purchase flow are out of scope. §7, "Not covered,
and why", lists each one with the behaviour that handles it today.

This replaces, for create-a-team, the "refuse without memory" behaviour that #5489 shipped. It is
written before any code, as #5506 requires, and the maintainer reviews it. It meets the ADR bar for
two reasons. A new table and new webhook behaviour are hard to reverse. And a write-ahead row before a
Stripe call is surprising without this context. The alternatives (Stripe metadata as the store,
holds written after the fact) were real and are recorded below.

Every claim about today's code cites `file:line` at `origin/dev` `857794cb9` (#5489 merged). The
billing code those citations name is unchanged at `7de07b4e8`, the `dev` head this revision was
checked against. `7de07b4e8` changes only `lib/billing/pending-org-setup.ts` (the slug rule, #5509),
`lib/billing/billing-field-caps.ts` and `components/org/create-org-sheet.tsx`, and no line cited here
moved. **Every path is relative to `apps/console/`**, including `docs/stripe-prod-runbook.md` and
`scripts/stripe-setup.ts`, which exist only there. The one exception is this ADR's own folder,
`docs/adr/` at the repo root.

## Revisions

- **Rev 2** (review of `c08eac188`) closed ten gaps:
  - T3 voids first and cancels only after a proven void;
  - T11 re-reads;
  - `subscription_id` is unique among open holds only;
  - classification is by payer;
  - a fenced artifact gate;
  - a required sweeper;
  - refunds by status;
  - copy for every outcome;
  - the link consults holds;
  - the backfill has no lower bound.
- **Rev 3** (review of `70c5e23b7`) closed five gaps:
  - the backfill holds only a provable never-live checkout;
  - every open state has an alert bound;
  - the link defers an `incomplete` subscription instead of refusing it;
  - copy by last observation;
  - the gate covers every artifact.

  It also answered seven advisories.
- **Rev 4** (review of `c67c284b3`) closed three gaps:
  - J1: the webhook overwrite (#5514);
  - J2: positive evidence before a release;
  - J3: hint writes vs state writes.

  Each change was marked where it landed. Revision 5 drops those marks for the text it removed
  and keeps them where the text survives.
- **Revision 5** (review of `7ded56758`, and the maintainer's decision to narrow the scope).
  The review raised five gaps. Each is re-checked under the narrowed scope:

  | Gap | Thread | Under rev 5 |
  |---|---|---|
  | **K1.** The trial's gate marker: a request that dies between the gate and the action's sync leaves a live, marked trial that nothing syncs | `PRRT_kwDOPdRG6s6o0ENN` | **Closed by the narrowing.** `startProTrial` is out of scope (§7), so the trial gate and the gate marker are removed. Today's trial behaviour is unchanged. |
  | **K2.** W2 and W4: a row whose live Y ends while an unnamed live X exists drops to `community`; an off-Stripe grant is unprotected | `PRRT_kwDOPdRG6s6o0ENR` | **Closed by the narrowing.** Every two-live state the design created came from the org-plan, Checkout or trial flows: adoption beside a live plan (Q8), the Checkout detector, a failed trial close-out. All of them are out of scope. In scope, a new org has exactly one subscription. The live check returns `resume` beside a live create-a-team subscription instead of minting (§4.3). The link now refuses an org whose row already names another subscription (§5.6). The off-Stripe-grant sequence enters through `createSubscriptionIntent` or `startProTrial`, both out of scope. |
  | **K3.** The owed receipt: the webhook's fallback needs a lease it does not hold, and a T2 run by the purchase or the link never sends the owed receipt | `PRRT_kwDOPdRG6s6o0ENV` | **Addressed.** The owed-receipt mechanism and its two columns are removed. The receipt is decided by the fresh read alone: it is sent unless the subscription is ended (§5.3 (2)). That is sound because void-first means the machine never cancels a subscription whose first invoice is paid. This also answers the advisory about an `incomplete` subscription with no hold. |
  | **K4.** #5514's "Done when" admits implementations that break W1–W5 | `PRRT_kwDOPdRG6s6o0ENY` | **Addressed within the narrowed scope.** The contract shrinks to three rules on the **one** subscription the new org's row names (N1–N3, §5.3 (2)). It was checked against #5514's PR, #5518 at `4a306a0f6`. N1 and N3 hold and are tested. N2 does **not** hold: a write with no event time skips the order check, so the link's own stale sync can drop a paid org to `community` (C76). §8 step 3 is blocked on it, and #5518 has been told. |
  | **K5.** The sheet discards what the link returns, and turns every refusal into "Retry to complete setup" | `PRRT_kwDOPdRG6s6o0ENZ` | **Addressed.** The link returns a typed result. The sheet stops **before creating the org** when the resume lookup reports a held or ended setup. A refusal is non-retryable and carries its clause. A deferred plan is shown as processing. `components/org/pending-paid-setup.ts` and `components/org/create-org-sheet.tsx` are now in §8 step 4 and Q7 (§5.6). The success half ("Subscription active" for any state) is a live defect today, with or without holds. It is fixed separately by #5522. |

  The review's two advisories:
  - The receipt rule for an `incomplete` subscription with no hold is now the same rule as for
    every other subscription (K3).
  - W1's Stripe reads inside the webhook transaction are no longer required. The narrowed
    contract needs no fresh read (§5.3 (2)), and #5518 makes none.

---

## 1. Context

### 1.1 What the create-a-team flow does today (after #5489)

- **The flow.** `createNewOrgSubscriptionIntent` → `startNewOrgSubscription`
  (`app/server/actions/billing.ts:1557-1745`) mints a `default_incomplete` subscription with
  `metadata.created_by = <user>` and no `organization_id` (`billing.ts:1704-1714`). There is no org
  yet. The sheet confirms the card, creates the org, then calls `linkSubscriptionToNewOrg`
  (`components/org/pending-paid-setup.ts:472`, `:516-525`).
- **The record.** `pending_org_setups` (`lib/db/schema/pending-org-setups.ts:36-60`, migration
  `0159_ancient_lily_hollister`) is written before the client secret is returned
  (`billing.ts:1723-1743`). The customers of a user's unlinked records are reused and swept, capped at
  5 (`lib/billing/pending-org-setup.ts:212-230`).
- **The prior.** When the browser passes `priorSubscriptionId`, the flow reads it
  (`ownNewOrgSubscription`, `billing.ts:1768-1780`). A paid prior returns `resume`
  (`:1597-1604`). An `incomplete` or `incomplete_expired` prior is cancelled or settled only when
  `readFirstPayment` proves it `never_paid` (`:1605-1626`). A `canceled` prior has its latest invoice
  voided, and a void that fails refuses (`:1627-1644`). A `canceled` prior with a **paid** invoice is
  left alone, and a new subscription is minted.
- **The sweep.** Before minting, the flow lists the `status: "incomplete"` subscriptions of every
  customer it uses (`cancelIncompleteSubscriptions`, `billing.ts:1066-1090`, called at `:1686-1693`).
  The list is `limit: 100` and ignores `has_more` (`:1068-1072`). It lists **every** incomplete
  subscription on the customer, including an org-plan or AI one when the customer is shared. Each
  is cancelled only when `readFirstPayment` proves it `never_paid` (`lib/billing/first-payment.ts:43-76`).
- **Cancel, then prove.** `cancelNeverPaid` (`billing.ts:1022-1049`) cancels, then re-reads, and counts
  only `canceled` or `incomplete_expired` as gone (`:1002`, `:1027-1046`).
  `settleCancelledSubscription` (`:919-999`) then re-reads the payments
  (`readPaymentAfterCancel`, `first-payment.ts:99-124`) and does one of the following:
  - voids when no money moved (`voidPayableInvoice`, `:860-893`);
  - refunds when money was taken (`refundTakenPayment`, `:814-829`, with the key
    `refund-cancelled-first-payment-<pi>` at `:820`);
  - otherwise alerts (`alertPaymentNeedsSupport`, `lib/billing/payment-alert.ts:31-57`) and refuses.
- **Nothing is remembered.** The sweep lists only `incomplete`, so a subscription this flow
  cancelled is invisible to the next request. The `PaymentOutcome` docblock says so (`billing.ts:679-698`).
  A test pins the gap for create-a-team: `tests/actions/billing-subscription.test.ts:1522-1545`.
- **Lock.** `withPurchaseLock` (`lib/billing/purchase-lock.ts:32-46`) runs
  `pg_advisory_xact_lock(hashtextextended('purchase:'+key))` in a transaction on a pooled service
  connection, with `lock_timeout = 30s` (`:22`). The key here is `new-org:<userId>` (`billing.ts:1576`).
  The pool is `poolMax`, default 10 (`lib/config/database.ts:20`). Nothing in the repo sets
  `idle_in_transaction_session_timeout`.
- **A Stripe customer is not 1:1 with a payer.** `ensureCustomer` stamps an org's customer with both
  `organization_id` and `created_by` (`billing.ts:660-664`). Create-a-team reuses any customer whose
  `created_by` is the caller, from the browser (`:1651-1657`) or from a record (`ownedCustomer`,
  `:1751-1761`), and never checks `organization_id`. So the create-a-team sweep can meet, and cancel,
  an existing org's `incomplete` org-plan or AI subscription. Linking rewrites the customer's
  `organization_id` to the new org (`:1897-1900`).
- **The link does not read the subscription's status.** `linkSubscriptionToNewOrg` retrieves the
  subscription (`billing.ts:1863`), checks only the customer and the metadata, rewrites both, and syncs
  (`:1863-1907`). It returns `Promise<void>` (`:1854`). It does not check whether the org's billing row
  already names another subscription.
- **The sheet discards the link's result (rev 5).** `runSteps` calls the link and ignores its value
  (`pending-paid-setup.ts:516-525`). It replaces any thrown error other than `SetupStopped` with
  "Retry to complete setup — you won't be charged again." and `retryable: true` (`:535-545`). Then it
  toasts "Subscription active — your organization is ready." **whatever the subscription's state**
  (`:558`). The org is created **before** the link (`:472`). That last line is #5522.
- **Scheduled work already exists in-process.** `instrumentation.ts:27-60` boots `setInterval` loops,
  for example `startConnectionSweeper` (`:42-43`, `lib/cloud-providers/sweep.ts:204-212`), each with an
  optional twin behind `ALETHIA_CRON_SECRET` (`app/api/internal/connections/sweep/route.ts:1-40`).
- **Webhook redelivery.** A thrown handler marks the event `error` and returns 500
  (`app/api/webhooks/stripe/route.ts:67-74`), and a later delivery of an event that is not `done`
  runs again (`lib/billing/webhook-events.ts:38-45`). The handler runs inside one transaction that
  holds a per-event advisory lock (`runWebhookEventExactlyOnce`, `webhook-events.ts:92-121`).
- **What the webhook writes for a create-a-team subscription.** `syncSubscriptionToBilling` ignores a
  subscription with no `metadata.organization_id` (`lib/billing/sync.ts:96-101`). So **before the
  link**, no event for X writes any org row. **After the link**, every X event writes the new org's
  row (`webhook-handler.ts:103-109`, `sync.ts:131-143` → `queries.ts:90-118`), as does the link's own
  sync (`billing.ts:1907`). `invoice.payment_succeeded` sends a receipt for any subscription
  invoice, whatever its status (`webhook-handler.ts:147-160`). `invoice.payment_failed` runs
  `attemptBackupPayment` (`:163-180`, `lib/billing/payment-methods.ts:67-…`) on the customer's backup
  cards. `customer.subscription.deleted` emails "subscription canceled" for any subscription
  (`:107-113`, `lib/email/billing-email.ts:262`).
- **The sheet is card-only.** It confirms with `stripe.confirmCardPayment`
  (`components/billing/billing-checkout-form.tsx:8`, `:309`). A `processing` bank debit, or a
  subscription that is `active` before it is paid (S4), reaches create-a-team only through a payment
  confirmed outside the sheet.
- **Machine cancels leave no mark today.** Every `subscriptions.cancel` the purchase code has made
  passes only an id (`billing.ts:1028`, `:1738`; `git log -G'subscriptions\.cancel\('` from
  `d975e9018` on).

### 1.2 What the reviews found

#5489 had five review rounds, and #5455 had its own. Between them they found a defect in every
version of a memory-less, or a written-after-the-fact, design. §6 lists all of them that are in
scope. They fall into four families:

1. **Memory.** A refusal is forgotten, and the retry mints beside a payment that is still settling.
2. **Wrong object.** A hold reads `latest_invoice` and later refunds a renewal (blocker 4177048230).
3. **Wrong scope.** An org-plan hold blocked a create-a-team purchase and routed it to the wrong
   resume path. In rev 5 no other flow opens holds, so this family reduces to "the create-a-team sweep
   must not touch another payer's subscription" (§4.2).
4. **Faults stacking.** A second failure (for example, the hold write fails after the void failed)
   leaves no memory and no block.

### 1.3 Facts about Stripe this design relies on

The docs were read on 2026-10-04.

- **S1.** Cancelling a subscription sets `auto_advance=false` on its `open` and `draft` invoices. "You
  can still manually attempt to collect payment" (docs.stripe.com/billing/subscriptions/cancel,
  "invoices"). So a stale tab can still pay them. After a cancel, only `metadata` and
  `cancellation_details` can be updated.
- **S2.** A `void` invoice is terminal and not payable. Only an `open` or `uncollectible` invoice can
  be voided (docs.stripe.com/invoicing/overview, "Void invoices").
- **S3.** "Voided invoices don't affect subscription status"
  (docs.stripe.com/billing/subscriptions/overview). A voided first invoice leaves the subscription
  `incomplete` until it expires after about 23h.
- **S4.** A subscription paid with a delayed-notification method "can move directly to `active` after
  creation and bypass `incomplete`" (same page). **`active` does not prove that a first payment was
  taken.**
- **S5.** A PaymentIntent that fails returns to `requires_payment_method`, and can be confirmed again
  from any page that holds its client secret.
- **S6.** An idempotency key replays the first saved result, a failure included, for 24h
  (`refundTakenPayment`'s docblock, `billing.ts:806-813`).
- **S7 (unverified; a §8 step 2 task).** Stripe is said to refuse to void an invoice while its payment
  is `processing`. **The design does not depend on it.** Every void is followed by a payment re-read.
- **S8 (reviewer-stated, not re-read).** Voiding an invoice cancels its PaymentIntent, so a void reads
  `pay = failed`. **The design does not depend on which one is read:** T3 and T3v treat `awaiting` and
  `failed` alike.
- **S9 (reviewer-stated, not re-read).** A refund on a bank debit starts `pending` and can later become
  `failed`, while `amount_refunded` already counts it. **The design reads each refund's `status`.**
- **S10 (not re-read).** Stripe retries a webhook delivery that did not get a 2xx, for a bounded period.
  **Liveness does not depend on it** (§5.4).

From the type definitions of the `stripe` SDK this repo pins (22.6.1):

- **S11.** `canceled_at` is the time of the cancel request. `ended_at` is "the date the subscription
  ended" (`Subscriptions.d.ts:137-139`, `:189-191`).
- **S12.** `cancellation_details.reason` is one of `cancellation_requested`, `payment_failed`,
  `payment_disputed`, `canceled_by_retention_policy` (`Subscriptions.d.ts:570`).
  `subscriptions.cancel` accepts `cancellation_details.comment` (`:2709`, `:2728`), and the
  subscription returns it (`:364`).
- **S13.** An invoice has `billing_reason` (`subscription_create` for the first invoice,
  `Invoices.d.ts:474`) and `status_transitions.paid_at` (`:740-743`).
- **S15 (reviewer-stated, not re-read).** An uncaptured authorisation (`requires_capture`) is released
  after about 7 days.

---

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **Create-a-team subscription** | A subscription whose own metadata has `created_by` and no `organization_id` (`billing.ts:1711`). It becomes an ordinary org subscription once the link writes `organization_id` (`:1901-1903`). |
| **Payer** | The user id. There is no org yet, so the user pays. |
| **Classification** | A subscription belongs to user U's create-a-team flow when **its own metadata** has `created_by = U` and no `organization_id`, or when an open hold opened by U names it (I12). Anything else on the same customer is **not this flow's**: never swept, never held, never counted (§4.2). A shared customer is never evidence. |
| **Payment hold** | A row saying that one create-a-team subscription, which the flow touched, is not yet proven settled. While it is open, it blocks U's next create-a-team mint. |
| **Held invoice** | The invoice the hold was opened on: `latest_invoice` at the moment of the write-ahead. **The only invoice a hold ever reads, voids or refunds.** |
| **Settled** | The held invoice is `void`, or `paid` and fully refunded. Or the subscription became a live purchase that the user now owns (adopted). |
| **Live subscription** | Stripe status `active`, `trialing`, `past_due`, `unpaid` or `paused`. |

`PAID_SUBSCRIPTION_STATUSES` (`lib/billing/new-org-setup.ts:96-100`) is `active`, `trialing` and
`past_due`. **Live** is deliberately wider: an `unpaid` or `paused` subscription still exists.

The rev 4 notion of a **purchase scope** (`org_plan`, `new_org`, `ai`) is gone. Only one flow opens
holds, so a hold is keyed by its payer alone (§4.1). Widening is Q13.

---

## 3. The state machine

The machine is flow-agnostic. It is unchanged from rev 4 except where marked **(rev 5)**.

### 3.1 States

| State | Meaning | Blocks the payer? |
|---|---|---|
| `closing` | Written **before** the void and the cancel (write-ahead). | yes |
| `cancel_unproven` | The void or the cancel failed, and a re-read did not prove it done. The subscription may still be `incomplete`, and its invoice payable. T3 or T3v retries on every observe. | yes |
| `payment_in_flight` | The subscription is ended, but a PaymentIntent on the held invoice is `processing` or `requires_capture`. | yes |
| `invoice_payable` | The subscription is ended and no money was taken, but the held invoice is not proven unpayable. | yes |
| `refund_due` | A PaymentIntent on the held invoice `succeeded` after our cancel, and no live refund covers it. | yes |
| `refund_pending` | Refunds covering every succeeded PaymentIntent exist, and at least one is `pending` or `requires_action`. | **no** (Q10) |
| `needs_operator` | The machine cannot settle this hold. Only an operator can release it. | yes |
| `released` | Terminal for this row, kept for audit with `release_reason`. A later E0 on the same subscription writes a **new** row. | no |

**Why `refund_pending` does not block.** The block stops a *second payment for the same product*
while an earlier one may still land. In `refund_pending` the earlier payment has landed and is on its
way back. A refund that later **fails** returns the hold to `refund_due` (T10f), and the machine
refunds again, or an operator does (T14). A refund that neither succeeds nor fails reaches an operator
through I11.

Every open state sets a non-null `next_check_at` when it is entered: `closing` and `cancel_unproven`
5m, `invoice_payable` 15m, `payment_in_flight` 1h, `refund_due` the §3.5 backoff, `refund_pending` 1h,
`needs_operator` 24h (observe only). Every state entry writes `state_since`. Every successful
observation writes `last_pay` and, for `refund_pending`, `refund_action_since`. The age alerts (I11)
and the copy (§5.5) read those three columns.

| `release_reason` | When |
|---|---|
| `voided_unpaid` | The held invoice is void and no PaymentIntent on it succeeded. |
| `deleted_draft` | The held invoice was a draft and was deleted. |
| `refunded` | Refunded in full by this machine, and every covering refund reads `succeeded`. |
| `already_refunded` | Refunds this hold did not create cover the charge and read `succeeded`. |
| `adopted` | The subscription went live while it was still ours to keep. Only `closing` and `cancel_unproven` can reach this. |
| `expired_unpaid` | `incomplete_expired`, with the held invoice void or unpaid. |
| `operator` | An operator released it. |

A failed **observation** (a Stripe read error) is **not** an event. It never moves a hold. It only
writes `attempts`, `last_error` and `next_check_at`.

### 3.2 Events

| Event | Raised by |
|---|---|
| **E0 `open`** | The create-a-team flow, under the lease, just before it voids or cancels a swept subscription or the prior. |
| **E1 `observe`** | `advanceHold(hold)` reads the subscription, the held invoice, that invoice's payments, and their refunds, and classifies them as **O** below. Callers, **each holding the user's lease**: (a) the create-a-team flow, for **every** open hold of its user, and the link for a hold on its subscription (§5.6); (b) the scheduled sweeper, for every hold that is **due**: `next_check_at <= now()`, or `nudged_at > observed_at` (§4.1, §5.4); (c) the operator's `show` and `reconcile`. The webhook only nudges (§5.3). |
| **E2 `operator_release`** | The audited operator command (§5.4). |

**O** is a tuple read in this order: subscription, invoice, payments, refunds. A payment that lands
between two reads shows up in the later payments read. The order narrows the read race; it does not
close it, so T11r also re-reads.

- `sub`: `incomplete` · `ended` (`canceled` or `incomplete_expired`) · `live` · `missing`
- `inv`: `open` · `uncollectible` · `draft` · `void` · `paid` · `none`
- `pay`:
  - `awaiting`: every PaymentIntent is `requires_payment_method`, `requires_confirmation` or `requires_action`, or there is no payment
  - `failed`: a PaymentIntent is `canceled`, and none is in flight or succeeded
  - `in_flight(pi)`: `processing`
  - `capturable(pi)`: `requires_capture`
  - `succeeded(pis)`
  - `unrecognised`: a payment that is not a PaymentIntent, or the payment list has `has_more`
- `refund`, for each succeeded PaymentIntent, from `refunds.list({ payment_intent })`:
  - `none`: no refund, or every refund is `failed` or `canceled`
  - `pending`: live refunds cover `amount_received`, and at least one is `pending` or `requires_action`
  - `done`: refunds with `status = succeeded` alone cover `amount_received`
  - `partial`: anything else

  `amount_refunded` is **not** read as proof (S9).

### 3.3 Transition table

The rows are evaluated top to bottom, and the first match wins. "→ act" means `advanceHold` performs
the Stripe write, then observes again in the same call, up to 3 steps per call.

**Positive evidence before any release.** A row that releases a hold matches only on a
**positively-read terminal state**, never on the absence of something:

- T10 and T10p need `pay = succeeded(pis)` with `pis` **non-empty**.
- T9 needs `inv ∈ {void, none}` **and** `pay ∈ {awaiting, failed}`, a complete list of recognised
  PaymentIntents. `unrecognised` never releases.
- A release after a Stripe write (T8's void, T8d's delete) is positive by its own act.
- Every read that is empty, lagging or unrecognised where the invoice says money moved goes to T11r
  and T11, which sit **above** every refund and release row.

| # | From | Observation / event | Action | To |
|---|---|---|---|---|
| T0 | — | E0 `open`, and the row is written | — | `closing` |
| T0f | — | E0 `open`, and the **write fails** | Nothing is voided or cancelled. The purchase is refused (`UNCONFIRMED`, no promise of a block). The subscription is still `incomplete`, so the next sweep finds it. | (no row) |
| T0h | — | E0 `open`, and the insert conflicts with an **open** hold on the same subscription (the partial unique index, §4.1). **Rev 5:** this now happens only when the backfill (§8) and a purchase meet the same subscription. | No new row, and nothing is voided or cancelled. The flow refuses with that hold's clause (§5.5). | (the existing row) |
| T1 | any open state | `sub = missing` | alert | `needs_operator` |
| T2 | `closing`, `cancel_unproven` | `sub = live` | none. The flow treats it as the user's paid setup and returns `resume` (§4.3). | `released(adopted)` |
| T3 | `closing`, `cancel_unproven` | `sub = incomplete`, `pay ∈ {awaiting, failed}`, `inv ∈ {open, uncollectible}` | → act: **void the held invoice**, then **re-read it**. Only a re-read showing `inv = void` lets the same call go on to cancel (T3v). A void that throws, or a re-read showing anything else, **makes no cancel** and goes to T3a. | the next observe decides |
| T3v | `closing`, `cancel_unproven` | `sub = incomplete`, `inv = void`, `pay ∈ {awaiting, failed}` | → act: **cancel**, stamped `cancellation_details.comment = "alethia:checkout_closed:<hold id>"` (S12, §5.3 (4)), then re-read. | `ended` → T9; a cancel failure → `cancel_unproven` |
| T3a | `closing` | `sub = incomplete`, and the void or the cancel threw, or the re-read did not show `void` | No alert. `attempts += 1`. | `cancel_unproven` |
| T3b | `cancel_unproven` | T3 or T3v fails a **second** consecutive time | alert | `cancel_unproven` |
| T4 | `closing`, `cancel_unproven` | `sub = incomplete`, `pay ∈ {in_flight, capturable, succeeded}` | Nothing. The subscription will go live (T2) or fall back to `failed` (T3 / T3v). | unchanged (blocks) |
| T11r | any open state but `needs_operator` | `inv = paid` and no succeeded PaymentIntent | → act: re-read the payments once and match again with T11r excluded. A second read with no succeeded PaymentIntent alerts. | as matched, else `needs_operator` |
| T11 | any open state but `needs_operator` | `pay = unrecognised` | → act: re-read once, as T11r. A second `unrecognised` read alerts; the copy never says "no PaymentIntent took the money". | as matched, else `needs_operator` |
| T5 | `closing`, `cancel_unproven`, `payment_in_flight`, `invoice_payable`, `refund_due` | `sub = ended`, `pay = succeeded(pis)` with `pis` non-empty, some PaymentIntent with `refund ∈ {none, partial}` | → act: for each, **reserve an attempt number first** (§3.5), then refund the uncovered amount with that number's key | `refund_pending`, or `released(refunded)`; on failure T13 / T14 |
| T6 | (same set as T5) | `sub = ended`, `pay = in_flight(pi)` | none | `payment_in_flight` |
| T7 | (same set as T5) | `sub = ended`, `pay = capturable(pi)` | → act: `paymentIntents.cancel(pi)` | the next observe decides |
| T8 | (same set as T5) | `sub = ended`, `pay ∈ {awaiting, failed}`, `inv ∈ {open, uncollectible}` | → act: void, **before** the release (S5) | `released(voided_unpaid)`, or `invoice_payable` |
| T8d | (same set as T5) | `sub = ended`, `inv = draft` | → act: `invoices.del` | `released(deleted_draft)`, or `invoice_payable` |
| T9 | (same set as T5) | `sub = ended`, `inv ∈ {void, none}`, `pay ∈ {awaiting, failed}` | none | `released(voided_unpaid)`, or `released(expired_unpaid)` for `incomplete_expired` |
| T10 | (same set as T5), `refund_pending` | `sub = ended`, `pis` **non-empty**, every one `refund = done` | none | `released(refunded)` when this hold created the refunds, else `released(already_refunded)` |
| T10p | (same set as T5), `refund_pending` | `sub = ended`, `pis` **non-empty**, every one `refund ∈ {pending, done}`, at least one `pending` | `next_check_at = now + 1h` | `refund_pending` |
| T10f | `refund_pending` | a succeeded PaymentIntent reads `refund ∈ {none, partial}` again | alert once | `refund_due` |
| T12 | `invoice_payable` | the void fails | → act: re-read the payments once. `succeeded` → T5, `in_flight` → T6, else stay. | as matched |
| T13 | `refund_due` | `refunds.create` fails, budget left (§3.5) | `next_check_at = now + backoff` | `refund_due` |
| T14 | `refund_due` | the refund fails and `refund_attempt >= 5` | alert | `needs_operator` |
| T15 | `needs_operator` | E1 `observe` | Observe and record only. Never auto-releases. | `needs_operator` |
| T16 | any open state | E2 `operator_release(reason)` | Under the user's lease (up to 30s wait, refused if still busy). Prints the live observation, then writes `released_by`, `release_note` and an audit event with a compare-and-set on `version`. | `released(operator)` |
| T17 | any open state | `sub` reads a status outside these rows (`unpaid`, `paused` on an ended sub, an unknown value) | alert | `needs_operator` |
| T18 | `released` | any event | none (inert) | `released` |

### 3.4 Why void before cancel

Today the order is cancel, read, then void (`billing.ts:1028`, `:925`, `:940`). Between the cancel
and the void, the subscription is `canceled` while its invoice is still payable (S1). That window is
where blockers 4176267018 and 4176778630 live.

The design voids first. A void that **succeeds** proves the invoice was not `paid` at that instant
(S2). If S7 is false and a `processing` payment survives the void, the next observe still sees
`in_flight` (T6). **A void that fails stops the cancel**: if it failed because the invoice is now
`paid`, cancelling would end a purchase the customer just completed in another tab.

**A consequence the receipt rule relies on (rev 5).** The machine cancels only after a void it has
proven (T3 → T3v). A `paid` invoice cannot be voided (S2). So **the machine never cancels a
subscription whose first invoice is paid**. A subscription that reads `incomplete` with a paid
invoice will go `active` (T4, then T2), and it is never ended by us. §5.3 (2) uses this.

`readFirstPayment` (`first-payment.ts:65-74`) would read `incomplete` + invoice `void` + PaymentIntent
`canceled` as `not_proven_unpaid`. The design adds one rule to it: invoice `void` and no payment
succeeded or in flight means `never_paid` (C47).

### 3.5 Refunds and the 24h idempotency replay (AC2, S6)

- Before every attempt, read `refunds.list({ payment_intent })` and classify it (§3.2). `done` goes
  to T10, `pending` to T10p, and only `none` or `partial` creates a refund, for the uncovered amount.
  **The read decides, not the key.**
- A refund that later fails is seen in two ways: the sweeper observes `refund_pending` hourly, and the
  webhook nudges on `charge.refund.updated` (§5.3). Either fires T10f.
- The key is `hold-refund-<pi>-<refund_attempt>`, so a retry after a *failed* attempt is not
  replayed as the same failure for 24h. A double refund is impossible: Stripe refuses a full refund of
  a refunded charge (`charge_already_refunded`, mapped at `billing.ts:824-826`), and the read runs
  first anyway.
- **The attempt number is reserved before the call.** T5 first runs a fenced state write,
  `UPDATE … SET refund_attempt = refund_attempt + 1, version = version + 1 WHERE id = $1 AND
  version = $2 AND <holder fence> RETURNING refund_attempt`, and builds the key from the number it
  consumed (the first key is still `-0`, C4). **No `refunds.create` is made unless that write returned
  a row.** A crash after the reservation wastes one number and never reuses a key.
- The budget is 5 attempts with backoff 5m, 30m, 2h, 6h, 24h, then T14 (Q4).

### 3.6 Invariants

Each invariant is tested (§6).

- **I1, mint gate.** The create-a-team flow calls `subscriptions.create` only when, under the user's
  lease and **in this order**:
  - (a) every hold of the user is `released` or `refund_pending` after one `advanceHold` pass;
  - (b) the sweep of the `incomplete` subscriptions **classified** to the user (§4.2), paged in full,
    left none open;
  - (c) a list read **after** (a) and (b) finds no live create-a-team subscription of the user on any
    customer the user's records name (§4.3).

  Reading (c) last means a subscription adopted during (a) is still seen.
- **I2, held invoice only.** `advanceHold` reads, voids, deletes and refunds only `hold.invoice_id`,
  never `sub.latest_invoice`. A renewal invoice can never be refunded by a hold.
- **I3, refund preconditions.** A refund requires the PaymentIntent to be on the held invoice, to be
  `succeeded`, and the subscription to read `ended` in the same observation. `adopted` holds never
  refund.
- **I4, write-ahead.** No create-a-team code path voids or cancels a subscription unless an open hold
  row for it was committed first. The one exception is the close-out of an artifact that never left
  the server (§4.4 rule 4).
- **I5, failures don't move state.** A Stripe or DB failure during `observe` never transitions a hold
  and never mints.
- **I6, release is the only exit.** Rows are never deleted. At most one **open** row exists per
  subscription.
- **I7, payer isolation (rev 5).** The create-a-team flow reads only its user's holds. It sweeps,
  live-checks and holds only subscriptions classified to its user (§4.2). An org-plan or AI subscription
  on a shared customer, and another user's subscription, is never voided, cancelled, held or counted.
- **I8, copy is true.** Every customer message is derived from the set of hold states and outcomes in
  this request (§5.5), **and the sheet shows it** (§5.6, rev 5). It claims an alert only when
  `alertPaymentNeedsSupport` returned true (`payment-alert.ts:27-30`). It says "refunded" only for a
  refund that reads `succeeded`.
- **I9, the artifact gate (rev 5: one artifact).** The create-a-team client secret leaves the server
  only after a fenced compare-and-set on the lease, made **after** `subscriptions.create` returned,
  succeeds (§4.4). With I1 (b), **at most one payable create-a-team subscription exists per user at a
  time.**
- **I10, liveness.** Every open hold has a non-null `next_check_at`, and a scheduled sweeper observes
  every hold that is due (§5.4).
- **I11, every open hold is watched.** Every open state has a finite age bound after which the sweeper
  alerts an operator once per state entry (§5.4).
- **I12, a hold's payer is fixed.** `payer_key` is written at E0 and never changes. A hold on X keeps
  blocking U after X is linked to an org.
- **I13, the link never syncs a setup it refuses, and the sheet never reports a state the server did
  not return (rev 5).** §5.6.

---

## 4. Where each piece of state lives

### 4.1 The `payment_holds` table

The table is new, service-role only, with RLS enabled and no app policy, like the shape in
`04dee418c`. Columns:

- `id`
- `subscription_id`: **unique among open rows only**: `CREATE UNIQUE INDEX … ON payment_holds
  (subscription_id) WHERE state <> 'released'`. A plain unique constraint would turn an operator
  release of a still-`incomplete` subscription into a 23h dead end (C51).
- `customer_id`
- `payer_key`: the user id, NOT NULL. Index on `(payer_key) WHERE state <> 'released'`.
  **Rev 5:** the `scope` column is gone; widening adds it back (Q13).
- `invoice_id`: the held invoice (I2)
- `payment_intent_id`: nullable
- `state`
- `release_reason`, `released_at`, `released_by` (a user id, or null for the system), `release_note`
- `refund_attempt`: int, default 0
- `attempts`, `last_error`, `next_check_at`, `alerted_at`
- `notice_last_sent_at`: when a response last **carried** this hold's clause. It never means
  "delivered".
- `opened_by_user_id`, `opened_by` (`purchase | backfill`), `open_note`
- `state_since`, `last_pay`, `refund_action_since`, `age_alerted_at`
- `observed_at`: when the observation behind the last state write **started**. E0 sets it to the
  insert time.
- `nudged_at`: the webhook's hint. A hold is due when `next_check_at <= now()` **or**
  `nudged_at > observed_at`.
- `version`: the **state version**, bumped by state writes only.
- `created_at`, `updated_at`

**Rev 5:** `receipt_owed_invoice_id` and `receipt_sent_at` are removed (K3, §5.3 (2)).

**Which writes take part in the compare-and-set.**

| Kind | Writes | Columns it may change | Fence |
|---|---|---|---|
| **State write** | E0 (insert), every `advanceHold` transition, T5's attempt reservation, T16, the sweeper's age alert | `state`, `state_since`, `release_*`, `refund_attempt`, `attempts`, `last_error`, `last_pay`, `refund_action_since`, `observed_at`, `next_check_at`, `alerted_at`, `age_alerted_at`, `version` | `WHERE id = $1 AND version = $2` **and**, in the same statement, `EXISTS (SELECT 1 FROM purchase_leases WHERE key = $k AND holder = $h AND expires_at > now())`. Sets `version = version + 1`. |
| **Hint write** | the webhook nudge | `nudged_at`, `updated_at` and nothing else | No `version` check, no bump, no lease. `WHERE subscription_id = $1 AND state <> 'released'`. |

A hint write cannot change state, counters or schedule, so it needs no fence. Because it never
touches `version`, it can never make a state write miss (C74). A nudge that lands during a step has
`nudged_at` later than that step's `observed_at`, so the hold is due again at once.

There is no FK on `payer_key`. A hold is about money and outlives the user's account.

**Why the database and not Stripe metadata.** Discovering a hold from metadata would need
`subscriptions.list({ status: "canceled" })` paged per customer on every purchase, and the search API
lags (#5455 blocker 4174185555). An operator release needs audit fields. And the write-ahead (I4) is
just as atomic in Postgres, where the lease lives.

**Why not on `pending_org_setups`.** The record answers "where is my paid setup?", and a hold
answers "which payment is unsettled?". A record exists for every mint. A hold exists only for a
subscription the flow is closing, which can be a subscription that has no record: one minted
before the record existed, or one swept from a recorded customer. They stay separate, joined on
`subscription_id`.

### 4.2 Classification: what the create-a-team flow may touch

A subscription is user U's when **its own metadata** has `created_by = U` and no
`organization_id`. The sweep, the hold pass and the live check filter on that. **Rev 5:** this fixes a
live defect in today's sweep, which lists every `incomplete` subscription on the customer
(`billing.ts:1068-1072`). On a shared customer it can cancel an existing org's `incomplete`
org-plan or AI checkout.

1. **A subscription that is not U's is left alone.** It is reported to the operator with the
   subscription as the alert's subject, which the alert rule's throttle collapses
   (`payment-alert.ts:23-25`, `:50`). The alert has its own summary, not `alertPaymentNeedsSupport`'s
   fixed "which the purchase flow cancelled or was replacing" (`:38-40`). The purchase is **not**
   refused for it, because it cannot double-charge U's create-a-team purchase.
2. **No new sharing.** `ownedCustomer` and the browser-customer branch (`billing.ts:1651-1657`) also
   require that the customer has **no** `organization_id`. An org's customer, including one a
   previous link rewrote, is never reused for create-a-team.

### 4.3 The live check, against webhook lag (AC12)

Before minting, after the hold pass and the sweep, the flow lists
`subscriptions.list({ customer, status: "all" })` for every customer U's records name, fully paged,
and filters to U's create-a-team subscriptions. A **live** one returns `kind: "resume"` through
`newOrgSetupStateFor` (`billing.ts:1961`), as the paid-prior path does at `:1597-1604`. A linked one
is no longer U's create-a-team subscription. It belongs to the new org, and its later purchases are
out of scope (§7).

### 4.4 The lease

**Key.** `user:<userId>`, taken by the create-a-team flow, the link, the sweeper and the operator
command. **Rev 5:** this replaces `new-org:<userId>` (`billing.ts:1576`). The org-plan flow keeps
`withPurchaseLock` and `org-plan:<orgId>` unchanged (§7).

**Pool and timeout budget (the issue's "Also").** Today the lock holds one pooled connection in an
open transaction for the whole Stripe sequence, plus up to 30s waiting (`purchase-lock.ts:22`,
`:36-45`). With `poolMax = 10` (`lib/config/database.ts:20`), about 10 waiters starve the holder.
Nothing sets the Stripe client timeout (`lib/billing/stripe.ts:15-18`). A purchase with *h* open
holds and *n* swept subscriptions makes up to about 6·(h+n)+4 Stripe calls.

**Recommendation (Q2):** a lease row, `purchase_leases(key PK, holder uuid, expires_at)`, taken with
`INSERT … ON CONFLICT (key) DO UPDATE … WHERE purchase_leases.expires_at < now()`. **No connection
is held** while Stripe is called. The lease lasts 120s, and every hold write checks `holder` (a fencing
token).

**The lease can expire mid-purchase, and fencing cannot stop a Stripe write.** With A stalled past its
lease, B could take over, mint Y and return its secret. A's calls then return, and A mints Z and returns
its secret: two payable subscriptions. Four rules close it:

1. **Renew before every Stripe write.** `UPDATE purchase_leases SET expires_at = now() + 120s WHERE
   key = $1 AND holder = $2`. Zero rows means the lease is lost. The holder stops, makes no further
   Stripe write, and refuses with `PURCHASE_IN_PROGRESS`.
2. **A mint deadline.** `subscriptions.create` is called only when the renewal just made leaves more
   than the mint's worst case (2 × 20s) plus a 10s margin.
3. **The artifact gate (I9).** After `subscriptions.create` returns (`billing.ts:1704`), and before
   `recordPendingOrgSetup` and the return (`:1723-1744`), the holder runs the same fenced renewal.
   **Only a renewal that returns a row lets the secret out.**
4. **The close-out exemption.** After a failed gate, the stale holder may make exactly the Stripe
   writes that close the subscription it created in this request, and nothing else. It voids Z's first
   invoice, then cancels Z, stamped `alethia:closeout` (S12). It writes **no hold row**: no payment can
   land on a subscription whose secret never left the server. Z carries no `organization_id`, so none
   of its events writes any org row (`sync.ts:96-101`, C67). **If the close-out fails**, Z stays
   `incomplete` with no secret anywhere and is swept by U's next purchase, or expires (S3).

The idempotency key on `subscriptions.create` is `mint-<lease key>-<holder>`. It differs between
holders on purpose: a shared key would replay A's subscription to B after B's sweep had cancelled it.

**What the design guarantees is "at most one payable subscription per user" (I9), not "at most one
`subscriptions.create` call".** The second needs fencing Stripe, and the first is what stops a double
charge.

If the maintainer keeps the advisory lock instead, three things are needed:

- `idle_in_transaction_session_timeout` is unset, or above the worst-case purchase.
- After the create, a query on the lock's own transaction must succeed before the secret is returned.
- `poolMax` is at least 2 × the number of same-key waiters expected per process.

### 4.5 Pagination (AC10)

- The create-a-team sweep's `subscriptions.list` is paged to the end, capped at 1000 per customer.
  **Over the cap, the flow refuses** and alerts.
- `invoicePayments.list` and `has_more` are already fail-closed (`first-payment.ts:57`, `:111`).
- `unlinkedPendingOrgSetupCustomers` (`pending-org-setup.ts:212-230`, `limit = 5`) moves to keyset
  pages over all of the user's unlinked records, capped at 50 customers. Over the cap, the flow
  refuses.

---

## 5. Failure handling for every external call

### 5.1 Stripe calls inside `advanceHold` and the create-a-team flow

Every read goes through `readTwice` (`billing.ts:836-842`). Every Stripe **write** below is preceded
by the fenced lease renewal (§4.4, rule 1).

| Call | On error (429, 5xx, network, other) | Never |
|---|---|---|
| `subscriptions.list` (sweep and live check) | Refuse the purchase (`UNSETTLED`). | mint |
| `subscriptions.retrieve` | `resource_missing` → T1. Anything else is an observation failure. | read as "gone" |
| `invoices.retrieve` | Observation failure. | read as "void" |
| `invoicePayments.list`, `paymentIntents.retrieve` | Observation failure. | read as "unpaid" |
| `refunds.list` | Observation failure. | read as "refunded" |
| `invoices.voidInvoice` | Re-read once. `void` counts as done. Otherwise T3a **with no cancel**, or, on an ended subscription, `invoice_payable` and T12. | release; cancel |
| `invoices.del` (draft) | Re-read. Gone is done; otherwise `invoice_payable`. | release |
| `subscriptions.cancel` | Re-read. `ended` is done; otherwise `cancel_unproven`, and T3v retries. | mint |
| `paymentIntents.cancel` | Re-read. `canceled` is done; otherwise stay `payment_in_flight`. | release |
| `refunds.create` | Re-read the refunds. `done` → T10, `pending` → T10p, else T13 or T14. | release |
| `subscriptions.create` | Throws. No secret is returned. A create whose gate fails is closed out (§4.4 rule 4). | return a secret without the gate |

### 5.2 Database writes

| Write | On error |
|---|---|
| E0 hold insert | T0f: nothing is voided or cancelled, and the purchase is refused. |
| Hold state update after a Stripe write succeeded | The row is stale but **still open**. The next observe re-derives the state from Stripe. The result is a delay, never a wrong release. |
| Lease acquire or renewal returning no row | Refuse with `PURCHASE_IN_PROGRESS` (`billing.ts:787-788`). After a mint, §4.4 rule 3. |
| `recordPendingOrgSetup` after the mint | As today (`billing.ts:1728-1743`), but as a close-out: void, then cancel stamped `alethia:closeout`, no hold row, and the secret is never returned. |

### 5.3 The webhook (`lib/billing/webhook-handler.ts`)

**The webhook makes no Stripe call for a hold.** The handler runs inside
`runWebhookEventExactlyOnce`'s transaction (`webhook-events.ts:92-121`). For holds it only *reads*
holds (one indexed query) and *writes* `nudged_at = now()` (a hint write, §4.1) on the ones the event
names, in the same transaction that marks the event `done`. After the response, the route wakes the
in-process sweeper without awaiting it. **No event is ever deferred or failed because of a hold.**

Four changes:

1. **No backup-card retry on a held or ended create-a-team subscription's invoice.** On
   `invoice.payment_failed` the handler runs `attemptBackupPayment` (`webhook-handler.ts:163-180`),
   which `invoices.pay`s the invoice with each of the customer's backup cards. On an `incomplete`
   first invoice that a hold is closing, or a cancelled subscription's still-open invoice (S1), **that
   is us charging a checkout we cancelled**. The fix: skip the retry when the subscription is not live,
   or when an open hold names the invoice. Then nudge. (A renewal's dunning retry is untouched, §7.)
2. **The receipt and the org row.**

   **The receipt (rev 5, K3).** On `invoice.payment_succeeded`, the receipt is decided by the
   subscription `subForInvoice` just retrieved (`webhook-handler.ts:47-53`):
   - **ended** (`canceled`, `incomplete_expired`): no receipt. The payment landed after our cancel
     and is being refunded (T5). The refund is what the customer is told about (§5.5, Q3).
   - **anything else** (`incomplete`, live): send it, as today. This holds with or without a hold.

   §3.4 proves why an `incomplete` subscription with a paid invoice is a purchase the customer keeps.
   The machine cancels only after a void it proved, and a paid invoice cannot be voided (S2). So
   that subscription goes `active`, and no state the machine can reach takes it back. Revision 4
   held the receipt back for `incomplete` under a hold and sent it on adoption. That needed a
   lease-fenced column the webhook could not write, and a send that callers other than the sweeper
   were never told to make. Both are gone.

   **The org row: what this design needs from #5514 (rev 5, K4).** Before the link, X has no
   `organization_id`, so no event for X writes any row (`sync.ts:96-101`). After the link, the new org
   has exactly one subscription, X. The link refuses an org whose row names another one (§5.6), and
   every later purchase on that org is out of scope. So of rev 4's W1–W5, only the rules about **one
   subscription's own events** are needed:

   - **N1, no regression by a stale or out-of-order event of the same subscription.** An event older
     than one already applied for X changes nothing. Two events stamped in the same second, `incomplete`
     and `active`, delivered in either order, end on `active`.
   - **N2, a write with no event time does not demote the subscription the row names.** The link's own
     sync (`billing.ts:1907`) writes the subscription object it read during the link. If X went
     `active` after that read and the webhook already applied `active`, the link's write must not take
     the row back to `none` / `community`. It may apply only when it does not lower X's lifecycle stage
     (`none` < live < ended), or when it carries a read time no older than the stored one.
   - **N3, a cancellation touches only the row that names it,** and never inserts a row.

   W2 (another live subscription), W5 (the AI columns) and W1's fresh read are **not** needed in this
   scope. N1 with a same-second tie-break meets the same purpose as W1 for one subscription. Revision
   4's live set (`unpaid`, `paused`) mattered only for W2.

   **Checked against #5514's implementation, PR #5518 at `4a306a0f6` (2026-10-04).**
   - **N1 holds.** The event-time watermark has a lifecycle tie-break
     (`lib/billing/queries.ts`, `sameSubscriptionMayApply`), tested at
     `tests/integration/billing-sync.test.ts:172` and `:191`.
   - **N3 holds**, tested at `:149` and `:163`.
   - **N2 does not hold.** "A write with no event time — a server action's live read — skips that
     check" (the `queries.ts` block comment). So this sequence drops a paid org to `community`:
     1. The link's `subscriptions.update` returns X `incomplete`, because the card payment's invoice
        is still settling (`first-payment.ts:7-10`).
     2. X goes `active`, and the webhook applies `active` with its event time.
     3. The link's `syncSubscriptionToBilling(linked)` then writes the `incomplete` snapshot with no
        event time.

     Nothing repairs it until X's next event, which may be its renewal. Today's code has the same
     race, because the last write wins. This is C76. **§8 step 3 is blocked until #5518 (or a
     follow-up) meets N2 with a test for that sequence.** #5518 has a comment naming it.
3. **Events nudge holds.** `invoice.payment_succeeded`, `invoice.payment_failed`,
   `customer.subscription.updated` and `customer.subscription.deleted`, each for a subscription with an
   open hold, and `charge.refund.updated` for a PaymentIntent with an open hold.
4. **A cancel the machine made sends no "subscription canceled" email.** Today
   `customer.subscription.deleted` emails "subscription canceled" for every never-paid checkout the
   sweep closes (`webhook-handler.ts:107-113`, `billing-email.ts:262`). Every machine cancel is
   stamped in `cancellation_details.comment` (`alethia:checkout_closed:<hold id>` or
   `alethia:closeout`, S12). The subscription carries the stamp in the event (`Subscriptions.d.ts:364`).
   A stamped deletion sends no email and no revenue event. An unstamped one keeps both.

`WEBHOOK_EVENTS` (`scripts/stripe-setup.ts:67-75`) already includes the four events in (3), but not
`charge.refund.updated` (Q6).

### 5.4 The sweeper and the operator commands

**The sweeper is required.** `startPaymentHoldSweeper()` is booted from `instrumentation.ts`, beside
`startConnectionSweeper` (`:42-43`) and in the same `registerLoop` shape, every 5 minutes. Each tick:

- selects the open holds that are due, oldest first;
- for each one, takes the user's lease with a 0s wait. A busy lease skips that hold for this tick.

It runs on every instance, and the lease serialises them. It has the optional twin route behind
`ALETHIA_CRON_SECRET`. `wakePaymentHoldSweeper()` schedules one immediate, coalesced tick. A tick
handles at most 50 holds, with at most 3 steps each.

**Age alerts (I11).** Each tick alerts once per hold and per state entry (`age_alerted_at`) when the
hold has been in its state longer than:

| State | Last observation | Alert after |
|---|---|---|
| `closing`, `cancel_unproven` | `last_pay ∈ {awaiting, failed}` | 24h |
| `closing`, `cancel_unproven` | `in_flight` | 14 days |
| `closing`, `cancel_unproven` | `capturable` | 8 days |
| `closing`, `cancel_unproven` | `succeeded` (paid, not yet `active`) | 1h |
| `payment_in_flight` | `in_flight` / `capturable` | 14 days / 8 days |
| `invoice_payable` | any | 24h |
| `refund_due` | any | the §3.5 budget, then T14 |
| `refund_pending` | a covering refund in `requires_action` since `refund_action_since` | 24h |
| `refund_pending` | any | 14 days |
| `needs_operator` | entry alert not delivered | 24h, then every 7 days |

These numbers are part of Q4.

**Commands.** The script is `scripts/payment-holds.ts`, on the `resync-member-tuples.ts` pattern:

- `list [--open] [--payer …]` and `show <sub>` are read-only. `show` prints the live observation.
- `reconcile [--backfill]` runs one sweeper pass now. With `--backfill` it first runs §8's listing.
- `release <sub> --reason "<text>" --operator <userId>` is T16. It refuses when there is no reason,
  takes the user's lease, prints the live observation, then writes the `version` compare-and-set and
  an audit event (`billing.payment_hold.released`). It is the way out of `needs_operator` and of the
  `unpaid` or `paused` dead end (AC9).

### 5.5 Customer copy

There is one message per *set*, and every clause in it is true. A clause is chosen by the hold's
state **and** its `last_pay`.

| Present in this request | Clause |
|---|---|
| a payment under way: `payment_in_flight`, or `closing` / `cancel_unproven` with `last_pay = in_flight`, or a subscription the sweep **kept** with a `processing` payment | "An earlier checkout's payment is still being processed, so nothing new was started. A bank debit can take several business days; you can try again once it settles." |
| an authorisation (`last_pay = capturable`, or a kept `requires_capture`) | "An earlier checkout's payment was authorised but not completed, so nothing new was started. Your bank can show the authorisation for up to 7 days before it is released or completed; you can try again once it is." |
| `closing` / `cancel_unproven` with `last_pay = succeeded`, or a kept subscription whose payment succeeded | "An earlier checkout's payment has just gone through and is being confirmed, so nothing new was started. Try again in a few minutes." |
| `closing` or `cancel_unproven` with `last_pay ∈ {awaiting, failed}` or no observation yet | "We could not confirm an earlier checkout was closed, so nothing new was started. Try again in a few minutes." |
| a kept subscription with no payment, or with `has_more` (C39) | "An earlier checkout is still open and we could not confirm it is unpaid, so nothing new was started. Try again later; it closes on its own within a day." |
| `invoice_payable` | "We could not yet close an earlier checkout's invoice, so nothing new was started. Try again in a few minutes." |
| `refund_due` | "An earlier payment went through after that checkout was cancelled. Its refund has not gone through yet; nothing new can be started until it has." |
| `refund_pending` | "An earlier payment went through after that checkout was cancelled. We have issued its refund, and it is on its way back to you." |
| `needs_operator` | "…contact support at <email>…", plus "we have raised an alert" **only when alerted**. |
| `released(refunded)` or `released(already_refunded)` in the last 14 days | **Appended** to any of the above (C26): "An earlier payment was refunded in full; it can take 5–10 business days to reach you." |
| a link refused on an ended X with no hold (§5.6) | "This checkout was closed before its payment completed, so it was not linked to the new team." |
| a link that succeeded on an `incomplete` X (§5.6) | "Your team is ready. Its payment is still being processed, and the plan switches on as soon as the payment settles; a bank debit can take several business days. If the payment fails, the team stays on the free plan and nothing is charged." |
| T0h | The clause of the existing hold. |
| T0f | `UNCONFIRMED` text, with no promise of a block. |

"You won't be charged twice" appears **nowhere** in the create-a-team flow, its link or its sheet
(C32). **Rev 5:** that includes the sheet's own sentences (`pending-paid-setup.ts:85-90`, `:454-458`,
`:535-545`), which say "you won't be charged again" today. Inside this scope they say what is true
for that outcome instead. The org-plan flow's `PAYMENT_MAY_BE_UNDER_WAY` (`billing.ts:740-741`) is
out of scope (§7).

**Where a clause travels when the request mints.** The create-a-team `{ kind: "intent" }`
(`billing.ts:1744`) gains an optional `notice: string`, which the sheet shows above the Payment
Element. `notice_last_sent_at` means "returned", never "delivered". So the `released(refunded)`
clause is appended to every create-a-team response of that user for 14 days after `released_at`.

### 5.6 The link, the resume lookups and the sheet (rev 5: the sheet is in scope)

**The link consults holds and returns a typed result.** Right after the retrieve
(`billing.ts:1863`), **under the `user:<userId>` lease**, and **before any Stripe write**:

| X, and any open hold naming X | The link returns |
|---|---|
| X is ended (`canceled` or `incomplete_expired`) | `{ kind: "refused", clause }`: the hold's clause (§5.5), or with no hold, the "closed before its payment completed" clause. X keeps its create-a-team metadata, and its hold keeps the user as payer (I12). |
| an open hold in `payment_in_flight`, `invoice_payable`, `refund_due`, `refund_pending` or `needs_operator` | `{ kind: "refused", clause }` with that hold's clause. |
| an open hold in `closing` or `cancel_unproven` | Run `advanceHold` first (the link holds the lease). `released(adopted)`: link as below. A T4-shaped observation that is still open: **link and defer**. Otherwise X was just closed: refused, as in the first row. |
| **the org's billing row already names a different subscription (rev 5)** | `{ kind: "refused", clause: "This team already has a subscription, so this payment was not linked to it. Contact support with the time of the payment." }`, and an alert with X as the subject. This keeps a new org at one subscription, which the narrowed #5514 contract relies on (§5.3 (2)). The sheet never produces it: each setup record finds its own org by its marker (`NEW_ORG_SUBSCRIPTION_KEY`). |
| X `incomplete`, no hold | **Link and defer**: `{ kind: "linked", planState: "processing" }`. |
| X live | Link as today: `{ kind: "linked", planState: "active" }`. |

**Link and defer** is today's link, unchanged: the metadata writes (`billing.ts:1897-1903`), then the
sync (`:1907`), which keeps the org on `community` while X is not live (`sync.ts:124-130`). X now
carries `organization_id`, so the webhook that reports X `active` applies the plan. That holds only
under N2 (§5.3 (2), C76). If X's payment later fails, the hold that names X voids and cancels it.
With no hold, Stripe expires it (S3). The team stays on `community`, and nothing is charged.

**The resume lookups report a held setup.** `NewOrgSetupState` (`lib/billing/new-org-setup.ts:71-95`)
gains `hold: { state; notice } | null`, and `resolveNewOrgSetup` (`billing.ts:2031`) and
`findUnfinishedNewOrgSetup` (`:2082`) fill it. A held setup is never reported as resumable.

**The sheet (rev 5, K5).** `runSteps` (`components/org/pending-paid-setup.ts`) changes in four places:

1. **Stop before creating the org.** `resolveNewOrgSetup` runs before the org is created (`:454`). When
   it reports `hold` set, or X ended, the run throws `SetupStopped(notice)` **before**
   `authClient.organization.create` (`:472`). No team is created for a setup that cannot be linked.
2. **Render the link's result.** `{ kind: "refused" }` throws `SetupStopped(clause)`: non-retryable,
   with the clause as the message. The browser record is then cleared, because the server keeps the
   memory (the hold row and `pending_org_setups`), and a retry would only be refused again. An org
   created before a racing refusal stays on the free plan, and the clause says so.
   `{ kind: "linked", planState }` is carried to the outcome.
3. **No false success.** `done` carries `planState`. The toast and the final view show it (#5522).
   "Subscription active" appears only for `active`.
4. **The generic retry text is true only for a thrown error.** "Retry to complete setup" stays for an
   exception (an outage), and loses "you won't be charged again". A typed refusal never reaches it.

**Reachability.** The sheet is card-only (§1.1), so a T4-shaped X at link time is mostly the seconds
between a succeeded card payment and the invoice settling. The rules do not depend on which.

---

## 6. Every case, its transitions, and the test that proves it

Case sources:
- **5506** is the issue body or its comment.
- **AC n** is #5506 acceptance criterion n.
- **Rn** is #5489 review round n.
- The thread ids are #5489 inline comments.
- **P** is a #5455 thread or advisory.
- **#5511 review n** is the nth review of this ADR.

Test files are within #5506's `scope:`, except those marked †, which need the scope widened (Q7):

- `A` = `tests/actions/billing-subscription.test.ts`
- `H` = `tests/lib/billing/payment-holds.test.ts`, the pure `advanceHold` table tests, with Stripe mocked
- `W` = `tests/lib/billing/webhook-holds.test.ts`
- `I` = `tests/integration/payment-holds.test.ts`, against real Postgres
- `L` = `tests/integration/payment-hold-lease.test.ts`
- `S†` = `tests/components/org/pending-paid-setup.test.ts`, the sheet's run, with the actions mocked

Every new test must fail on `857794cb9` on its assertion.

**Reachability.** A case that needs a `processing` bank debit, or a subscription that is `active`
before it is paid (S4), is reached only through a payment confirmed outside the sheet. The tests mock
Stripe, so they reach every row regardless.

| ID | Case | Source | Transitions | Test |
|---|---|---|---|---|
| C1 | After the cancel, the PaymentIntent is `processing`, and the retry mints. If it succeeds, the customer paid twice. | 5506; AC1; 4176221898 | T0, T3, T6. Retry: E1 on `payment_in_flight`, so I1 refuses. | A: the create-a-team gap test at `:1522-1545`, flipped. The retry is refused and `subscriptions.create` is not called. |
| C2 | After the cancel, the payments cannot be read, twice. | 5506 | T0, T3, then an observation failure (I5). | A: the retry is refused. H: a read failure changes only `attempts`. |
| C3 | The invoice cannot be voided, so it stays payable. | 5506; AC4; 4176267018 | T3a, or on an ended subscription T8 to `invoice_payable`. | A: a void rejection, then the retry is refused. H: `invoice_payable` plus a void success gives `released(voided_unpaid)`. |
| C4 | After the cancel, the refund fails. | 5506; AC2 | T5, `refund_due`, T13. | A: refused. H: the second attempt uses key `-1`. |
| C5 | A payment that is not a PaymentIntent, or `paid` with no PaymentIntent. | 5506 | T11r, then T11 to `needs_operator`. | H: no refund, and the copy has no "went through". |
| C6 | The same `priorSubscriptionId` again. A `canceled` prior with a `paid` invoice is left alone, and a new one is minted. | 5506 | Its hold is read by payer (I7), not by `priorSubscriptionId`. A `canceled`, `paid` prior with **no** hold is a finished purchase, cancelled later, and is left alone. | A: a prior `canceled` with a `payment_in_flight` hold is refused. With no hold, it mints (regression guard). |
| C7 | The browser lost `priorSubscriptionId` and `customerId`. | AC1; P adv 3 | Holds are found by the session user, never from browser input. | A: three variants (same args, no prior, no customer), each refused. |
| C8 | The refund key replays a saved failure for 24h. | AC2; R2 adv 3 | §3.5. | H: attempt 0 fails, attempt 1 succeeds, giving `released(refunded)`. A refund already present gives T10 with no `refunds.create`. |
| C9 | A processing payment later succeeds: refund, tell the truth, release. | AC3 | T6, (nudge) T5, T10p, T10. The refund clause rides `notice` for 14 days. | W: `invoice.payment_succeeded` on a held invoice of an ended subscription sends no receipt, calls no Stripe write, and nudges. A: the next create-a-team intent carries the refund clause in `notice`. |
| C10 | A processing payment later fails, and is voided before release. | AC3; 4176267018 | T6, then T8. | H: the void is called before `released`. A void failure gives `invoice_payable`. |
| C11 | A stale tab pays a cancelled subscription's open invoice. | AC4; 4176267018 | Void-first (§3.4). A payment that wins the race is seen as T5. | A: `voidInvoice` is called before `subscriptions.cancel`. |
| C12 | A payment lands between the read and the void, and the alert says "no PaymentIntent took the money". | AC4; R5 adv 1 | T12. | H: a void failure plus a re-read showing `succeeded` gives a refund. The alert does not match `/no PaymentIntent .* took/`. |
| C13 | The cancel fails on 429, 5xx or a network error, and the flow mints. | AC5; 4176778630 | T3a to `cancel_unproven`, which blocks. | A: refused, and a retry is refused too. |
| C14 | Retrieve and void errors, each mapped to a state. None maps to mint. | AC5 | §5.1. | H: every §5.1 call × {429, 500, ECONNRESET}; `subscriptions.create` is never called. |
| C15 | The hold write fails. Refuse, and promise no block. | AC6; R2 adv 4 | T0f. | A: the insert rejects; no `voidInvoice` or `cancel`; the copy does not match `/blocked|won't be charged/`. |
| C16 | Two faults in a row lead to a second purchase. | AC6; R3 adv 2 | I4. | I: an update that fails after a successful void leaves the row open, and the next purchase is refused. |
| C17 | A held subscription later reads paid and never clears; later a renewal is refunded. | AC7; 4177048230 | T2 to `released(adopted)`. I2, I3. | H: `cancel_unproven` with `active` is `adopted`, with no refund. A: the 4177048230 replay calls no `refunds.create`. |
| C18 | **Rev 5.** On a shared customer, the create-a-team sweep cancels an existing org's `incomplete` org-plan or AI checkout. | AC8, AC11; 4177048230 (2) | I7, §4.2. | A: a customer with an `incomplete` org-plan subscription and an `incomplete` create-a-team one of U. U's purchase voids and cancels only its own, raises the foreign-subscription alert, and is not refused for it. |
| C19 | A hold on an `unpaid` or `paused` subscription refuses forever. | AC9; R4 adv 3 | T17, then T16. | H: `unpaid` gives `needs_operator`. I†: `release` writes `released_by` and the audit row, and needs `--reason`. |
| C20 | `subscriptions.list({limit:100})` ignores `has_more`. | AC10 | §4.5. | A: page 2 holds a `processing` one, so the purchase is refused. Over the cap, refused. |
| C21 | `unlinkedPendingOrgSetupCustomers` defaults to 5. | AC10; R1 adv 1 | §4.5. | I: 7 unlinked customers are all returned. Over 50, refused. |
| C24 | An `active` create-a-team subscription not yet seen because of webhook lag (or one that went straight to `active`, S4), and a second is minted. | AC12; R4 adv 1 | §4.3. | A: Stripe lists U's `active` unlinked create-a-team subscription, so the flow returns `resume` and calls no `subscriptions.create`. |
| C25 | The lock holds a pooled connection inside a transaction. | 5506 "Also"; R3–R5 | §4.4 lease. | L: two holders; the second waits without a connection; an expired lease is taken over; a stale holder's hold write is rejected. |
| C26 | Mixed outcomes drop the refund notice. | R1 adv 2; R5 adv 2 | §5.5. | A: one swept refunded and one `in_flight`; the message has both clauses. |
| C27 | `requires_capture` after the cancel holds the card until it expires. | R1 adv 3 | T7. | H: `paymentIntents.cancel`, then T8. |
| C28 | Two tabs are not serialised. | R2 adv 1 | §4.4. | L, and A's existing concurrency case for create-a-team, kept. |
| C29 | "went through" when not proven. | R2 adv 2 | T1 and T11 copy. | H: no `/went through/`. |
| C30 | A cancelled subscription read `live`. | R2 adv 5 | T17. | H: `payment_in_flight` with `active` gives `needs_operator`, with no refund. |
| C31 | "Our team has been alerted" when nothing reached a channel. | 4176778633 | I8. | A: with the variable unset, the text does not match `/raised an alert/`. |
| C32 | "You won't be charged twice / again" promised. | R5 adv 3; 5506 comment (3) | §5.5. | A: no create-a-team refusal matches `/charged (twice\|again)/`. S†: no sheet outcome does either. |
| C33 | A `canceled` prior with a `draft` invoice is a dead end. | R5 adv 5 | T8d. | H: `invoices.del` and `released(deleted_draft)`. |
| C34 | Create-a-team "canceled + paid + no team → refund" is reissued through the replay. | #5489 body | Not reintroduced. Refunds only from a hold (I3). | A: a `canceled` prior with a `paid` invoice and no hold calls no `refunds.create`. |
| C35 | `priorSubscriptionId` from the browser cancels someone else's paid subscription. | P 4174412523 | `ownNewOrgSubscription` (`billing.ts:1768-1780`). Holds open only on server-read, `created_by`-checked subscriptions. | A: kept, plus a prior minted by another user is never held or cancelled. |
| C36 | `incomplete` is not "never paid". | P 4174573734 | T3/T3v act only on `pay ∈ {awaiting, failed}`. | A: kept. |
| C37 | Search lag offers a charged customer a second purchase. | P 4174185555 | Holds are a DB query by payer. | H: no `subscriptions.search`. |
| C38 | A lost `customerId` while the first payment is `processing`. | P ac002 adv 5 | Holds keyed by payer; recorded customers swept in full. | A: no `customerId`, a hold on another customer: refused. |
| C39 | An `incomplete` with zero payments, or `has_more`, says "a minute". | P adv 4 | The "kept" clause. | A: refused; no `/a minute/`. |
| C40 | OFFSET paging skips a record. | P adv 6 | Fixed by #5489, unchanged. | I: kept (`pending-org-setups.test.ts`). |
| C41 | `invoice.payment_failed` on a held or ended create-a-team subscription's invoice `invoices.pay`s it with a backup card. | New: `webhook-handler.ts:163-180` | §5.3 (1). | W: an ended subscription with an open invoice and a backup card calls no `invoices.pay`, and the hold is nudged (`version` unchanged). |
| C47 | After void-first, `readFirstPayment` reads `incomplete` + `void` + `canceled` PI as `not_proven_unpaid`. | New: `first-payment.ts:61-74` | §3.4 rule. | `tests/lib/billing/first-payment.test.ts`: gives `never_paid`. |
| C48 | The void succeeds and the cancel 503s: blocked 23h. | #5511 review 1 | T3v, then T9. | H: `cancel_unproven` + `incomplete` + `void` + `failed` cancels and reaches `released(voided_unpaid)`. |
| C49 | The void fails because the payment landed, and the cancel runs anyway. | #5511 review 1 | T3 cancels only after a re-read shows `void`. | H: `voidInvoice` rejects, re-read `paid`: **no** cancel, `cancel_unproven`. |
| C50 | A PaymentIntent succeeds between two reads. | #5511 review 1 | T11r. | H: first read empty, second `succeeded`: T5, no alert. |
| C51 | An operator release meets the unique `subscription_id`. | #5511 review 1 | Partial unique index. | I: release, sweep, E0 inserts a second row; a second open row is refused. |
| C52 | The lease expires mid-purchase: two payable create-a-team subscriptions. | #5511 review 1 | §4.4 rules 1–4. | L: expire A's lease before `subscriptions.create`; B mints. Exactly **one** secret is returned. A's only Stripe writes after the failed gate are `voidInvoice` and a `cancel` stamped `alethia:closeout`; no hold insert. Variant: A's close-out fails, and B's next purchase sweeps Z. |
| C53 | A settled ACH payment with nothing to run it again. | #5511 review 1; AC3 | §5.3 nudge; §5.4 sweeper (I10). | W: no Stripe write, `nudged_at` set, `version` unchanged, 2xx. I: one sweeper tick advances a due hold. |
| C54 | A pending SEPA refund is told "refunded in full", then fails. | #5511 review 1 | `refund` by status; T10p; T10f. | H: `pending` gives `refund_pending` and no "in full"; `failed` gives `refund_due`, `refund_attempt = 1`; only `succeeded` gives `released(refunded)`. |
| C55 | A customer shared with an org is reused for create-a-team. | #5511 review 1; `billing.ts:660-664`, `:1651-1657`, `:1751-1761` | §4.2 (2). | A: create-a-team does not reuse a customer that has `organization_id`, from the browser or a record. |
| C56 | A refund clause on a request that mints has nowhere to go. | #5511 review 1 | `notice` on `{ kind: "intent" }`. | A: each blocking state and the kept outcome produce a message; a minting response within 14 days of a refund carries `notice`. |
| C57 | Tab 1 pays X after X was ended, and the link links it and syncs a cancelled plan. | 4176267018; #5511 review 1 | §5.6. | A: X `canceled` with a `refund_due` hold: the link makes no `customers.update` or `subscriptions.update` and returns `{ kind: "refused" }` with the clause. A: `findUnfinishedNewOrgSetup` returns the setup with `hold` set, not resumable. **S† (rev 5):** the run stops, its outcome is `failed`, `retryable: false`, with the clause as the message, and the browser record is cleared. No "Subscription active" toast. |
| C58 | The backfill refunds legitimate revenue. | #5511 review 2 | §8 B1–B6. | I†: `reconcile --backfill` holds only the never-live checkout; the others are listed. |
| C59 | A refund in `requires_action` is stuck. | #5511 review 2 | I11. | I: alerts once at 25h, stays `refund_pending`. |
| C60 | The link refuses a paid `incomplete` X, and the org gets no plan. | #5511 review 2 | Link and defer. | A: X `incomplete`, `processing`, no hold: the link writes `organization_id`, returns `{ kind: "linked", planState: "processing" }`, and the row is `community`; then `updated(X, active)` syncs the plan (W). **S† (rev 5):** the run's `done` carries `planState: "processing"`, and the toast is not "Subscription active". |
| C61 | A T4-shaped hold says "a few minutes" for days. | #5511 review 2 | §5.5 by `last_pay`; 14-day bound. | A: `/several business days/`, not `/few minutes/`. I: no age alert at 72h; one at 14 days. |
| C63 | The machine's cancels email "subscription canceled". | #5511 review 2 | §5.3 (4). | W: a stamped `deleted` sends no email and no `subscription_canceled`; an unstamped one does. |
| C64 | **Rev 5 (K3).** A customer who paid gets no receipt. | #5511 reviews 2 and 4 | §5.3 (2): the receipt follows the fresh read; nothing is owed or deferred. | W: `invoice.payment_succeeded` with the fresh read `incomplete`, with an open `closing` hold, sends one receipt. The same with no hold sends one receipt. With the fresh read `canceled`, it sends none. H: T2 sends nothing, and the table has no receipt column. |
| C65 | The operator release races a sweeper step. | #5511 review 2 | T16, `version`. | I: a write prepared on `version` n changes no row after a release committed n+1. |
| C66 | `advanceHold` inside the webhook transaction. | #5511 review 2 | §5.3 nudge. | W: no Stripe write for a held subscription; the sync runs on the first delivery even when the lease is held. |
| C67 | **Rev 5.** A stale holder's closed-out Z writes an org row. | #5511 review 3 | Z has no `organization_id` (§4.4 rule 4). | W: `created(Z, incomplete)` and a `deleted(Z)` stamped `alethia:closeout`, with no `organization_id`, write no row and send no email. |
| C69 | **Rev 5 (N1).** A stale or out-of-order event for X after the link. | #5511 reviews 3 and 4 | N1 (#5514). | W, run against #5514's sync as step 3's precondition: the row names X `active`; a stale `updated(X, incomplete)` and a same-second `incomplete` delivered after `active` each leave X `active`. |
| C71 | An empty payments read released `already_refunded`. | #5511 review 3 | Positive evidence; T11r above T5. | H: as rev 4. |
| C72 | `unrecognised` on an ended subscription matched T10 or T9. | #5511 review 3 | T9 needs `pay ∈ {awaiting, failed}`. | H: as rev 4. |
| C73 | A `refund_pending` hold whose payments read is empty. | #5511 review 3 | T11r. | H: as rev 4. |
| C74 | The nudge made a state write miss. | #5511 review 3 | Hint writes. | I: as rev 4. |
| C75 | A lost attempt increment reused a failed key. | #5511 review 3 | Reservation before the call. | H and I: as rev 4. |
| C76 | **Rev 5 (K4, N2).** The link's own sync writes an `incomplete` snapshot after the webhook applied X `active`. A paid org drops to `community`. | #5511 review 4 | N2 (#5514 / #5518). | Integration test in `billing-sync.test.ts` (#5514's file, as step 3's precondition): the row names X `active` with an event time; a write for X `none` with **no** event time leaves X `active`. Fails on `4a306a0f6`. |
| C77 | **Rev 5 (K2).** A second subscription is linked to an org whose row already names one. | #5511 review 4 | §5.6. | A: the org's row names Y; the link for X returns `{ kind: "refused" }`, makes no Stripe write, writes no row, and alerts with X as the subject. |
| C78 | **Rev 5 (K5).** The sheet creates a team for a setup that cannot be linked. | #5511 review 4; `pending-paid-setup.ts:454`, `:472` | §5.6 sheet (1). | S†: `resolveNewOrgSetup` reports `hold` set; `authClient.organization.create` is not called; the outcome is `failed`, non-retryable, with the notice. |
| C79 | **Rev 5 (K5).** A thrown link error is reported as "Retry … you won't be charged again". | #5511 review 4; `pending-paid-setup.ts:535-545` | §5.6 sheet (4). | S†: a thrown link error is `retryable: true`, and its text does not match `/charged again/`. A typed refusal is never retryable. |

**Retired by rev 5.** These were in rev 4's table and are now about flows §7 lists as not covered:

| Case | What it was about | Why it is retired |
|---|---|---|
| C22 | the AI flow's sweep, holds and live check | AI subscriptions are not covered |
| C23 | hosted Checkout's lock, sweep and earlier sessions | hosted Checkout is not covered |
| C42 | a superseded subscription's late event overwrites a live one | another subscription on the same org; org-plan, not covered. Its receipt half is C64. |
| C43 | ACH straight to `active` in the org-plan flow | the create-a-team half is C24 |
| C44 | a `past_due` org mints a second plan | org-plan |
| C45 | `ensureCustomer` races across the org's flows | org-plan, AI and Checkout |
| C46 | the trial outside the lock | the trial is not covered |
| C62 | a stale holder's Checkout URL or trial | Checkout and the trial are not covered |
| C68, C70 | the trial's `created` event and the gate marker | the trial is not covered (K1) |

That is 63 cases in scope.

---

## 7. Not covered, and why

The maintainer narrowed this design to the first payment of the paid org-setup path (2026-10-04).
Each item below is outside it. The behaviour named is what handles it **today**, at `origin/dev`
`7de07b4e8`, and stays unchanged by this design.

| Not covered | Why | What handles it today |
|---|---|---|
| **Renewals** (`billing_reason = subscription_cycle`) | Not a first payment. A renewal is charged by Stripe on a live subscription, and no purchase flow cancels or voids it. | Stripe collects automatically. `invoice.payment_succeeded` re-syncs the row and sends a receipt (`webhook-handler.ts:147-160`). I2 keeps every hold off a renewal invoice. |
| **Dunning** (a failed renewal) | Not a first payment. Stripe's retry schedule owns it. | `invoice.payment_failed` re-syncs (`past_due` keeps the org on `community`, `sync.ts:124-130`), tries the backup cards (`attemptBackupPayment`, `webhook-handler.ts:163-180`, unchanged for a live subscription) and emails "payment failed". When dunning ends in `canceled`, `customer.subscription.deleted` writes `canceled` / `community` and emails (`:107-113`). |
| **Plan changes, cancels and resumes** on a live subscription | Not a first payment. Nothing is minted beside a live subscription. | `changeSubscriptionPlan` (`billing.ts:2492-…`) updates the live subscription with Stripe's proration. `cancelSubscription` sets `cancel_at_period_end` (`:2474-2479`) and `resumeSubscription` clears it (`:2483-2488`). |
| **The org-plan purchase** (`createSubscriptionIntent`), for an org that already exists | Outside the paid org-setup path the maintainer named. Its holds also need rules this design no longer carries: a superseder rule when two subscriptions name one org (rev 4's W2, K2), the off-Stripe-grant guard, and a live set wider than `PAID_SUBSCRIPTION_STATUSES`. | #5489's memory-less fail-closed path: `withPurchaseLock('org-plan:<org>')`, the `incomplete`-only sweep with `readFirstPayment`, `cancelNeverPaid` / `settleCancelledSubscription` (void, refund, or alert and refuse), and the row check on `active` / `trialing` (`billing.ts:1172-1251`). Its known gaps stay as #5506 lists them, pinned by `billing-subscription.test.ts:575-606`. They include a `past_due` org minting a second plan, a straight-to-`active` ACH subscription unseen until its webhook, and `PAYMENT_MAY_BE_UNDER_WAY`'s "you won't be charged twice". Widening is Q13. |
| **The AI subscription** (`createAiSubscriptionIntent`) | A separate product on an existing org. | No lock, no sweep, no holds (`billing.ts:1261-1315`). The create-a-team sweep no longer touches its `incomplete` subscriptions (I7, C18). |
| **Hosted Checkout** (`createCheckoutSession`) | An existing org's purchase. | No lock and no sweep (`billing.ts:1117-1155`). Stripe expires the session after 24h by default. |
| **The card-less trial** (`startProTrial`), including the create-a-team sheet's trial path | Takes no payment, so there is nothing to hold. | It mints on the org's customer and syncs at once (`billing.ts:1329-1398`). The sheet creates the org, then starts the trial, and rolls the org back if the trial fails (`create-org-sheet.tsx:730-770`). Rev 4's gate and gate marker are withdrawn (K1). |
| **AI credit packs** (`createCreditPackIntent`) | One-off invoices with no subscription. | `billing.ts:2233-2307`. `invoice.payment_succeeded` grants the credits idempotently. |
| **Disputes and chargebacks** | Not a first-payment settlement. | Stripe's dispute flow. No handler in this repo. |
| **Two live subscriptions on one org** (adopted beside a live plan; a Checkout completed beside an embedded purchase) | Produced only by flows not covered. In scope, a new org has one subscription (§5.6). | #5514 (PR #5518) keeps the row on the live one. #5518 names the residual itself: when the row's subscription is cancelled, the other one takes the row only at its next event. No detector exists. Rev 4's §7 detector is withdrawn with the rest of the org-plan scope. |
| **Self-hosted or community deployments with no Stripe** | No payment. | `requireHostedBilling` (`billing.ts:585-591`) refuses first. |
| **Emailing the customer when a hold settles asynchronously** | A decision, Q3. | The next create-a-team response's `notice` (§5.5), and Stripe's own receipt and refund emails. |

---

## 8. Migration and rollout

Each step is a separate PR into `dev`. A step that adds a migration rebases first (CLAUDE.md §5).

1. **The lease (§4.4).** Add `purchase_leases` and a lease helper. The create-a-team flow and the link
   move from `withPurchaseLock('new-org:<user>')` to the `user:<user>` lease, with the fenced renewal,
   the artifact gate and the close-out (§4.4 rules 1–4), and a timeout on the Stripe client of the
   purchase path. `withPurchaseLock` stays for the org-plan flow. **Rolling deploy:** for one release
   the create-a-team flow takes both the lease and the old advisory key, so old and new pods exclude
   each other. The next step's PR removes the advisory half. Tests: L, C25, C28, C52.
2. **The table, the machine and the sweeper, behind no caller.** Add the `payment_holds` migration
   (with the partial unique index), RLS in `programmables.sql`, the store, `advanceHold` as a pure
   transition function over an injected Stripe reader and writer, and `startPaymentHoldSweeper`. With
   no holds written, the sweeper selects nothing. Also settle S7 once in Stripe test mode and record
   the answer in §1.3. Tests: H, I, and the sweeper half of C53.
3. **The webhook (§5.3), before the flow.** **Precondition: #5514 has merged, and its tests include
   N1–N3, including C76 (N2), which `4a306a0f6` fails.** This step does not re-implement them. Its
   C69 and C76 checks re-run them against the merged sync. Then add the backup-retry guard, the receipt
   rule and the stamped-cancel silence. Stamp today's two create-a-team cancels (`billing.ts:1028` as
   the create-a-team sweep calls it, and `:1738`). The nudges are inert until holds exist. Tests: W.
4. **The create-a-team flow, the link and the sheet.** In order:
   - Replace the create-a-team flow's calls to `cancelNeverPaid` and `settleCancelledSubscription`,
     and its `canceled`-prior arm (`billing.ts:1605-1644`), with open → advance. The org-plan flow
     keeps calling the old functions.
   - Classification-filter and fully page the create-a-team sweep. Stop reusing a customer that has
     `organization_id` (`:1651-1657`, `:1751-1761`).
   - Add the live check (§4.3).
   - Make the link typed, hold-aware and one-subscription-per-org, and add `hold` to the resume
     lookups (§5.6).
   - Add the §5.5 composer for create-a-team and `notice` on `{ kind: "intent" }`.
   - **Rev 5:** change `components/org/pending-paid-setup.ts` and `components/org/create-org-sheet.tsx`
     as §5.6 "The sheet" says. This builds on #5522, which lands first and carries `planState` to the
     final view.
   - Flip the create-a-team gap test (`billing-subscription.test.ts:1522-1545`).

   Tests: A, S†.
5. **Operator script and runbook.** Add `scripts/payment-holds.ts`, a section of
   `docs/stripe-prod-runbook.md` covering `list`, `show`, `release` and `reconcile`, and the alert rule
   `system.platform.payment_needs_support`. Without that rule the alert is only a `console.error`
   (`payment-alert.ts:41-43`).

**Backfill.** Our own records cannot supply one: the memory-less code kept no record of what it
cancelled. The sweep shipped in `28544dfbb` (#114, 2026-07-06), and the create-a-team flow has had
it since then. So the listing takes **no lower bound**. Before step 4 deploys, an operator runs
`payment-holds reconcile --backfill`, which is part of step 5's script (so step 5 lands before step 4,
Q7).

**What the backfill may hold.** It must prove "a checkout attempt that ended before it was ever paid",
not "paid and cancelled". A subscription is opened as a hold only when **all** of the following
hold, each read from Stripe:

- **B1, a create-a-team subscription (rev 5).** Its metadata has `created_by` and no
  `organization_id` (§4.2). A linked subscription is an org's, and is not covered. So is any org-plan
  or AI subscription.
- **B2, ended by a request.** `canceled` with `cancellation_details.reason = cancellation_requested`
  (S12), or `incomplete_expired`.
- **B3, never renewed or changed.** Exactly **one** invoice, with `billing_reason =
  subscription_create` (S13), so the invoice checked is the invoice E0 holds (I2).
- **B4, unpaid when it ended.** That invoice is `open`, `uncollectible` or `draft`. Or it is `paid` with
  `status_transitions.paid_at` **after** `ended_at` (S11). Or it has a PaymentIntent that is
  `processing` or `requires_capture`.
- **B5, a card.** Every PaymentIntent on that invoice used a card. A card subscription created
  `default_incomplete` stays `incomplete` until its first invoice is paid, so B4 proves it was never
  live. A bank debit fails B5 on purpose (S4).
- **B6, not a withdrawal.** No `commerce_order` row names it (`lib/db/schema/legal.ts:180`) with state
  `withdrawn` or `refunded`.

Each hit is opened as a hold (`opened_by = backfill`, `open_note` naming the evidence) and advanced at
once. A hold the machine cannot settle reaches `needs_operator`. **Everything else is listed, never
held**: printed with the failed test named, and nothing is written for it (Q12).

**After this release** every create-a-team machine cancel is stamped and has a hold row, so no later
backfill is needed.

**Rollback.** Steps 1 to 5 are code plus two additive tables. A hold left open by a reverted build
blocks nothing, because nothing reads it, and the sweeper advances it after a redeploy.

---

## 9. Open questions for the maintainer

Each question carries a recommended answer. Rev 5 removes Q8 (adopted beside a live plan), Q9 (the AI
lock key) and Q11 (expiring an earlier Checkout Session). Each one asked about a flow §7 no longer
covers.

- **Q2.** The lease row, or the transaction advisory lock with the stated
  `idle_in_transaction_session_timeout` and `poolMax` floor? What is the managed Postgres's current
  `idle_in_transaction_session_timeout` for the service role? **Recommended:** the lease, for the
  `user:` key only (§4.4).
- **Q3.** When a hold settles from the webhook or the sweeper, should the customer get an email now, or
  only the `notice` at their next create-a-team purchase? **Recommended:** an email on
  `released(refunded)` and on the first entry to `refund_pending`. A customer who never tries again
  otherwise hears only from their bank.
- **Q4.** The refund budget and the §5.4 age bounds. **Recommended:** 5 attempts over about 32h, and
  the table as written.
- **Q6.** The webhook event set: subscribe `charge.refund.updated` and `invoice.voided`, and drop the
  runbook's `payment_intent.succeeded` (`docs/stripe-prod-runbook.md:33`)? **Recommended:** yes, all
  three.
- **Q7 (scope).** #5506's `scope:` does not cover:
  - the migration and schema (`lib/db/**`);
  - `programmables.sql`;
  - `instrumentation.ts` and the sweeper;
  - `scripts/payment-holds.ts`;
  - `scripts/stripe-setup.ts`;
  - `docs/stripe-prod-runbook.md`;
  - **(rev 5)** `components/org/pending-paid-setup.ts`, `components/org/create-org-sheet.tsx` and
    `tests/components/org/**`.

  **Recommended:** split into one issue per §8 step, chained, each with the scope it touches.
- **Q10.** Should `refund_pending` block? **Recommended:** no (§3.1).
- **Q12.** Who works the backfill's review list, and is a refund for one of them a support decision per
  case? **Recommended:** yes, per case, with `payment-holds show` as the evidence.
- **Q13 (rev 5).** When should the org-plan purchase get holds? **Recommended:** as a separate ADR,
  after this one ships. It needs the parts of rev 4 this revision removed: the scope column, a
  superseder rule with a fresh read (W1, W2), the off-Stripe-grant guard, and the two-live detector.
  Until then, its gaps stay as #5506 lists them.
