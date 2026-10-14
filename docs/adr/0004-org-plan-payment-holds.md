---
status: "Proposed"
issue: "#5976"
parent: "#5506"
date: 2026-10-14
---

# Payment holds for the org-plan purchase

**Decision (proposed).** The org-plan purchase (`createSubscriptionIntent`) gets payment holds. Before it makes an
earlier org-plan subscription unpayable (voids its invoice or cancels it), it writes a hold row first, as the
create-a-team purchase has done since ADR 0002 S8. The state machine is ADR 0002's, unchanged: `advanceHold`
moves every hold, under its payer's lease, and nothing else does. This ADR adds what ADR 0002 rev 5 removed when it
narrowed its scope (ADR 0002 §7, Q13):

1. **A hold scope per flow.** `payment_holds` gains a `scope` column (`new_org`, `org_plan`). Every hold is
   keyed, fenced, swept and read by `(scope, payer_key)`. An org-plan hold never blocks or reroutes a
   create-a-team purchase, and the reverse also holds (AC 8, §3 D1).
2. **The org-plan purchase on holds.** It mints only through I1 for its scope: advance the org's holds, close
   the org's own unpaid checkouts under a hold, then a live check read last (§3 D2). It moves from a
   transaction-held advisory lock to a lease row, `org-plan:<orgId>`, with ADR 0002's fence, artifact gate and
   close-out (§3 D3).
3. **The superseder rule with a fresh read.** When the subscription the org's row names ends, or when a live
   subscription's write is refused, the row is reconciled against a fresh Stripe read. This is rev 4's W1 and
   W2, reduced to what the merged #5518 guard does not already do (§3 D4).
4. **The off-Stripe-grant guard.** No org-plan purchase flow mints beside a live off-Stripe grant (§3 D5).
5. **The two-live detector.** Two live org-plan subscriptions on one org raise an operator alert at the moment
   the row can see them. The detector never cancels anything (§3 D6).
6. **A `past_due` org cannot mint a second plan.** It is sent to fix its payment method instead (Q13, §3 D7).

**Scope.** The org-plan purchase `createSubscriptionIntent`, and the parts of `createCheckoutSession`,
`startProTrial` and the Stripe webhook that write the same org-plan row slot. The AI subscription, credit packs,
renewals, dunning and plan changes stay out (§8).

**Prerequisites, not redesigned here.** ADR 0002 §10.2 split two small fixes off F1. They are being built
separately, and this design builds on them as they are specified:

- **F2** (ADR 0002 §10.2, AC 11): the org-plan sweep cancels or keeps only org-plan subscriptions, never an AI
  one; `createAiSubscriptionIntent` takes `ai:<org>`, and `createCheckoutSession` takes `org-plan:<org>`.
