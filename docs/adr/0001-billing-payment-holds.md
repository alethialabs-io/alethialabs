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
cannot mint. One function (`advanceHold`) is the only code that moves a hold. Three callers run it:
the purchase flow under its lock, the Stripe webhook, and a reconcile script. Only an operator
command can release a hold that the machine cannot settle.

This replaces the "refuse without memory" behaviour that #5489 shipped. It is written before any
code, as #5506 requires, and the maintainer reviews it. It meets the ADR bar: a new table and new
webhook behaviour are hard to reverse. A write-ahead row before a Stripe call is surprising without
this context. The alternatives (Stripe metadata as the store, holds written after the fact, one
global hold scope) were real and are recorded below.

Every claim about today's code cites `file:line` at `origin/dev` `857794cb9` (#5489 merged). Paths
are relative to `apps/console/` unless they start with `docs/` or `scripts/` at the repo root.

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
- **S7 (unverified, see Q1).** Stripe is said to refuse to void an invoice while its payment is
  `processing`. The reviewers stated it, and I found no doc that says it. **The design does not
  depend on it.** Every void is followed by a payment re-read.

---

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **Purchase scope** | The product a flow sells, and so the subscriptions it may sweep and the holds it reads: `org_plan`, `new_org`, `ai`. |
| **Payer key** | Who pays for a scope. `org_plan` and `ai` use the org id. `new_org` uses the user id, because there is no org yet. |
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
| `cancel_unproven` | The cancel failed, and a re-read did not show `canceled` or `incomplete_expired`. The subscription may still be `incomplete`, and its invoice may be payable. | yes |
| `payment_in_flight` | The subscription is ended, but a PaymentIntent on the held invoice is `processing` or `requires_capture`. | yes |
| `invoice_payable` | The subscription is ended and no money was taken, but the held invoice is not proven unpayable: a failed void, or a `draft` not yet deleted. | yes |
| `refund_due` | A PaymentIntent on the held invoice `succeeded` after our cancel, and no refund is proven yet. | yes |
| `needs_operator` | The machine cannot settle this hold. Only an operator can release it. | yes |
| `released` | Terminal. The row is kept for audit, with `release_reason`. | no |

`release_reason` is one of the following:

| Reason | When |
|---|---|
| `voided_unpaid` | The held invoice is void and no PaymentIntent on it succeeded. |
| `deleted_draft` | The held invoice was a draft and was deleted. |
| `refunded` | Refunded in full by this machine. |
| `already_refunded` | Stripe reports the charge as refunded already. |
| `adopted` | The subscription went live while it was still ours to keep. Only `closing` and `cancel_unproven` can reach this, because an ended subscription never goes live. |
| `expired_unpaid` | `incomplete_expired`, with the held invoice void or unpaid. |
| `operator` | An operator released it. |

A failed **observation** (a Stripe read error) is **not** an event. It never moves a hold. It only
writes `attempts`, `last_error` and `next_check_at`.

### 3.2 Events

| Event | Raised by |
|---|---|
| **E0 `open`** | The purchase flow, under the lock, just before it voids or cancels a swept or prior subscription. |
| **E1 `observe`** | `advanceHold(hold)` reads the subscription, the held invoice, that invoice's payments (each PaymentIntent), and their refunds. It classifies the result as the observation **O** below. Three callers: (a) a purchase in the hold's scope, under the lock, for **every** open hold in the scope; (b) the webhook, for an event about a subscription or invoice that has an open hold (§5.3); (c) `payment-holds reconcile` for every hold whose `next_check_at <= now()`. |
| **E2 `operator_release`** | The audited operator command (§5.4). |

**O** is a tuple. Each component is read from Stripe in this request:

- `sub`: `incomplete` · `ended` (`canceled` or `incomplete_expired`) · `live` · `missing`
- `inv`: `open` · `uncollectible` · `draft` · `void` · `paid` · `none`
- `pay`: one of the following:
  - `awaiting`: every PaymentIntent is `requires_payment_method`, `requires_confirmation` or `requires_action`, or there is no payment at all
  - `failed`: a PaymentIntent is `canceled`, and none is in flight or succeeded
  - `in_flight(pi)`: `processing`
  - `capturable(pi)`: `requires_capture`
  - `succeeded(pis)`
  - `unrecognised`: a payment that is not a PaymentIntent, or the payment list has `has_more`