- **F3** (#5977, AC 12): `createSubscriptionIntent` and `createCheckoutSession` list the org customer's
  subscriptions, fully paged, before minting, and refuse beside a live org-plan one (`active`, `trialing`,
  `past_due`).

Where this ADR changes something F2 or F3 ships (the `org-plan:` advisory key becomes a lease, F3's live set is
widened, F3's check moves to after the sweep), the slice that does it says so (§11).

**Citations.** Every claim about today's code cites `file:line` at `origin/dev` `6f050e0b7` (2026-10-14). Every
path is relative to `apps/console/`, except this ADR's own folder, `docs/adr/`, and §11's `scope:` globs, which
are relative to the repo root. "ADR 0002 §n" and "0002-Cn" name that ADR's sections and cases. The `C` numbers in
§7 are this ADR's own.

## Revisions

- **Rev 1** (2026-10-14). The first draft, written before any code, as #5506 and ADR 0002 Q13 require.

---

## 1. Context

### 1.1 What the org-plan purchase does today

- **The flow.** `createSubscriptionIntent` (`app/server/actions/billing.ts:1486-1515`) refuses the personal scope
  (`:1492-1494`). It refuses when the org's row names a subscription whose status is `active` or `trialing`
  (`:1495-1503`). It runs the open-setup guard (`:1506-1507`, ADR 0002 §5.7), then
  `withPurchaseLock('org-plan:<orgId>')` around `startOrgSubscription` (`:1511-1513`). The body
  (`:1521-1573`) resolves the customer (`ensureCustomer`, `:682-726`), sweeps (`:1535`), mints with
  `metadata: { organization_id }` (`:1553-1562`), and returns the client secret (`:1564-1572`). No fenced write
  stands between the mint and the return.
- **The sweep.** `cancelIncompleteSubscriptions` (`billing.ts:1381-1401`) lists every `incomplete` subscription
  on the customer, fully paged up to 1000 (`listCustomerSubscriptions`, `:1324-1344`). It does not classify, so
  an AI checkout on the same customer is swept too (F2's subject). A subscription that `readFirstPayment` does
  not prove `never_paid` is kept, and the purchase refuses (`:1385-1395`, `:1540-1541`).
- **Cancel, then prove, then forget.** `cancelNeverPaid` (`billing.ts:1281-1310`) **cancels first**
  (`:1287-1289`), with no `cancellation_details` stamp. It then voids or refunds through
  `settleCancelledSubscription` (`:1150-1171`, body `:1177-1258`). Nothing is recorded. The `PaymentOutcome`
  docblock says so: "NOTHING HERE IS REMEMBERED BETWEEN REQUESTS: the org-plan purchase opens no payment hold
  (ADR 0002 §7)" (`:728-748`). A test pins the gap: the retry after a refusal mints
  (`tests/actions/billing-subscription.test.ts:725-760`).
- **The copy promises what nothing enforces.** `PAYMENT_MAY_BE_UNDER_WAY` says "you won't be charged twice"
  (`billing.ts:793-794`). ADR 0002 removed that sentence from create-a-team (0002-C32), and kept it here (ADR
  0002 §5.5, last paragraph).
- **The lock.** `withPurchaseLock` (`lib/billing/purchase-lock.ts:32-46`) holds a pooled connection in an open
  transaction for the whole Stripe sequence, plus up to 30s waiting (`:22`). The org-plan fence is `UNFENCED`
  (`lib/billing/purchase-lease.ts:64-68`, used at `billing.ts:1535`). The create-a-team flow left this lock for
  the lease row (`purchase-lease.ts:1-24`, `billing.ts:1910-1922`).
- **Hosted Checkout has no row check at all.** `createCheckoutSession` (`billing.ts:1428-1469`) runs the
  open-setup guard and the eligibility gate, then mints a session. It reads no billing status, takes no lock,
  and does not sweep. The session carries the org only inside `subscription_data.metadata` (`:1456-1457`), and a
  Team session starts a 30-day trial (`:1460`). On `dev`, an org with a live plan can open a second plan through
  Checkout. F3 closes the mint half.
- **The trial.** `startProTrial` (`billing.ts:1651-1723`) refuses when the row names an `active` or `trialing`
  subscription (`:1691-1697`). It mints a `trialing` subscription and syncs it at once (`:1706-1716`). It takes
  no lock.
- **`past_due` is not "has a plan" to any of the three.** Each row check names only `active` and `trialing`
  (`billing.ts:1497-1498`, `:1693-1694`; Checkout has none). So an org whose plan is `past_due` can mint a second
  plan. Stripe's `unpaid` maps to `past_due` too (`lib/billing/sync.ts:51-53`).
- **An off-Stripe grant is invisible to the row checks.** The operator plane's grant (`setOrgPlan`,
  `lib/platform/provision.ts:162-176`) writes a live `plan` and `status` through `upsertOrgBilling`
  (`lib/billing/queries.ts:101-131`), with `stripeSubscriptionId` null. Both row checks require a subscription
  id (`billing.ts:1497`, `:1693`), and Checkout has none, so all three flows proceed beside a grant. Once the new subscription is paid
  (`active` or `trialing`), the row guard lets it replace the grant (`queries.ts:262-264`: "a PAID one
  superseding an unpaid / subscription-less row", block comment `:151-154`). The trial's own sync applies a
  `trialing` subscription at once (`billing.ts:1716`). That path is reachable only when the actor owns no org
  whose row is `active` or `trialing`, because `accountHasLiveSubscription` refuses otherwise
  (`billing.ts:1688-1690`, `:1730-1740`). An unpaid subscription does **not** replace a grant (tested,
  `tests/integration/billing-sync.test.ts:367`). Nothing tests the paid case.
- **The row guard (#5514, as merged in #5518 and #5549).** `applySubscriptionToBilling`
  (`queries.ts:296-344`) decides in one statement. The same subscription applies unless the event is older than
  the watermark, or a write with no event time would lower the lifecycle rank (`sameSubscriptionMayApply`,
  `:241-250`). A different subscription applies only when the row holds nothing live, or when it is paid and the
  row holds `past_due` or no subscription id (`subscriptionMayApply`, `:257-266`). An ended write touches only the
  row that names it (`:315-328`). **The guard decides from the row's stored status, never from a fresh read of
  the subscription the row names.**
- **What the webhook reads fresh.** `customer.subscription.created` and `.updated` sync a fresh
  `subscriptions.retrieve` of the event's subscription (`lib/billing/webhook-handler.ts:293-308`), as do
  `checkout.session.completed` (`:331-341`) and both invoice events (`subForInvoice`, `:221-227`).
  `customer.subscription.deleted` syncs the event's own snapshot, and mails "subscription canceled" only when
  the deletion reached the row (`:309-325`). Nothing re-reads the **other** subscription when a write is
  refused, and nothing re-points the row when its subscription ends.
- **Holds are create-a-team only.** `payment_holds` has no scope (`lib/db/schema/payment-holds.ts:80-159`).
  `payer_key` is a user id (`:87-90`). The state-write fence hard-codes the payer's lease as `'user:' ||
  payer_key` (`lib/billing/payment-holds/store.ts:59-69`), and so do `payerLeaseKey` (`:47-50`), `openHold`'s
  check (`:114`), the sweeper's visit (`lib/billing/payment-holds/sweeper.ts:261`) and the operator script
  (`scripts/payment-holds.ts:244`, `:553`). The create-a-team readers select by `payer_key` alone
  (`paymentHoldsOfPayer`, `lib/billing/pending-org-setup.ts:203-222`) or by subscription alone
  (`openPaymentHoldOn`, `:177-184`; `latestReleasedHoldOn`, `:187-195`). A release closes the
  `pending_org_setups` row that names the hold's subscription (`store.ts:269-283`). The Q3 emails go to the user
  whose id is `payer_key` (`lib/billing/payment-holds/emails.ts:161-173`).
- **What the webhook does with holds is already scope-free.** Every hold lookup there is keyed on the event's
  own subscription and invoice (`webhook-handler.ts:27-39`, `:111-172`): the backup-card skip on a held invoice
  (`:397-411`), the receipt rule for a held invoice on an ended subscription (`:365-379`), the stamped-deletion
  silence (`:206-211`, `:319`), and the nudges. They apply to an org-plan hold as they are.

### 1.2 What ADR 0002 left here

ADR 0002 rev 4 designed holds for every purchase flow. Rev 5 narrowed it to create-a-team (maintainer decision,
2026-10-04), and the org-plan part became Q13: "it needs the parts rev 4 had and rev 5 removed: the scope column, a
superseder rule with a fresh read (W1, W2), the off-Stripe-grant guard, and the two-live detector" (ADR 0002 §9 Q13,
§7 "The org-plan purchase"). Rev 4's review K2 (thread `PRRT_kwDOPdRG6s6o0ENR`) raised two sequences, closed then
by the narrowing and still open on `dev`:

- **Sequence 1, two live subscriptions.** The row names live Y, and X is live too, so X's writes are refused. Y
  ends. Y's deletion writes `canceled` / `community`. Nothing moves the row to X until X's next event, up to a
  billing period away. The org pays for X and runs on `community`. Its next purchase is refused (X is live), and
  `changeSubscriptionPlan` acts on the row's subscription (`requireSubscriptionId`, `billing.ts:3473-3479`),
  which is the cancelled Y.
- **Sequence 2, an off-Stripe grant.** §1.1 above.

Rev 4's W1–W5 (ADR 0002 at `66c0c25b3`, §5.3 (2)) were written before #5518. #5518 and #5549 delivered N1–N3 (ADR
0002 §5.3 (2)), W3, W4 and W5. Of W1 and W2, two halves remain undone, and D4 adds exactly those:

| Rev 4 rule | Status on `dev` | This ADR |
|---|---|---|
| W1, decide from a fresh read of the **event's** subscription | Done for `created`, `updated`, `checkout.session.completed` and the invoice events (`webhook-handler.ts:300-303`, `:335-338`, `:221-227`). `deleted` uses its snapshot, which is safe: `canceled` is terminal. | unchanged |
| W1, decide from a fresh read of the subscription **the row names**, when it is a different one | Not done: the guard reads the stored status (`queries.ts:257-266`). | D4 (R2) |
| W2, a live row is replaced only by its superseder | Done for every status but `past_due` and a grant, which a **paid** X supersedes (`queries.ts:262-264`). | kept as built (D4, D5, D7 say why) |
| W2, both live: keep Y, and the two-live detector alerts | Keeps Y; no detector. | D6 |
| W4 fix from K2: when the row's subscription ends, name a live sibling | Not done. | D4 (R1) |

### 1.3 Facts about Stripe

ADR 0002 §1.3 S1–S15 hold unchanged here, with the same caveats. Two more are used:

- **S16 (not re-read for this revision).** A Checkout Session's `expires_at` can be set between 30 minutes and
  24 hours after creation, with 24 hours as the default, and `checkout.sessions.expire` makes an `open` session
  unusable (docs.stripe.com/api/checkout/sessions/create, `expires_at`; `/expire`). D3 shortens the window. It does not
  depend on the exact minimum, because every session is also expired before a new purchase (D2, I1 (a′)).
- **S17 (unverified; an O4 task, against the pinned `stripe` SDK types).** A Checkout Session carries
  its own `metadata`, separate from `subscription_data.metadata`, and `checkout.sessions.list` filters by
  `customer` and `status`. Classifying a session needs the session-level key, which `createCheckoutSession` does not write today (`billing.ts:1452-1466`).
  If the list cannot filter by status, (a′) pages the customer's sessions and filters in code; nothing else
  depends on it.

---

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **Scope** | The product a hold is about: `new_org` (create-a-team, ADR 0002) or `org_plan` (this ADR). Written at E0 and never changed. |
| **Payer key** | Who pays in that scope. `new_org`: the user id. `org_plan`: the org id. The pair `(scope, payer_key)` is the key. `payer_key` alone is never a key. |
| **Lease key** | `leaseKeyFor(scope, payer_key)`: `user:<payer>` for `new_org`, `org-plan:<payer>` for `org_plan`. One function, used by the store's fence, the sweeper, the operator script and every flow. |
| **Org-plan subscription of O** | A subscription whose **own** metadata has `organization_id = O` and no `product_type` (`billing.ts:1560`, `:1457`, `:1712`). A linked create-a-team subscription carries `organization_id = O` too (`sweeper.ts:388-392`), so it is one (ADR 0002 §2: "it becomes an ordinary org subscription once the link writes `organization_id`"). An AI subscription (`product_type = "ai_subscription"`, `billing.ts:1624`) is not. Neither is another org's subscription on a shared customer. The customer is never evidence. |
| **Live** | ADR 0002 §2's set: `active`, `trialing`, `past_due`, `unpaid`, `paused` (`LIVE_SUBSCRIPTION_STATUSES`, `billing.ts:2196-2202`). |
| **Paid** | `active` or `trialing` (`isBillingActive`, `lib/billing/plan.ts:80-82`). The row guard's superseder test uses this set (`queries.ts:262`). |
| **Off-Stripe grant** | An org row whose `stripeSubscriptionId` is null and whose status is `active`, `trialing` or `past_due`. It is **live** unless `isManualGrantExpired` (`plan.ts:94-103`) says its term has passed. |
| **Row slot** | The org-plan columns of `organization_billing`: `stripeSubscriptionId`, `status`, `plan`, the event watermark. Only the guarded write writes them for Stripe (`queries.ts:296-344`). |
| **Two-live** | Two org-plan subscriptions of one org that read live in Stripe at the same time, or one that reads live beside a live off-Stripe grant. |

---

## 3. Decisions

Each decision states the alternative it rejects. The rule for choosing is ADR 0002's: the answer friendliest to
the SRE paying, where it is also safe. Money correctness, security and tenant isolation win every tie.

### D1. A hold scope per flow (AC 8)

**Decision.** `payment_holds` gains `scope text NOT NULL DEFAULT 'new_org'`, checked to `('new_org',
'org_plan')`. The open-payer index becomes `(scope, payer_key) WHERE state <> 'released'`. Every existing row is
`new_org`, which is true by construction: every opener on `dev` is create-a-team (`opened_by` is `purchase`,
`backfill` or `link`, `schema/payment-holds.ts:63-64`, and all three are ADR 0002's).

The scope is enforced in five places:

1. **The fence.** The state-write fence requires the lease named by `leaseKeyFor(scope, payer_key)`, computed in
   the same statement (`store.ts:59-69` today hard-codes `'user:'`). A request holding `user:U` can never write an
   org-plan hold, and a request holding `org-plan:O` can never write a create-a-team hold.
2. **The open.** `openHold` takes `scope`, and refuses a lease whose key is not `leaseKeyFor(scope, payerKey)`
   (`store.ts:114` today checks `user:` only).
3. **The create-a-team readers.** The readers that **block or route** a create-a-team purchase read
   `scope = 'new_org'` only: `paymentHoldsOfPayer`, `openPaymentHoldOn` and `latestReleasedHoldOn` as the link, the
   resume lookups and the guard's creator copy call them (`pending-org-setup.ts:177-222`; `billing.ts:994-1000`).
   The org-plan flow has its own reader with `scope = 'org_plan'`.
4. **The setup predicates that wait on holds stay scope-free, on purpose.** The closer's "no open hold names X"
   (`noOpenHold`, `pending-org-setup.ts:848-850`, ADR 0002 I16) and `forgetPendingOrgSetup`'s hold condition
   (`:166-167`) keep matching every scope. Narrowing either could only close or forget a setup the design means to
   keep. A release closes a setup only when the released hold is
   `new_org` (`store.ts:269-283` gains the scope test).
5. **The sweeper, the script and the emails** take the lease by `leaseKeyFor` (`sweeper.ts:261`,
   `scripts/payment-holds.ts:244`). They list and filter by `--scope`, re-link only `new_org` adoptions
   (`relinkAfterVisit`, `sweeper.ts:629`), and send the Q3 email to the scope's recipient (D8).

**Why a column and not a key prefix in `payer_key`.** A prefix would make every create-a-team query on `dev`
silently wrong (they compare `payer_key` to a bare user id) and give the check constraint nothing to check. With
a column and a default, every existing row and query stays correct until a slice changes it.

**Why not a separate table.** The machine, the store's three write kinds, the sweeper, the webhook's lookups,
the age alerts and the operator commands are all scope-free (§1.1, last bullet). A second table would duplicate
all of them. The partial unique index on `subscription_id` (one open hold per subscription, ADR 0002 I6) must
also hold **across** scopes, because the same subscription can be met by both flows (D2, rule 4). Only one table
can enforce that.

### D2. The org-plan purchase on holds

**Decision.** Under the `org-plan:<O>` lease (D3), `createSubscriptionIntent` calls `subscriptions.create` only when,
in this order (I1 for `org_plan`):

- **(row)** The row checks of D5 and D7 pass, before the lease is taken: no live Stripe plan on the row, no
  `past_due`, no live grant.
- **(a) Holds.** Every open `org_plan` hold of O, advanced once by `advanceHold`, is `released` or
  `refund_pending` (ADR 0002 Q10 holds here too). Released `refunded` holds within 14 days are kept for the
  notice (D8).
- **(a′) Earlier Checkout sessions.** Every `open` subscription-mode Checkout Session on O's customer whose own
  `metadata.organization_id` is O is expired, then re-read (S16, S17). A re-read showing `complete` means the
  customer finished it first: its subscription now exists, and (b) and (c) see it. One still `open` refuses
  (`UNSETTLED`). A session without that key predates this design, is left alone, and expires on its own within
  24h of its creation (Stripe's default). The detector (D6) covers one that completes.
- **(b) The sweep.** Every `incomplete` subscription on O's customer, fully paged (F2's boundary): an org-plan
  subscription of O is closed **only under a hold** (ADR 0002 I4), written first in `closing`. The machine then
  voids, and cancels only after a proven void (ADR 0002 §3.4), stamped `alethia:checkout_closed:<hold id>`
  (`machine.ts:669`). One that `readFirstPayment` does not prove `never_paid` is kept, untouched, and refuses.
  Four exclusions apply:
  1. An AI subscription is not touched (F2).
  2. Another org's subscription on a shared customer is left alone and alerted on, as ADR 0002 §4.2 (1) does.
     The purchase is not refused for it.
  3. A subscription with **no** `organization_id` is not O's. The ones this repo mints are unlinked create-a-team
     subscriptions (ADR 0002 §2), which that flow's holds own. It is never touched here.
  4. A subscription that an open hold of **another scope** names (a linked create-a-team X under a `new_org`
     hold) is kept, untouched. The purchase refuses with the neutral clause (D8), because that hold decides X.
     Without this rule, the E0 insert would conflict on the cross-scope unique index (ADR 0002 T0h), and the
     result would be the same refusal with a less precise message.
- **(c) The live check, read last.** A full `subscriptions.list({ customer, status: "all" })` of O's customer,
  filtered to org-plan subscriptions of O, finds none **live** (§2). This is F3's check, moved after (a)–(b) and
  widened from `active`/`trialing`/`past_due` to the full live set. A subscription adopted in (a) is seen here.
  `active` and `trialing` refuse with "change the plan instead". `past_due` and `unpaid` refuse with D7's copy,
  and `paused` with the contact-support copy.

The mint then follows ADR 0002 §4.4 rules 1–4: renew before every Stripe write, the mint deadline, the artifact gate
before the client secret leaves, and the close-out after a failed gate. The close-out voids, then cancels stamped
`alethia:closeout`, and writes no hold. With (b), **at most one payable org-plan artifact exists per org at a time**
(I9 for `org_plan`). The org-plan flow then stops calling `cancelNeverPaid` and `settleCancelledSubscription`
(`billing.ts:1150-1310`). They, `cancelIncompleteSubscriptions`, `voidPayableInvoice`, `refundTakenPayment`,
`refusalFor` and `PaymentOutcome` then have no caller (each is used only on this path today), and are deleted.

**Classification of a linked create-a-team subscription (Q1).** An org-plan subscription of O, linked or not, is
O's: the org-plan sweep may close a linked, never-paid X under an `org_plan` hold (payer O). That matches ADR 0002 §4.3
("a linked one … belongs to the new org"), and it matches what `dev` does today for any `incomplete` subscription on
the org's customer. The alternative, keeping every linked X until it expires (about 23h, ADR 0002 S3), would block
an SRE who abandoned the setup's payment and came back to buy, for a day, to protect a payment the read just proved
never happened.

**Adoption.** A hold that the machine releases `adopted` (ADR 0002 T2, T2o) means X went live while the flow was
closing it. X is then the org's plan, and (c) refuses the purchase with "change the plan instead". No re-link runs
and no Q3 adoption email is sent (D8): there is no setup to finish, and Stripe's receipt and the plan welcome speak.

**Rejected: keep the memory-less path and only fix its copy.** The gap at
`billing-subscription.test.ts:725-760` is a double charge, not a copy defect. A payment that starts processing
between the read and the cancel is forgotten, and the retry mints beside it.

### D3. The `org-plan:<O>` lease, and who takes it

**Decision.** `createSubscriptionIntent` and `createCheckoutSession` move from the advisory lock (F2 gives
Checkout `org-plan:<org>` on `withPurchaseLock`) to a `purchase_leases` row keyed `org-plan:<orgId>`
(`purchase-lease.ts:77-166`). The org-plan purchase client (`getPurchaseStripe`, `lib/billing/stripe.ts:51`, with
`STRIPE_REQUEST_TIMEOUT_MS` and one retry, `:27`, `:30`) replaces the shared client on the purchase path.
`startProTrial` takes the same lease for serialisation only: it runs (row), (a) and (c), and refuses on a blocking
hold or a live org-plan subscription. It neither sweeps nor gates (Q5).

**Why the lease.** A hold's state writes are fenced on a `purchase_leases` row (ADR 0002 §4.1). An advisory lock
cannot fence them, and it holds a pooled connection for the whole Stripe sequence (§1.1, "The lock").

**Why Checkout moves with it, in the same slice.** An advisory lock and a lease row on the same name do not exclude
each other. If only one flow moved, an intent and a Checkout in two tabs would stop excluding each other.

**Rolling deploy.** For one release, both flows take the lease **and** the old advisory key, as ADR 0002 S2 did
for create-a-team (§8 step 1 there). The release after drops the advisory key, and deploys only after the first
one's rollout has completed (§9).

**Checkout's artifact.** The URL is the payable artifact. Its gate runs after `checkout.sessions.create` and before
`session.url` is returned. Its close-out is `checkout.sessions.expire`. The session is created with its own
`metadata.organization_id` (S17) and an `expires_at` 30 minutes out (S16, Q8), so a URL that leaves the server
stays payable as briefly as Stripe allows.

**The AI flow keeps F2's `ai:<org>` advisory key.** It writes the AI slot only (`sync.ts:141-146`, `:215-234`), so
it cannot take the org-plan row, and it opens no holds (§8).

### D4. The superseder rule with a fresh read

**Decision.** The merged row guard (`queries.ts:241-266`) stays as it is. It is one atomic statement, it is tested
(`billing-sync.test.ts:132-367`), and ADR 0002's N1–N3 rest on it. Two reconciliations run around it, each from a
fresh Stripe read, in one new module (`lib/billing/org-plan-row.ts`):

- **R1, re-point on end.** When `customer.subscription.deleted` for Y **applied** to O's row (`webhook-handler.ts:316`
  returned `"applied"`), the handler lists O's customer, fully paged, filters to org-plan subscriptions of O that
  read **live**, and syncs one with no event time: the newest **paid** one by `created`, else the newest live one.
  The row now reads `canceled`, which is not live, so the guard lets a different subscription take it
  (`queries.ts:265`). A `past_due` sibling is named rather than left out, so the customer sees its unpaid invoice
  instead of a blank `canceled`. With two or more live, R1 still names one, and raises the two-live alert (D6).
  With none, the row stays `canceled` / `community`, as today. When R1 named a paid subscription, the
  "subscription canceled" email and the `subscription_canceled` revenue event for Y are not sent, because the
  org's plan did not end. Y's deletion is still written.
- **R2, re-read the row's subscription on a refused live write.** When a sync of an org-plan subscription X that
  reads **live** returns `"ignored"` (`sync.ts:171-174`), and the row names a different subscription Y, R2 retrieves
  Y. If Y reads **ended**, R2 syncs Y (its `canceled` applies to the row that names it, `queries.ts:315-328`) and
  then syncs X again, which now applies. If Y reads live, the row stays on Y, and the two-live alert is raised (D6).
  If the row names no subscription (a grant), R2 does nothing but D6.

**Where they run.** R1, R2 and D6a run in the webhook handler, after its own sync calls, and nowhere else. A
server action's sync (the link, the trial) keeps its own handling: the link already refuses and alerts beside a live
plan (ADR 0002 §5.6). D6b runs inside the guarded write, so it sees every caller (D6).

**Why both.** R2 alone misses the K2 sequence 1 order: X's last event was refused while Y was still live, and Y
ends later with no X event to follow. R1 alone misses a Y that ended in Stripe while its `deleted` delivery is late
or failing. Then every X event in between is refused, from a stored status that is no longer true.

**A read that fails throws.** In R1 or R2, a failed Stripe read fails the event before any email is sent, and Stripe
redelivers it (`app/api/webhooks/stripe/route.ts:60-80`; ADR 0002 §1.1 "Webhook redelivery"). The re-run is safe:
Y's `canceled` is idempotent on the row that names it, and X's write is guarded.

**Rejected: rev 4's strict W2 (a `past_due` Y or a grant is replaced only once it is no longer live).** That would
reverse #5518's tested rule (`billing-sync.test.ts:348`). And on `dev`, a create-a-team X must be able to take a row
that holds a grant or a `past_due` Y: 0002-C77 and the link's refusal set (`namesOtherLivePlan`, `sweeper.ts:329-335`,
which needs a subscription id) are built on it. With D5 and D7 in place, an org-plan flow never mints beside either.
What remains reaches the row only through a race or a create-a-team link, and D6 reports it.

**Rejected: rev 4's W1 for every write (retrieve both subscriptions on every event).** It doubles the Stripe reads of
every webhook to answer a question that matters only when the guard refuses a live write or the row's subscription
ends. R1 and R2 make the read exactly then.

### D5. The off-Stripe-grant guard

**Decision.** `createSubscriptionIntent`, `createCheckoutSession` and `startProTrial` refuse, before the lease
and before any Stripe call, when O's row is a **live** off-Stripe grant (§2). A lapsed grant (`isManualGrantExpired`)
does not refuse: its term is over, and buying is the way back to a plan. The copy says the team's plan is managed
under a contract, and names support (D8). One predicate, `orgRowBlocksNewPlan(row)`, carries the row's three refusals
(a row naming an `active` or `trialing` subscription, D7's `past_due`, and this one), so the three flows cannot
disagree. Checkout, which has no row check today, gains all three.

**The row rule stays (Q2).** A paid Stripe subscription still takes a row that holds a grant (`queries.ts:262-264`).
If one ever does, through a race with `setOrgPlan` or a create-a-team link beside a grant, D6 alerts with both named.

**Rejected: make a live grant "owned" in the row guard (the K2 review's fix).** A create-a-team X linked beside a
grant would then be paid, live, and never on the row. The link's refusal (`namesOtherLivePlan`) does not see a grant,
because it needs a subscription id, so the link would mark X linked. That reopens the stranded-X defect ADR 0002
spent rev 5.1 and rev 7 closing (0002-C80, I14). The purchase-side guard prevents the org-plan sequence without that
cost.

### D6. The two-live detector

**Decision.** One function, `reportTwoLive(orgId, a, b)`, raises `system.platform.payment_needs_support` through
`alertOperator` (`billing.ts:858-879`, with its own summary, never `alertPaymentNeedsSupport`'s "which the purchase flow
cancelled" text). The newer subscription is the subject, so the alert rule's throttle collapses repeats. It also logs
`billing.org_plan.two_live` with both ids. It runs at three points, and nowhere else:

| Point | Seen when | Cost |
|---|---|---|
| **D6a**, R2 finds Y live | a live X's write was refused beside a live Y | the one retrieve R2 already makes |
| **D6b**, a write **replaced** a live subscription | a paid X took a row that named a different `past_due` Y, or a live grant (`queries.ts:262-264`) | no Stripe call. The guarded write reports the subscription id and status it replaced, read with the row locked in the same transaction as the write (O3 adds this; `RETURNING` alone gives only the new values) |
| **D6c**, R1 finds two or more live | Y ended, and more than one sibling is live | the list R1 already makes |

**It never cancels.** Which of two live plans the customer meant to keep is a person's call. The machine never cancels
a live subscription (ADR 0002 §3.3: T2, T2o adopt and never cancel). Rev 4's Q8 recommended "alert only", and this
ADR adopts it (Q4).

**Coverage, stated.** A live org-plan subscription emits at least one event per billing period, its renewal invoice,
and every such event's sync passes through D6a or D6b. So a two-live state that none of the three purchase flows
created is reported within one billing period at worst. A two-live state created through the paths this ADR closes
(D2, D5, D7) is not created at all. A Checkout that predates (a′), or a race with `setOrgPlan`, is reported at the
write that brings it to the row.

**Rejected: a scheduled scan of every org's Stripe customer.** It costs one list per org per tick to find what the
row's own writes already reveal.

### D7. A `past_due` org cannot mint a second plan (Q13)

**Decision.** `orgRowBlocksNewPlan` treats a row whose status is `past_due` (Stripe's `past_due` or `unpaid`,
`sync.ts:51-53`) as having a plan. The three flows refuse with: "This team's plan has an unpaid invoice, so a second
plan was not started. Update the payment method in Billing, or contact support at <email>." The same holds in
Stripe through (c): a `past_due` or `unpaid` org-plan subscription refuses even when the row has not caught up.

**Why refuse, and not let the purchase supersede.** On `dev`, a paid X supersedes a `past_due` Y on the row
(`queries.ts:262-264`, tested at `billing-sync.test.ts:348`), but Y stays live in Stripe and keeps retrying its
invoice. If the customer then fixes the card, Y collects, and the org pays for two plans. The SRE's goal is a working
plan. The path to it that charges once is to fix the card on the existing plan
(`createBillingPortalSession`, `billing.ts:3853`). The refusal names that path.

### D8. The copy, the notice, and the emails

- **One message per set,** from ADR 0002 §5.5's clauses, which are written per hold state and `last_pay` and name no
  flow. The org-plan composer reuses the clause table, and adds four rows: "change the plan instead" (live
  `active`/`trialing`), D7's `past_due` row, D5's grant row ("This team's plan is managed under a contract, so a plan
  cannot be bought here. Contact support at <email>."), and the neutral cross-scope row (D2 (b) 4: "A payment for
  this team's setup is still being confirmed, so nothing new was started. Try again in a few minutes.").
- **"You won't be charged twice" appears nowhere** in an org-plan response. `PAYMENT_MAY_BE_UNDER_WAY`,
  `EARLIER_PAYMENT_REFUNDED` and the `EARLIER_PAYMENT_*` messages (`billing.ts:793-837`) are used only by the
  memory-less path, and are deleted with it. `TOO_MANY_EARLIER_CHECKOUTS` and `SUPPORT_EMAIL` stay: create-a-team
  uses them.
- **The notice.** `SubscriptionIntent` gains `notice?: string`. The `released(refunded)` clause rides every org-plan
  intent of O for 14 days after `released_at`, as ADR 0002 §5.5 does for create-a-team. Showing it is
  `components/org/upgrade-org-sheet.tsx`'s change, a separate `class:ui` slice (§11, O7).
- **The Q3 emails (ADR 0002 Q3).** For `org_plan`, the recipient is the address Stripe receipts already go to: the
  customer's email, resolved as `sendReceiptEmail` does (`lib/email/billing-email.ts:149-161`). `refund_pending` and
  `released(refunded)` are mailed, under the same notice claim. `released(adopted)` is not mailed for `org_plan`.
  The sweeper stays the only sender.

---

## 4. State

### 4.1 The hold states, per scope

ADR 0002 §3.1's states and §3.3's transition table apply to both scopes, row for row. What differs is what a state
blocks, and what a release does:

| State | `new_org` blocks | `org_plan` blocks |
|---|---|---|
| `closing`, `cancel_unproven`, `payment_in_flight`, `invoice_payable`, `refund_due`, `needs_operator` | the user's next create-a-team mint (ADR 0002) | O's next org-plan mint and O's trial (D2 (a), D3); **never** a create-a-team mint |
| `refund_pending` | nothing (ADR 0002 Q10) | nothing |
| `released` | nothing | nothing |

| Release | `new_org` | `org_plan` |
|---|---|---|
| any reason but `adopted` | closes the open setup naming X (ADR 0002 §4.1) | touches no setup (D1, rule 4) |
| `adopted` | re-links the setup, or leaves it open for the resume (ADR 0002 §5.6) | nothing more: X is O's plan; (c) refuses the purchase with "change the plan instead" |
| Q3 email | `refund_pending`, `released(refunded)`, `released(adopted)` without an org, to the payer user | `refund_pending`, `released(refunded)`, to the customer's email (D8) |

### 4.2 The org-plan purchase, by what it finds

The rows are read top to bottom, and the first match decides. "Refuse" makes no Stripe write.

| # | O's row, and what Stripe and the holds show | `createSubscriptionIntent` | `createCheckoutSession` | `startProTrial` |
|---|---|---|---|---|
| P1 | an open create-a-team setup names O (ADR 0002 §5.7) | refuse (guard) | refuse (guard) | refuse (guard) |
| P2 | the row names a subscription that is `active` or `trialing` | refuse: change the plan | refuse: change the plan | refuse |
| P3 | the row is `past_due` (D7) | refuse: update the payment method | same | same |
| P4 | the row is a live, unexpired off-Stripe grant (D5) | refuse: contract | same | same |
| P5 | the lease is held past the wait | refuse: in progress | same | same |
| P6 | (a): an `org_plan` hold of O still blocks after one advance | refuse with the composed clauses | same | same |
| P7 | (a′): an earlier session of O is still `open` after its expire | refuse: unsettled | same | (not read) |
| P8 | (b): an `incomplete` org-plan subscription of O not proven `never_paid`, or one under another scope's open hold | keep it; refuse with its clause | same | (not swept) |
| P9 | (b): a never-paid one whose hold could not be written (T0f) | refuse, no block promised; nothing voided or cancelled | same | (not swept) |
| P10 | (c): a live org-plan subscription of O in Stripe | refuse by its status (D2 (c)) | same | refuse |
| P11 | none of the above | mint under the gate; a `notice` if one is owed | create the session under the gate | mint the trial and sync it |

### 4.3 The row slot, by write

Columns: the row as stored; the incoming subscription X, as freshly read; what the guard does (as built); and what
this ADR adds after it.

| Row names | Incoming X (fresh) | Guard (`queries.ts`, unchanged) | Added |
|---|---|---|---|
| X itself | any | N1–N3 (ADR 0002 §5.3 (2)) | nothing |
| nothing live (`none`, `canceled`, no row) | any non-ended | applies | nothing |
| a different Y, stored `active`/`trialing` | X live | ignored | **R2**: retrieve Y. Ended → sync Y, then X (applies). Live → **D6a** alert |
| a different Y, stored `active`/`trialing` | X not live | ignored | nothing (an `incomplete` X is a checkout, not a plan) |
| a different Y, stored `past_due` | X paid | applies (superseder) | **D6b** alert: Y is still live in Stripe |
| a different Y, stored `past_due` | X not paid | ignored | R2 when X is `past_due` (live); else nothing |
| no subscription id, a live grant | X paid | applies (superseder) | **D6b** alert |
| no subscription id, a live grant | X not paid | ignored (`billing-sync.test.ts:367`) | nothing |
| Y, and Y's `deleted` arrives | — | Y's `canceled` applies | **R1**: name the newest paid sibling, else the newest live one; two or more live → **D6c** alert; R1 named a paid one → no cancellation email |

---

## 5. Invariants

ADR 0002's invariants I1–I16 hold for `new_org` as written. For `org_plan`, I1–I11 hold with "the user" read as
"the org", `user:` read as `org-plan:`, and the create-a-team steps replaced by D2's. I12–I16 are about setups, and do
not apply to `org_plan`. New:

- **O1, scope isolation (AC 8).** No reader that decides a create-a-team purchase, link or resume reads an
  `org_plan` hold, and no org-plan reader reads a `new_org` hold. The only cross-scope readers are the setup predicates of D1 rule 4,
  the partial unique index, and the webhook's subscription-keyed lookups (D1).
- **O2, scope is fixed.** `scope` and `payer_key` are written at E0 and never change.
- **O3, the fence names the scope.** A state write succeeds only under the live lease `leaseKeyFor(scope, payer_key)`
  (D1, rule 1).
- **O4, never beside a live plan, a `past_due` plan or a live grant.** No org-plan flow mints, or hands out a Checkout
  URL, while `orgRowBlocksNewPlan` is true or (c) finds a live org-plan subscription (D2, D5, D7).
- **O5, the row follows a live subscription.** When the row's subscription ends and a live org-plan subscription of
  O exists, the row names one within the same webhook delivery, a paid one first (R1). When a live subscription's write is refused, the
  row's subscription is re-read before the refusal stands (R2).
- **O6, two live are always reported, never cancelled.** Every write that reveals two live org-plan subscriptions,
  or one beside a live grant, alerts (D6). No detector path calls a Stripe write.
- **O7, copy is true.** No org-plan response says "charged twice" or "charged again", and every clause comes from
  the set read in that request (ADR 0002 I8).

---

## 6. Failure handling

ADR 0002 §5.1 and §5.2 apply to the org-plan flow, call for call. The additions:

| Call | On error | Never |
|---|---|---|
| `checkout.sessions.list` in (a′) | refuse (`UNSETTLED`) | mint |
| `checkout.sessions.expire` in (a′) | re-read the session; `expired` or `complete` is done; else refuse | mint beside an `open` one |
| `checkout.sessions.create` after a failed gate | close out: `expire`; a failed expire leaves a URL that nobody holds, payable until its 30-minute `expires_at` (S16) | return the URL |
| the trial's `subscriptions.create` | as today: throws, nothing synced | — |
| R1's list, R2's retrieve | throw; the event is redelivered (D4) | write a guess |
| `reportTwoLive` | log; never throws; never fails the event | cancel anything |
| the row read before the lease (D5, D7) | throw: the purchase fails before any Stripe write | pass the purchase |

---

## 7. Acceptance cases

Test files (paths under `apps/console/`):

- `A` = `tests/actions/billing-subscription.test.ts`
- `A2` = `tests/actions/billing-org-plan-holds.test.ts` (new)
- `N` = `tests/actions/billing-new-org-holds.test.ts`
- `I` = `tests/integration/payment-holds.test.ts`
- `L` = `tests/integration/payment-hold-lease.test.ts`
- `E` = `tests/integration/payment-hold-sweeper.test.ts`
- `S` = `tests/integration/billing-sync.test.ts`
- `W` = `tests/lib/billing/webhook-handler.test.ts`
- `P` = `tests/scripts/payment-holds.test.ts`

Every new test must fail on the `dev` head its slice starts from, on its assertion, unless the row says it is a
regression guard.

| ID | Case | Source | Mechanism | Test |
|---|---|---|---|---|
| C1 | An org-plan hold blocks the same user's create-a-team purchase. | AC 8; 0002 §1.2 family 3 | D1 rule 3; O1 | N: an open `org_plan` hold in `payment_in_flight` for O, with `opened_by_user_id = U`. U's `createNewOrgSubscriptionIntent` mints. |
| C2 | An org-plan hold routes a create-a-team resume or link to a refusal. | AC 8; rev 4 C18 | D1 rule 3 | N: an `org_plan` hold names X, a linked create-a-team subscription. `resolveNewOrgSetup` reports `hold: null`, and the link's hold consult does not refuse with that hold's clause. |
| C3 | Scope, not the key's text, separates holds. | D1 | D1; O1 | I: a `new_org` hold and an `org_plan` hold whose `payer_key` strings are **equal**. Each scope's reader returns only its own. |
| C4 | A state write under the wrong scope's lease succeeds. | D1 rule 1 | O3 | I: an `org_plan` hold. A write under `user:<O>` changes no row; under `org-plan:<O>` it does. The mirror case for a `new_org` hold. |
| C5 | `openHold` accepts a lease of another scope. | D1 rule 2 | O3 | I: `openHold` with scope `org_plan` and a `user:` lease throws, and writes nothing. |
| C6 | The sweeper advances an org-plan hold under the user lease, or not at all. | D1 rule 5 | `leaseKeyFor` | E: a due `org_plan` hold is advanced under `org-plan:<O>`. With that lease held, the hold is `busy` and unchanged. |
| C7 | An org-plan release closes a create-a-team setup. | D1 rule 4 | scope test in `releaseHold` | I: an `org_plan` hold on X, an open setup naming X, release `voided_unpaid`: the setup stays open. 0002-C92 re-runs green. |
| C8 | The migration mislabels existing holds. | D1 | default `new_org` | I: a row inserted without `scope` reads `new_org`. A row with `scope = 'ai'` is refused by the check. |
| C9 | **The memory gap.** A payment that starts processing between the read and the cancel is forgotten, and the retry mints. | 5506; AC 1 | D2 (b) | A: `:725-760` flipped. The retry is refused with the hold's clause, and `subscriptions.create` is not called. |
| C10 | The org-plan sweep cancels before it voids. | AC 4; 0002 §3.4 | D2 (b) | A2: `voidInvoice` is called before `subscriptions.cancel`, and the cancel carries `alethia:checkout_closed:<hold id>`. |
| C11 | The hold write fails, and the flow voids or cancels anyway. | AC 6; 0002 T0f | I4 | A2: `openHold` rejects. No `voidInvoice`, no `cancel`, refused, and the copy does not match `/blocked\|charged (twice\|again)/`. |
| C12 | A processing payment later succeeds: refund it, and say so. | AC 3 | 0002 T6, T5, T10 | A2: a `payment_in_flight` hold refuses. After the sweeper refunds and releases it, O's next intent mints with the refund clause in `notice`. |
| C13 | The org-plan sweep closes an AI checkout. | AC 11; F2 | D2 (b) 1 | A2: an `incomplete` AI subscription on O's customer is neither held nor cancelled (F2's test re-run). |
| C14 | The org-plan sweep closes another org's checkout on a shared customer. | 0002 §4.2 | D2 (b) 2 | A2: an `incomplete` subscription with `organization_id = O2` is untouched, alerted with it as the subject, and O's purchase is not refused for it. |
| C15 | A linked, never-paid create-a-team X blocks the org for a day. | Q1 | D2, classification | A2: X carries `created_by` and `organization_id = O`, `incomplete`, `never_paid`, no hold. It is closed under an `org_plan` hold (payer O), and the purchase mints. |
| C16 | The org-plan sweep closes a subscription that a create-a-team hold is deciding. | D2 (b) 4 | cross-scope keep | A2: X as in C15, with an open `new_org` hold. No hold is opened, nothing is voided or cancelled, and the purchase is refused with the neutral clause. |
| C17 | Webhook lag: Stripe lists an `active` plan while the row reads `none`. | AC 12; F3 | D2 (c) | A: F3's test, re-run after the move. `subscriptions.create` is not called. |
| C18 | (c) reads before the sweep, so a subscription adopted during (a) is missed. | 0002 I1 order | D2 (c) last | A2: a `closing` hold whose X reads `active` is released `adopted` in (a). (c) then refuses with "change the plan instead". No refund, no Q3 email. |
| C19 | `unpaid` or `paused` in Stripe is not "live" to the check. | D2 (c) | the full live set | A: a `paused` org-plan subscription refuses with the contact-support copy. An `unpaid` one refuses with D7's copy. |
| C20 | The lease expires mid-purchase: two payable org-plan subscriptions. | 0002-C52 | D3 | L: A's `org-plan:<O>` lease expires before its mint, and B mints. Exactly one secret is returned. A's only writes after the failed gate are `voidInvoice` and a cancel stamped `alethia:closeout`. |
| C21 | An intent and a Checkout in two tabs are not serialised. | D3 | one lease | L: with `org-plan:<O>` held by an intent, `createCheckoutSession` waits, then sees the intent's subscription in (b). |
| C22 | A Checkout URL leaves a request that lost its lease. | D3 | Checkout's gate | A: the renewal after `checkout.sessions.create` matches no row. `session.url` is not returned, and `checkout.sessions.expire` is called. |
| C23 | An earlier open Checkout of the same org is paid beside a new purchase. | Rev 4 Q11 | D2 (a′) | A2: an `open` session with `metadata.organization_id = O` is expired before the mint. A re-read showing `complete` leads (c) to refuse. A re-read still `open` refuses `UNSETTLED`. |
| C24 | A pre-release session, without the session-level key, is expired. | S17 | D2 (a′) | A2: an `open` session with no `metadata.organization_id` gets no `expire` call. |
| C25 | During the rolling deploy, an old pod and a new pod both run an org-plan purchase. | D3 | both keys | A: the slice's flow takes `withPurchaseLock('org-plan:<O>')` and the lease. The next slice takes the lease alone. |
| C26 | The trial runs beside a blocking hold or a live plan. | D3; Q5 | (a), (c) | A (O4): with `org-plan:<O>` held, the trial waits, and a live org-plan subscription that only Stripe shows refuses it. A2 (O6): an open `refund_due` `org_plan` hold refuses it. |
| C27 | **Q13: a `past_due` org mints a second plan.** | 0002 retired C44 | D7 | A: the row is `past_due`. `createSubscriptionIntent` returns D7's copy, and calls no `customers.*`, `subscriptions.*` or `checkout.*`. |
| C28 | Checkout or the trial beside a `past_due` plan. | D7 | one predicate | A: the same row. `createCheckoutSession` and `startProTrial` each refuse with D7's copy. |
| C29 | **A purchase replaces an off-Stripe grant.** | K2 sequence 2 | D5 | A: the row is `enterprise`, `active`, with no subscription id and a future `currentPeriodEnd`. All three flows refuse with the contract copy, and nothing is minted. |
| C30 | A lapsed grant blocks a purchase for good. | D5 | `isManualGrantExpired` | A: the same row with a past `currentPeriodEnd` is not refused. |
| C31 | The org-plan copy promises "won't be charged twice". | 0002-C32 | D8; O7 | A2: no org-plan response matches `/charged (twice\|again)/`. |
| C32 | An org-plan refund is never mailed, or is mailed to the wrong person. | 0002 Q3 | D8 | E: an `org_plan` hold entering `refund_pending` mails the customer's email once (the notice claim). A `released(adopted)` `org_plan` hold mails nothing. |
| C33 | **K2 sequence 1.** Y ends while a paid X lives, and the org sits on `community`. | K2 | R1 | S and W: the row names `active` Y, and X is `active` (its write was refused). Y's `deleted` writes Y `canceled`, then R1 names X: `team`, `active`. No "subscription canceled" email, and no revenue event. |
| C34 | Y ends with two live siblings, or with only a `past_due` one. | D6c | R1 | W: X1 and X2 are both `active`. R1 names the newer one, and one two-live alert names both. Variant: the only sibling is `past_due`. R1 names it, the row reads `past_due` / `community`, no alert, and the cancellation email is sent. |
| C35 | Y ends with none. | regression | R1 | W: no paid sibling. The row is `canceled` / `community`, and the email is sent, as today. |
| C36 | Y ended in Stripe, but its `deleted` is late: every X event is refused from a stale status. | W1 (rev 4) | R2 | S and W: the row stores Y `active`. Stripe reads Y `canceled`. X's `updated(active)` applies Y's `canceled`, then X. |
| C37 | Both live, and nothing says so. | W2 (rev 4); K2 | R2; D6a | W: Y reads `active`. X's write is ignored, the row is unchanged, and one alert names X and Y. A second X event raises it with the same subject (throttled by the rule). |
| C38 | A paid X supersedes a `past_due` Y, which keeps dunning. | D6b | the replaced-row report | S: `billing-sync.test.ts:348`'s sequence, unchanged on the row, plus one two-live alert. |
| C39 | A paid X supersedes a live grant, silently. | D5; D6b | the replaced-row report | S: a grant row, then X `active`. The row names X (unchanged rule), and one alert names X and the grant. |
| C40 | A detector cancels or refunds. | O6 | — | W: across C33–C39, no `subscriptions.cancel`, `refunds.create` or `invoices.voidInvoice` is called. |
| C41 | R2's read fails, and the webhook writes a guess. | D4 | throw | W: `subscriptions.retrieve(Y)` rejects. The handler throws before any email, and nothing past the guarded X write changed. |
| C42 | The operator cannot see or release org-plan holds. | D1 rule 5 | the script | P: `list --scope org_plan` lists only those. `release <sub>` takes `org-plan:<O>` and writes `released(operator)`. |
| C43 | The backfill holds an org-plan subscription it cannot prove was never live. | 0002 §8 B1–B6 | §9 | P: B1 widened to org-plan subscriptions holds only a never-live, card-paid, single-invoice checkout, and lists the rest. |

That is 43 cases. C17 and C38 re-run an existing test, and each adds only what this ADR changes.

---

## 8. Not covered, and why

| Not covered | Why | What handles it |
|---|---|---|
| The AI subscription (`createAiSubscriptionIntent`) | A separate product, written to the AI slot only (`sync.ts:141-146`). It cannot take the plan row. | F2: its own `ai:<org>` lock, and no org-plan sweep touches it. No holds. A future scope `ai` would be an ADR of its own. |
| Holds for hosted Checkout's own payment | A session has no subscription until it completes, so there is nothing to void or cancel. | D2 (a′) expires earlier sessions; D3 gates the URL; D6 reports one that completes beside a plan. |
| The trial's gate and close-out | It takes no payment. ADR 0002 K1 showed the gate needs a marker the webhook honours, which is not worth it for a subscription that cancels itself after 30 days without a card (`billing.ts:1711`). | D3: serialised under the lease; refuses on (row), (a), (c). A trial that races a paid X is reported by D6. |
| Renewals, dunning, plan changes, cancels and resumes | Not first payments (ADR 0002 §7). | As on `dev`. R1 changes what follows a dunning-ended `canceled` only when a paid sibling exists. |
| Credit packs, disputes, deployments with no Stripe | As in ADR 0002 §7. | As on `dev`. |
| Choosing which of two live plans to keep | A person's decision (D6, Q4). | The alert, and the operator in Stripe. |
| The org-plan sheet showing `notice` | A UI change. | O7, `class:ui`, a draft until the maintainer accepts it (CLAUDE.md §4). Until then the clause still rides the response. |

---

## 9. Migration and rollout

The order, with §11 giving each step's PR boundary:

1. **The scope (O1).** The `scope` column, the index, the scope-aware fence, open, readers, sweeper, script and
   emails. No `org_plan` hold exists yet, so behaviour is unchanged. C1–C8 pass on synthetic rows.
2. **The row predicates (O2).** D5 and D7 in all three flows, and the widened live set. These close live defects,
   with or without holds.
3. **The superseder and the detector (O3).** R1, R2 and D6 in the webhook and the row write. Independent of holds,
   and parallel with 1 and 2.
4. **The lease (O4).** Both org-plan purchase flows, and the trial, on `org-plan:<O>`, with the gate and the
   close-out, taking the old advisory key as well for one release. Checkout gains its session-level key and the
   30-minute `expires_at`.
5. **The backfill and the runbook (O5).** `payment-holds reconcile --backfill` widened to org-plan subscriptions: B1
   becomes "an org-plan subscription of some org (§2), or a create-a-team one", and B2–B6 are unchanged. A held
   org-plan subscription gets `scope = 'org_plan'` and `payer_key` = its `organization_id`. The runbook gains the
   org-plan rows.
6. **The flow on holds (O6).** D2 in full: drop the advisory key (deploy only after step 4's rollout has
   completed), I1 (a), (a′), (b), (c), the composer and `notice`, and the deletion of the memory-less path.
   **Deploy only after an operator has run the widened backfill (step 5), and run it again once the rollout has
   completed,** for the reason ADR 0002 §8 gives: old pods keep cancelling without holds until then.
7. **The notice in the sheet (O7, `class:ui`).**

**What the backfill can and cannot find.** The memory-less org-plan path stamped none of its cancels
(`billing.ts:1287-1289`). B2's `cancellation_requested` therefore also matches a customer's own cancel. B3 (exactly one
invoice, `subscription_create`) and B4 (unpaid when it ended) keep a cancelled, used subscription out. Every cancel on
that path that it could not settle (a payment in flight, a payment it could not read, a void or a refund that
failed, a cancel it could not prove) alerted an operator (`billing.ts:1186-1252`, `:1298-1305`), so the backfill's
review list can be checked against those alerts.

**Rollback.** Every step is code, plus one additive column with a default. A reverted build leaves `org_plan` holds
that nothing reads, which block nothing. The sweeper of a later redeploy advances them.

---

## 10. Open questions

Each carries a recommendation, so a reviewer can accept or veto it by number.

- **Q1.** Is a linked create-a-team subscription an org-plan subscription for the org-plan sweep (D2)?
  **Recommended: yes**, except under another scope's open hold, where it is kept. Reason: ADR 0002 §4.3 already
  calls it the org's. The alternative blocks the org for up to 23h over a payment the read proved never happened.
- **Q2.** Keep the row rule that a paid subscription supersedes an off-Stripe grant, and guard at the purchase
  instead (D5)? **Recommended: yes.** Making a grant "owned" in the row guard strands a create-a-team X linked
  beside a grant (D5, "Rejected").
- **Q3.** Refuse a `past_due` org's new purchase, and send it to its payment method (D7)? **Recommended: yes.** The
  alternative leaves the old plan dunning beside the new one.
- **Q4.** Two live plans: alert only, never cancel (D6)? **Recommended: yes**, as rev 4's Q8.
- **Q5.** The trial: serialise it under the lease, without a gate (D3)? **Recommended: yes.** A gate needs rev 4's
  gate marker in the webhook, for a subscription that takes no payment.
- **Q6.** Expire an org's earlier open Checkout Session before a new purchase, rather than refuse until it expires
  (D2 (a′))? **Recommended: expire**, as rev 4's Q11. The newest purchase is the one the customer wants, and a session
  they finished first is seen by (b) and (c).
- **Q7.** Q3 email recipient for `org_plan`: the Stripe customer's email (D8)? **Recommended: yes.** It is where
  receipts go, so the refund notice lands beside the charge it refers to.
- **Q8.** A 30-minute `expires_at` on every Checkout Session (D3)? **Recommended: yes.** A URL that left the server
  is payable for as short a time as Stripe allows.

---

## 11. Implementation slices

Each slice is one PR into `dev`, about 800 changed lines or fewer. Slices that touch
`apps/console/app/server/actions/billing.ts` are chained. F2 and F3 also touch `billing.ts`, so every such slice here
is blocked by both. Every slice that can move money gets an adversarial money review against §4 and §7, whatever its
security column says.

| # | Slice | Done when | scope | Blocked by | Migration | Security review |
|---|---|---|---|---|---|---|
| O1 | **The hold scope (D1)** | `payment_holds.scope` exists with its check and the `(scope, payer_key)` open index. `leaseKeyFor` replaces `payerLeaseKey` in the store, the sweeper and the script. `openHold` takes `scope`. The create-a-team readers filter `new_org`. `releaseHold` closes a setup only for `new_org`. The script lists `--scope`. The Q3 sender resolves the `org_plan` recipient. C1–C8, C32 (sender half) and C42 pass. | `apps/console/lib/db/schema/payment-holds.ts apps/console/lib/db/migrations/** apps/console/lib/billing/payment-holds/store.ts apps/console/lib/billing/payment-holds/sweeper.ts apps/console/lib/billing/payment-holds/emails.ts apps/console/lib/billing/pending-org-setup.ts apps/console/scripts/payment-holds.ts apps/console/tests/integration/payment-holds.test.ts apps/console/tests/integration/payment-hold-sweeper.test.ts apps/console/tests/scripts/payment-holds.test.ts apps/console/tests/actions/billing-new-org-holds.test.ts` | none (rebase first, CLAUDE.md §5) | **yes** | **yes** (a service-role table's fence and readers) |
| O2 | **The row predicates (D5, D7)** | `orgRowBlocksNewPlan` refuses a row naming an `active` or `trialing` subscription, a `past_due` row, and a live, unexpired grant, in `createSubscriptionIntent`, `createCheckoutSession` and `startProTrial`, before any Stripe call, each with its copy. F3's live set is widened to §2's. C19, C27–C30 pass. | `apps/console/app/server/actions/billing.ts apps/console/tests/actions/billing-subscription.test.ts` | F2, F3 | no | no (money review yes) |
| O3 | **The superseder with a fresh read, and the detector (D4, D6)** | `lib/billing/org-plan-row.ts` holds R1, R2, `reportTwoLive` and `isOrgPlanSubscriptionOf`. The guarded write reports the subscription it replaced. The `deleted` handler runs R1, and suppresses the cancellation email when R1 named a live sibling. A refused live sync runs R2. C33–C41 pass, and `billing-sync.test.ts` stays green. | `apps/console/lib/billing/org-plan-row.ts apps/console/lib/billing/sync.ts apps/console/lib/billing/queries.ts apps/console/lib/billing/webhook-handler.ts apps/console/tests/integration/billing-sync.test.ts apps/console/tests/lib/billing/webhook-handler.test.ts apps/console/tests/lib/billing/sync.test.ts apps/console/tests/lib/billing/org-plan-row.test.ts` | none. **Parallel with O1 and O2.** | no | **yes** (the webhook) |
| O4 | **The `org-plan:` lease (D3)** | `createSubscriptionIntent` and `createCheckoutSession` run under `org-plan:<O>` on `purchase_leases` **and** the old advisory key, with the fence, the mint deadline, the gate and the close-out. Checkout carries its session-level key and a 30-minute `expires_at`. The trial takes the lease. C20–C22, C25 and C26 (the lease half) pass. | `apps/console/app/server/actions/billing.ts apps/console/lib/billing/purchase-lease.ts apps/console/tests/integration/payment-hold-lease.test.ts apps/console/tests/actions/billing-subscription.test.ts` | O2 (`billing.ts`), F2 | no | **yes** (the purchase path) |
| O5 | **The backfill and the runbook (§9 step 5)** | `reconcile --backfill` widens B1 to org-plan subscriptions and opens them as `org_plan` holds. The runbook documents the org-plan rows, the scope flag and the deploy order. C43 passes. | `apps/console/scripts/payment-holds.ts apps/console/docs/stripe-prod-runbook.md apps/console/tests/scripts/payment-holds.test.ts` | O1. **Parallel with O3 and O4.** | no | **yes** (an operator command that opens holds) |
| O6 | **The org-plan flow on holds (D2, D8)** | I1 (row), (a), (a′), (b), (c) as D2 says. The cross-scope keep. The org-plan composer and `notice`. `cancelNeverPaid`, `settleCancelledSubscription` and the memory-less outcomes and copy are deleted. The advisory key is dropped. `billing-subscription.test.ts:725-760` is flipped. C9–C18, C23, C24, C26 (hold half) and C31 pass. **Deploy only after O4's rollout has completed and the O5 backfill has run, and run the backfill again after this rollout (§9).** | `apps/console/app/server/actions/billing.ts apps/console/lib/billing/org-plan-hold-copy.ts apps/console/lib/billing/new-org-hold-copy.ts apps/console/tests/actions/billing-subscription.test.ts apps/console/tests/actions/billing-org-plan-holds.test.ts` | O1, O3 (`isOrgPlanSubscriptionOf`), O4, O5 | no | **yes** (the purchase path) |
| O7 | **The notice in the upgrade sheet (D8)** | `components/org/upgrade-org-sheet.tsx` shows `notice` above the payment form. If the board labels it `class:ui`, it opens as a draft and stays one (CLAUDE.md §4). | `apps/console/components/org/upgrade-org-sheet.tsx apps/console/tests/components/org/**` | O6 | no | no |

Order: F2 and F3 first. Then O1, O2 and O3 in parallel. Then O4 (after O2) and O5 (after O1). They join at O6, then
O7. O1, O2 and O3 have disjoint scopes. O4 and O6 reach `billing.ts` after O2, and O5 reaches the script after O1,
which is sound because each runs after the one it shares a file with.

**What changes in ADR 0002 on acceptance.** §2's "the rev 4 notion of a purchase scope … is gone", §7's "The
org-plan purchase" and "Two live subscriptions on one org" rows, and Q13 are superseded by this ADR. That amendment
is a follow-up with its own scope, `docs/adr/0002-*`; this ADR's scope is its own file only.