- `refunded`: for each succeeded PaymentIntent, whether `amount_refunded >= amount_received`

When the first `observe` of `closing` finds the subscription `incomplete` with `pay = awaiting`, it is
the normal path. The flow then **voids first, then cancels** (§3.4).

### 3.3 Transition table

The rows are evaluated top to bottom, and the first match wins. "→ act" means `advanceHold` performs
the Stripe write, then observes again in the same call, up to a bound of 3 steps per call.

| # | From | Observation / event | Action | To |
|---|---|---|---|---|
| T0 | — | E0 `open`, and the row is written | — | `closing` |
| T0f | — | E0 `open`, and the **write fails** | Nothing is voided or cancelled. The purchase is refused (`UNCONFIRMED`, with no promise of a block). The subscription is still `incomplete`, so Stripe remembers it and the next sweep finds it. | (no row) |
| T1 | any open state | `sub = missing` (`resource_missing`) | alert | `needs_operator` |
| T2 | `closing`, `cancel_unproven` | `sub = live` | none. The flow treats it as a live purchase (§4.3). | `released(adopted)` |
| T3 | `closing`, `cancel_unproven` | `sub = incomplete`, `pay = awaiting` | → act: **void the held invoice**, then **cancel the subscription**. Each step is followed by a re-read, as in `voidPayableInvoice` today. | the next observe decides |
| T3a | `closing` | `sub = incomplete`, and the void or the cancel threw | alert | `cancel_unproven` |
| T4 | `closing`, `cancel_unproven` | `sub = incomplete`, `pay ≠ awaiting` | Nothing. The payment may be under way. The sweep treats it as *kept*. | unchanged (blocks) |
| T5 | any of `closing`, `cancel_unproven`, `payment_in_flight`, `invoice_payable`, `refund_due` | `sub = ended`, `pay = succeeded(pis)` with some not refunded | → act: refund each one (§3.5) | `refund_due`, then `released(refunded)` when proven |
| T6 | (same set as T5) | `sub = ended`, `pay = in_flight(pi)` | none | `payment_in_flight` |
| T7 | (same set as T5) | `sub = ended`, `pay = capturable(pi)` | → act: `paymentIntents.cancel(pi)` (advisory 1 #3) | the next observe decides |
| T8 | (same set as T5) | `sub = ended`, `pay ∈ {awaiting, failed}`, `inv ∈ {open, uncollectible}` | → act: void (S5: a failed PaymentIntent can be confirmed again, so the void comes **before** the release) | `released(voided_unpaid)`, or on failure `invoice_payable` |
| T8d | (same set as T5) | `sub = ended`, `inv = draft` | → act: `invoices.del` (a draft cannot be voided, S2) | `released(deleted_draft)`, or on failure `invoice_payable` |
| T9 | (same set as T5) | `sub = ended`, `inv ∈ {void, none}`, `pay ≠ succeeded`, `pay ≠ in_flight` | none | `released(voided_unpaid)`, or `released(expired_unpaid)` when the status is `incomplete_expired` |
| T10 | (same set as T5) | `sub = ended`, every succeeded PaymentIntent `refunded = true` | none | `released(already_refunded)`, or `released(refunded)` when this hold issued the refund |
| T11 | any open state | `pay = unrecognised`, or `inv = paid` with no succeeded PaymentIntent | alert, with copy per §5.5 (never "no PaymentIntent took the money") | `needs_operator` |
| T12 | `invoice_payable` | the void fails | → act: re-read the payments **once** (advisory 3 #3). `succeeded` goes to T5, `in_flight` to T6, anything else stays. | as matched |
| T13 | `refund_due` | the refund fails and the budget is left (§3.5) | `refund_attempt += 1`, `next_check_at = now + backoff` | `refund_due` |
| T14 | `refund_due` | the refund fails and the budget is exhausted | alert | `needs_operator` |
| T15 | `needs_operator` | E1 `observe` | Observe and record only. It never auto-releases. | `needs_operator` |
| T16 | any open state | E2 `operator_release(reason)` | Write `released_by`, `release_note`, and an audit event. | `released(operator)` |
| T17 | any open state | `sub` reads a status outside these rows (`unpaid`, `paused` on an ended sub, an unknown value) | alert | `needs_operator` |
| T18 | `released` | any event | none (inert) | `released` |

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

### 3.5 Refunds and the 24h idempotency replay (AC2, S6)

- Before every attempt, read the PaymentIntent's latest charge: `amount_refunded`, and
  `refunds.list({ payment_intent })`. If the charge is fully refunded, go to T10. **The read decides,
  not the key.**
- The key is `hold-refund-<pi>-<refund_attempt>`. The attempt number goes into the key so that a retry
  after a *failed* attempt is not replayed as the same failure for 24h. A double refund is
  impossible: a full refund of an already refunded charge is refused by Stripe
  (`charge_already_refunded`), and that already maps to `already_refunded` at `billing.ts:824-826`.
  The read above runs first anyway.
- The budget is 5 attempts with exponential backoff (5m, 30m, 2h, 6h, 24h), then T14. Q4 asks the
  maintainer for these numbers.

### 3.6 Invariants

Each invariant is tested (§6).

- **I1, mint gate.** A purchase in `(scope, payer)` calls `subscriptions.create` only when, under the
  scope's lock: (a) every hold in `(scope, payer)` is `released` after one `advanceHold` pass; (b) the
  sweep of that scope's `incomplete` subscriptions, paged in full, left none open; and (c) no live
  subscription of that scope exists on any customer the payer uses (§4.3).
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
  never acted on again.
- **I7, scope isolation.** A flow reads only holds of its own scope. It routes to resume logic only
  for subscriptions of its own scope, with `created_by` checked (§4.2).
- **I8, copy is true.** Every customer message is derived from the set of hold states and outcomes in
  this request, per §5.5. It claims an alert only when `alertPaymentNeedsSupport` returned true
  (`payment-alert.ts:27-30`). It claims a block only for states that block.

---

## 4. Where each piece of state lives

### 4.1 The `payment_holds` table

The table is new, service-role only, with RLS enabled and no app policy, like the shape in
`04dee418c`. It has these columns, with the changes from `04dee418c` noted:

- `id`
- `subscription_id`: unique
- `customer_id`
- `scope`: `org_plan | new_org | ai`. **New.** It replaces the cross-flow lookup by `user_id`.
- `payer_key`: the org id or the user id. **New**, NOT NULL. Index on `(scope, payer_key) WHERE state <> 'released'`.
- `invoice_id`: **new**, the held invoice (I2)
- `payment_intent_id`: nullable
- `state`
- `release_reason`, `released_at`, `released_by` (a user id, or null for the system), `release_note`
- `refund_attempt`: int, default 0
- `attempts`, `last_error`, `next_check_at`, `alerted_at`
- `customer_notified_at`: when the customer was last told the outcome (§5.5)
- `opened_by_user_id`
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

A subscription is classified from its own metadata:

| Scope | Metadata | Source |
|---|---|---|
| `ai` | `product_type = "ai_subscription"` | `billing.ts:1302` |
| `org_plan` | `organization_id` set, no `product_type` | `billing.ts:1238`, `:1143`, `:1387` |
| `new_org` | `created_by` set, no `organization_id` | `billing.ts:1711`. It becomes `org_plan` once it is linked (`billing.ts:1901-1903`). |

The sweep and the live check filter on scope. Today the org-plan sweep cancels and keeps the AI
flow's `incomplete` subscriptions as well (`billing.ts:1068-1072` lists every `incomplete` one on the
customer). That is AC11.

A hold blocks only its own `(scope, payer_key)`. A payment settling on an AI subscription cannot
double-charge an org plan. So an AI hold does not block an org-plan purchase, and the reverse holds
too. An org-plan hold never reaches `createNewOrgSubscriptionIntent` (AC8).

### 4.3 The live check, against webhook lag (AC12)

Before minting, the flow lists `subscriptions.list({ customer, status: "all" })`, fully paged,
filters it to the flow's scope, and refuses on any **live** one. This list is used instead of
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
connection is held** while Stripe is called. The lease is 120s, with the purchase path's Stripe
client timeout set to 20s × at most 1 retry, so a step cannot outlive the lease. Every hold and mint
write checks `holder` (a fencing token).

If the maintainer keeps the advisory lock instead, the requirements are as follows:

- `idle_in_transaction_session_timeout` must be unset or above 120s for the service role. If Postgres
  kills that session, **the lock is released while `fn` is still running**, and a second purchase can
  enter. The write-ahead holds (I4) still refuse it for any subscription being closed. They do not
  stop two mints.
- `poolMax` must be at least 2 × the number of same-key waiters expected per process.

Both options add a Stripe idempotency key on `subscriptions.create`:
`mint-<scope>-<payer>-<leaseHolder>`.

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
failure (I5).

| Call | On error (429, 5xx, network, other) | Never |
|---|---|---|
| `subscriptions.list` (sweep and live check) | Refuse the purchase (`UNSETTLED`). | mint |
| `subscriptions.retrieve` | `resource_missing` → T1. Anything else is an observation failure, and the hold stays. | read as "gone" |
| `invoices.retrieve` | Observation failure. | read as "void" |
| `invoicePayments.list`, `paymentIntents.retrieve` | Observation failure. | read as "unpaid" |
| `invoices.voidInvoice` | Re-read the invoice once. `void` counts as done (a lost response). Otherwise, from `closing`, T3a. From an ended subscription, `invoice_payable` and T12. | release |
| `invoices.del` (draft) | Re-read. If the draft is gone, done. Otherwise `invoice_payable`. | release |
| `subscriptions.cancel` | Re-read. `ended` counts as done. Otherwise T3a. | mint |
| `paymentIntents.cancel` (`requires_capture`) | Re-read the PaymentIntent. `canceled` counts as done. Otherwise stay `payment_in_flight`. | release |
| `refunds.create` | Re-read the refunds (§3.5). Proven means T10. Otherwise T13 or T14. | release |
| `subscriptions.create` | Throws. The client secret is never returned. The lease is released. | — |

### 5.2 Database writes

| Write | On error |
|---|---|
| E0 hold insert | T0f: nothing is voided or cancelled, and the purchase is refused. The subscription stays `incomplete`, so Stripe keeps the memory. |
| Hold state update after a Stripe write succeeded | The Stripe write already happened, so the row is stale but **still open**. The next observe re-derives the state from Stripe. Because rows never move on stale data, the result is a delay, never a wrong release. |
| Lease acquire | Refuse with `PURCHASE_IN_PROGRESS` (`billing.ts:787-788`). |
| `recordPendingOrgSetup` after the mint | Unchanged (`billing.ts:1728-1743`): cancel the new subscription, throw, and never hand out the secret. That path must take a write-ahead hold too, because it cancels. If it cannot, it leaves the subscription `incomplete` (it was never handed out). |

### 5.3 The webhook (`lib/billing/webhook-handler.ts`)

Three changes. Two of them fix cases that today's code reaches with a hold *or* without one:

1. **No backup-card retry on a held or ended subscription's invoice.** On `invoice.payment_failed`,
   the handler calls `attemptBackupPayment` (`webhook-handler.ts:163-180`), which runs
   `invoices.pay(invoiceId, { payment_method })` with each backup card
   (`lib/billing/payment-methods.ts:67-…`). On a cancelled subscription's still-open invoice (S1), or
   on an `incomplete` first invoice that a sweep is closing, **that is us charging a checkout we
   cancelled**. The fix: skip the retry when the subscription is not live, or when an open hold names
   the invoice. Then call `advanceHold`.
2. **A superseded subscription's events must not overwrite the org row.** `syncSubscriptionToBilling`
   (`lib/billing/sync.ts:93-160`) upserts `organization_billing` unconditionally on
   `organization_id` (`lib/billing/queries.ts:90-118`). A late `invoice.payment_succeeded` or
   `customer.subscription.deleted` for a swept subscription X therefore writes
   `status = canceled, plan = community, stripeSubscriptionId = X` over the live subscription Y. It
   also sends a receipt for X (`webhook-handler.ts:147-160`). The fix: when the row names a different
   subscription that is live, an event for an ended X writes nothing to the row. An event whose
   invoice or subscription has an open hold runs `advanceHold` and sends no receipt.
3. **Events trigger `advanceHold`.** The triggers are `invoice.payment_succeeded`,
   `invoice.payment_failed`, `customer.subscription.updated` and `customer.subscription.deleted`, each
   for a subscription with an open hold. `advanceHold` runs under the payer's lease with a 0s wait. If
   the lease is busy, it does nothing: the purchase holding the lease, or `reconcile`, will act.
   `WEBHOOK_EVENTS` (`scripts/stripe-setup.ts:67-75`) already includes these events. `invoice.voided`
   is handled (`webhook-handler.ts:193-196`) but not subscribed to, and the runbook lists
   `payment_intent.succeeded` (`docs/stripe-prod-runbook.md:33`), which the code does not subscribe
   to. Q6 asks the maintainer to pick one.

### 5.4 Operator commands

The script is `apps/console/scripts/payment-holds.ts`. It follows the `resync-member-tuples.ts`
pattern.

- `list [--open] [--scope …] [--payer …]` and `show <sub>`: read-only.
- `reconcile`: runs `advanceHold` on every hold with `next_check_at <= now()`. Q5 asks whether it
  runs on a schedule. It alerts once when a hold is older than 72h in any blocking state.
- `release <sub> --reason "<text>" --operator <userId>`: T16. It refuses when there is no reason. It
  writes an audit event (`billing.payment_hold.released`) with the before-state. It is the documented
  way out of `needs_operator` and of the `unpaid` or `paused` dead end (AC9).

### 5.5 Customer copy

There is one message per *set*, and every clause in it is true. This covers C26, C29, C31 and C32,
and replaces "the most serious one wins" (`billing.ts:795-804`).

| Present in this request | Clause |
|---|---|
| any hold in `payment_in_flight` | "An earlier payment is still being processed. Nothing new can be started until it settles; a bank debit can take several business days." This is now true (I1). |
| `closing` or `cancel_unproven` (blocking) | "We could not confirm an earlier checkout was closed, so nothing new was started. Try again in a few minutes." |
| `refund_due` | "An earlier payment went through after that checkout was cancelled. Its refund has not gone through yet; nothing new can be started until it has." |
| `needs_operator` | "…contact support at <email>…", plus "we have raised an alert" **only when alerted**. |
| `released(refunded)` in this request, or an un-notified one (`customer_notified_at` null) | It is **appended** to any of the above, never dropped (C26): "An earlier payment was refunded in full; it can take 5–10 business days." |
| T0f (hold write failed) | `UNCONFIRMED` text. It promises no block and no "won't be charged twice". |

"You won't be charged twice" appears **nowhere**, including `PAYMENT_MAY_BE_UNDER_WAY`
(`billing.ts:740-741`), which says it today (C32).

---

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

| ID | Case | Source | Transitions | Test (file: what it asserts) |
|---|---|---|---|---|
| C1 | After the cancel, the PaymentIntent is `processing`, and the retry mints. If the payment succeeds, the customer has paid twice. | 5506; AC1; 4176221898 | T0, then T3, then T6. Retry: E1 on `payment_in_flight`, so I1 refuses. | A: the two-request test at `:575-606`, flipped. The retry is refused and `subscriptions.create` is not called. |
| C2 | After the cancel, the payments cannot be read, twice. | 5506 | T0, T3, then an observation failure (I5). Stays `closing`. | A: the retry is refused. H: a read failure leaves the state and `updated_at` unchanged except `attempts`. |
| C3 | After the cancel, the invoice cannot be voided, so it stays payable. | 5506; AC4; 4176267018 | With void-first: T3a to `cancel_unproven`, or on an ended subscription T8 to `invoice_payable`. | A: a void rejection, then the retry is refused. H: `invoice_payable` plus a void success gives `released(voided_unpaid)`. |
| C4 | After the cancel, the refund fails. | 5506; AC2 | T5 to `refund_due`, then T13. | A: refused. H: the second attempt uses key `-1`. |
| C5 | A payment that is not a PaymentIntent, or `paid` with no PaymentIntent. | 5506 | T11 to `needs_operator`. | H: no refund is called and the copy has no "went through". |
| C6 | Create-a-team passes the same `priorSubscriptionId`. A `canceled` prior with a `paid` invoice is left alone and a new one is minted. | 5506 | Its hold, opened on the first request, is read by scope (I7), with no reliance on `priorSubscriptionId`. A `canceled`, `paid` prior with **no** hold is a finished purchase that was cancelled later, and is left alone. | A: the prior `canceled` with a hold in `payment_in_flight` is refused. With no hold, it mints (the regression guard). |
| C7 | A lost read-to-cancel race across retries, tabs and devices, when the browser lost `priorSubscriptionId` and `customerId`. | AC1; P adv 3 | Holds are found by `(scope, payer_key)` from the session (org id or user id), never from browser input. | A: three variants (same args, no prior, no customer). Each is refused. |
| C8 | The refund's idempotency key replays a saved failure for 24h. | AC2; R2 adv 3 | §3.5: the key carries the attempt number, and the refund read runs first. | H: attempt 0 fails, attempt 1 succeeds, giving `released(refunded)`. A refund already present gives T10 with no `refunds.create`. |
| C9 | A processing payment later succeeds: refund it, tell the customer the truth, release. | AC3 | T6, then (webhook E1) T5, then `released(refunded)`. The next request appends the refund clause and sets `customer_notified_at`. | W: `invoice.payment_succeeded` on a held invoice refunds and sends no receipt. A: the next purchase mints and its copy has the refund clause, once. |
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
| C23 | Hosted Checkout (`createCheckoutSession`) takes no lock and does no sweep. Hosted and embedded at once give two subscriptions. | R3 adv 4 | It takes the `org:` lease. It runs the `org_plan` live check and hold check before creating a session. Sessions created earlier are out of scope (§7). | A: an open `org_plan` hold refuses `createCheckoutSession`. |
| C24 | An `active` subscription not yet seen because of webhook lag, and a second plan is minted. | AC12; R4 adv 1 | §4.3 live check (I1c). | A: `organization_billing` is empty, Stripe lists an `active` `org_plan`, so the flow refuses. |
| C25 | The lock holds a pooled connection inside a transaction. Pool exhaustion, and `idle_in_transaction_session_timeout`. | 5506 "Also"; R3 adv 1; R4 adv 6; R5 adv 4 | §4.4 lease row with fencing. | L: two holders. The second waits without holding a connection, and an expired lease is taken over. A stale holder's hold write is rejected (fencing). |
| C26 | After a refund, the copy still says "may be blocked", and mixed outcomes drop the refund notice. | R1 adv 2; R5 adv 2; 5506 comment (2) | §5.5: the refund clause is appended. | A: one swept subscription refunded and one `in_flight`. The message contains both clauses. |
| C27 | `requires_capture` after the cancel: no refund and no PaymentIntent cancel, so the authorisation holds the card until it expires. | R1 adv 3 | T7. | H: `paymentIntents.cancel` is called, then T8 voids. |
| C28 | Concurrent requests are not serialised (two tabs). | R2 adv 1 | §4.4. Holds are read under the lease. | L, and A's existing `two concurrent org purchases` case, kept. |
| C29 | `NEEDS_SUPPORT` says "went through" when that is not proven (`unrecognised`, a missing subscription). | R2 adv 2 | T1 and T11 copy, §5.5. | H: the copy for T1 and T11 does not match `/went through/`. |
| C30 | The `held.paid` branch is unreachable: a cancelled subscription never becomes active. | R2 adv 5 | T2 applies only from `closing` and `cancel_unproven`. Other states cannot read `live`. If one does, T17. | H: `payment_in_flight` with the subscription `active` gives `needs_operator`, with no refund. |
| C31 | "Our team has been alerted" is false when nothing reached a channel. | 4176778633 | I8. | A: kept from #5489. With the variable unset, the text does not match `/raised an alert/`. |
| C32 | `PAYMENT_MAY_BE_UNDER_WAY` promises "you won't be charged twice". | R5 adv 3; 5506 comment (3) | §5.5. | A: no refusal text matches `/charged twice/`. |
| C33 | A `canceled` prior whose latest invoice is `draft` is a dead end on every retry. | R5 adv 5; 5506 comment (4) | T8d: delete the draft. | H: a draft gives `invoices.del` and `released(deleted_draft)`. |
| C34 | Create-a-team: "canceled + paid + no team → refund" is re-issued through the idempotency replay and refuses for 24h. | #5489 body, "Removed" | Not reintroduced. A refund happens only from a hold (I3), with keys per attempt (§3.5). | A: a `canceled` prior with a `paid` invoice and no hold calls no `refunds.create`. |
| C35 | `priorSubscriptionId` from the browser: a paid subscription is cancelled and its record deleted. | P 4174412523 | It stays fixed (`ownNewOrgSubscription`, `billing.ts:1768-1780`). Holds open only on server-read, `created_by`-checked subscriptions. | A: kept. Plus a prior minted by another user is never held or cancelled. |
| C36 | `incomplete` is not "never paid". | P 4174573734 | T3 and T4 require `pay = awaiting`. | A: kept (`readFirstPayment` cases). |
| C37 | Search indexing lag offers a charged customer a second purchase. | P 4174185555 | Hold discovery is a DB query by `(scope, payer_key)`. It never uses `subscriptions.search`. | H: a hold lookup makes no search call. |
| C38 | A lost `customerId` while the first payment is `processing` leads to a fresh customer and a double purchase. | P ac002 adv 5 | Holds are keyed by payer, not customer. The recorded customers are swept in full (§4.5). | A: no `customerId`, and a hold on another customer, so the flow is refused. |
| C39 | An `incomplete` subscription with zero payments, or with `has_more`, is refused until expiry, and the copy says "a minute". | P adv 4 | The sweep keeps it (T4 equivalent). The copy is §5.5 (no "minute"). | A: a zero-payment `incomplete` is refused, and the copy does not match `/a minute/`. |
| C40 | Records never dropped hide older ones, and OFFSET paging skips a row. | P adv 6; P ac002 adv 2 | Fixed by keyset paging (#5489). Unchanged here. | I: kept (`pending-org-setups.test.ts`). |
| C41 | **New.** `invoice.payment_failed` on a held or ended subscription's open invoice runs `attemptBackupPayment`, which `invoices.pay`s it with a backup card. | New: `webhook-handler.ts:163-180`, `payment-methods.ts:67-…` | §5.3 (1). | W: an ended subscription with an open invoice and a ranked backup card calls no `invoices.pay`, and `advanceHold` runs. |
| C42 | **New.** A late event for a superseded subscription X overwrites the org row of live Y with `canceled` / `community`, and emails a receipt for X. | New: `sync.ts:93-160`, `queries.ts:90-118`, `webhook-handler.ts:147-160` | §5.3 (2). | W: the row names live Y, and `invoice.payment_succeeded`(X ended) leaves the row unchanged and sends no receipt. |
| C43 | **New.** ACH: the subscription goes straight to `active` (S4), so the `incomplete`-only sweep and the row check both miss it. | New: S4; `billing.ts:1068-1072`, `:1181-1189` | §4.3 live check. | A: Stripe lists an `active` `org_plan` with an `open`, processing invoice, so the flow refuses. |
| C44 | **New.** `createSubscriptionIntent` refuses only on `active` / `trialing`, so a `past_due` org mints a second plan. | New: `billing.ts:1182-1185` | §4.3 (live includes `past_due`, `unpaid`, `paused`). | A: a `past_due` org plan refuses. |
| C45 | **New.** `ensureCustomer` races across the org's flows: two customers, one of which is never swept. | New: `billing.ts:633-677`; the AI flow and Checkout are unlocked (`:1261-1315`, `:1117-1155`) | §4.4 shared `org:` key. | A: concurrent AI and org-plan on an org with no customer call `customers.create` once. |
| C46 | **New.** The trial (`startProTrial`) mints on the org customer outside the lock and the hold check. | New: `billing.ts:1329-1398` | It takes the `org:` lease and refuses on an open `org_plan` hold or a live `org_plan`. | A: an open hold refuses `startProTrial`. |
| C47 | **New.** After void-first, `readFirstPayment` reads `incomplete` + `void` + a `canceled` PaymentIntent as `not_proven_unpaid`, which is a 23h dead end. | New: `first-payment.ts:61-74` and §3.4 | The §3.4 rule added to `readFirstPayment`. | new `tests/lib/billing/first-payment.test.ts`: `incomplete`, invoice `void`, PaymentIntent `canceled` gives `never_paid`. |

That is 47 cases: 34 from #5489 and #5506, 6 from #5455, and 7 new.

---

## 7. Out of scope

- **Checkout Sessions created before a hold.** A session already open keeps its own subscription
  creation. Expiring every open session on hold is not designed here. C23 covers only refusing *new*
  sessions.
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
  learns at the next purchase or from Stripe's own receipt or refund email.

---

## 8. Migration and rollout

Each step is a separate PR into `dev`. A step that adds a migration rebases first (CLAUDE.md §5).

1. **The lease (§4.4).** Add `purchase_leases`, then make `withPurchaseLock`
   (`purchase-lock.ts:32-46`) a lease under the same signature, so callers do not change. Keys move
   from `org-plan:<org>` and `new-org:<user>` (`billing.ts:1193`, `:1576`) to `org:<org>` and
   `user:<user>`. Give the purchase-path Stripe client a timeout. Tests: L and C25.
2. **The table and the machine, behind no caller.** Add the `payment_holds` migration, RLS in
   `programmables.sql`, the store, and `advanceHold` as a pure transition function over an injected
   Stripe reader and writer. Tests: H (every row of §3.3) and I.
3. **The purchase flows.** In order:
   - Replace `cancelNeverPaid` and `settleCancelledSubscription` (`billing.ts:919-1049`) with open →
     advance.
   - Change `cancelIncompleteSubscriptions` (`:1066-1090`) to scope-filtered and fully paged.
   - Add the live check (§4.3) to the org plan, AI and create-a-team.
   - Replace the create-a-team `canceled` arm (`:1627-1644`) with the scope's holds.
   - Replace `refusalFor` (`:795-804`) with the §5.5 composer.
   - Flip the two gap-pinning tests (`billing-subscription.test.ts:575-606`, `:1522-1545`).

   Tests: A.
4. **The other org flows.** Bring `createAiSubscriptionIntent`, `createCheckoutSession` and
   `startProTrial` under the `org:` lease, the hold check and the live check. Tests: C22, C23, C45,
   C46.
5. **The webhook (§5.3).** Tests: W.
6. **Operator script and runbook.** Add `scripts/payment-holds.ts` (needs the scope widened). Add a
   section to `docs/stripe-prod-runbook.md` covering `list`, `release` and `reconcile`, and the alert
   rule `system.platform.payment_needs_support`. Without that rule the alert is only a
   `console.error` (`payment-alert.ts:42-43`).

**Backfill.** None is possible. The memory-less code left no record of the subscriptions it cancelled
between #5489's merge and step 3. Before step 3 deploys, an operator runs a one-off listing of
`canceled` subscriptions created since 2026-10-04 whose latest invoice is `open` or has a succeeded
PaymentIntent with no refund. Any hit is settled by hand. This can be a `--since` flag on `reconcile`.

**Rollback.** Steps 1 to 5 are code plus two additive tables. Reverting a step leaves the rows
unused. A hold left open by a reverted build blocks nothing, because nothing reads it, and
`reconcile` releases it after redeploy.

---

## 9. Open questions for the maintainer

1. **Q1 (S7).** Does `invoices.voidInvoice` refuse while a PaymentIntent is `processing`? Checking
   this needs one test-mode run with an ACH or SEPA test PaymentIntent. The design is correct either
   way. If Stripe does refuse, T3 is a true conditional cancel and `payment_in_flight` becomes rare.
2. **Q2.** Should the lease row replace the transaction advisory lock (recommended), or should the
   advisory lock stay with the stated `idle_in_transaction_session_timeout` and `poolMax` floor? What
   is the managed Postgres's current `idle_in_transaction_session_timeout` for the service role? It
   is not set in this repo.
3. **Q3.** When a hold settles from the webhook (a refund issued, or a processing payment failed and
   was voided), should the customer get an email now, or only the clause at their next purchase?
4. **Q4.** What refund budget before `needs_operator`? The proposal is 5 attempts over about 32h. What
   age alert for any blocking hold? The proposal is 72h.
5. **Q5.** Should `reconcile` run on a schedule, and where? There is no cron in the console today that
   I found. Is the webhook plus the next purchase enough?
6. **Q6.** Webhook event set: should `invoice.voided` be subscribed to, since it is handled at
   `webhook-handler.ts:193` but not listed at `scripts/stripe-setup.ts:67-75`? And should the
   runbook's `payment_intent.succeeded` (`docs/stripe-prod-runbook.md:33`) be added to the code or
   dropped from the doc?
7. **Q7 (scope).** #5506's `scope:` does not cover the migration and schema (`lib/db/**`),
   `programmables.sql`, `scripts/payment-holds.ts`, `scripts/stripe-setup.ts` or
   `docs/stripe-prod-runbook.md`. Widen it, or split the steps in §8 into issues with their own
   scopes?
8. **Q8.** Should a `released(adopted)` org-plan subscription (C17) whose org already has a different
   live plan be cancelled for the customer, or alerted on for an operator? The proposal is to alert
   only: the machine never cancels a live subscription.
9. **Q9.** Is the `org:` lease key acceptable for the AI flow, so that an org-plan purchase and an AI
   purchase in two tabs run one after the other? Or should the AI flow keep its own key and a
   separate guard on `ensureCustomer`?

