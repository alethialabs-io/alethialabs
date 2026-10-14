---
status: "Accepted (maintainer delegation 2026-10-14)"
issue: "#5976"
parent: "#5506"
date: 2026-10-14
accepted: 2026-10-14
---

# Payment holds for the org-plan purchase

**Decision (accepted by maintainer delegation 2026-10-14, after two adversarial money review rounds, PR #5982).**
The org-plan purchase (`createSubscriptionIntent`) gets payment holds. Before it makes an
earlier org-plan subscription unpayable (voids its invoice or cancels it), it writes a hold row first, as the
create-a-team purchase has done since ADR 0002 S8. The state machine is ADR 0002's, unchanged: `advanceHold`
moves every hold, under its payer's lease, and nothing else does. This ADR adds what ADR 0002 rev 5 removed when it
narrowed its scope (ADR 0002 §7, Q13):

1. **A hold scope per flow.** `payment_holds` gains a `scope` column (`new_org`, `org_plan`). Every hold is
   keyed, fenced, swept and read by `(scope, payer_key)`. An org-plan hold never blocks or reroutes a
   create-a-team purchase (AC 8, §3 D1). The reverse has one deliberate exception: a create-a-team hold on a
   linked, still-`incomplete` subscription refuses the org's plan purchase until that hold decides it (D2 (b) 4).
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

F3 is PR #5979 and lands on `dev` before any slice here. Where this ADR changes something F2 or F3 ships, the slice
that does it says so (§11): the `org-plan:` advisory key becomes a lease (O4, O6), F3's live set gains `unpaid` and
`paused` and its `past_due` copy changes (O2), and Checkout and the trial gain the hold pass and the sweep before F3's
check (O6). F3's check already runs after the org-plan sweep in `startOrgSubscription`; what O6 changes is that the
sweep before it runs under holds.

**Citations.** Every claim about today's code cites `file:line` at `origin/dev` `6f050e0b7` (2026-10-14). Every
path is relative to `apps/console/`, except this ADR's own folder, `docs/adr/`, and §11's `scope:` globs, which
are relative to the repo root. "ADR 0002 §n" and "0002-Cn" name that ADR's sections and cases. The `C` numbers in
§7 are this ADR's own.

**What this supersedes in ADR 0002.** On acceptance, these parts of ADR 0002 are superseded by this ADR: §2's "the rev
4 notion of a purchase scope … is gone"; §7's rows "The org-plan purchase" and "Two live subscriptions on one org";
and Q13. Amending ADR 0002's own text is a separate follow-up with its own scope (`docs/adr/0002-*`). This ADR does
not edit it.

## Revisions

- **Rev 1** (2026-10-14). The first draft, written before any code, as #5506 and ADR 0002 Q13 require.
- **Rev 2** (2026-10-14, the money review of `f98672737`: three blockers, sixteen advisories).
  - **B1 (blocker): a session with no session-level key, plus Stripe's 24h default expiry, gave two plans.** (a′)
    now expires every `open` subscription-mode session on O's customer that has O's key **or no key**. Expiring a
    session only ever costs a checkout a restart, never a charge. As a second guard, O6 deploys only 24h after O4's
    rollout has completed. New case C44.
  - **B2 (blocker): D7's `past_due` arm caught off-Stripe grants.** D7's row arm now needs a non-null
    `stripeSubscriptionId`. Every subscription-less row goes through D5 only: a live grant gets the contract copy,
    and a lapsed one is not refused. C30 gains its `past_due` variants. New case C45.
  - **B3 (blocker): the cross-scope refusal was one fixed sentence.** It is now ADR 0002 §5.5's clause for that
    hold's state and `last_pay`: verbatim when the buyer is the hold's payer, and a payer-neutral rewording of the
    same clause otherwise (D8 table). C16 checks one case per state.
  - **Advisories, all taken.** (1)–(3) F3 is aligned: (c) keeps F3's price-based classifier, and O2 names the F3
    assertion it changes. (4) D6b′ reports a replaced `paused` subscription. (5) The trial runs (a′) and (b)
    under its lease. (6) Needed no change. (7) The D1 summary and O1 now name the cross-scope exception. (8) O1
    builds the org-plan reader and the scope-free lookup. (9) `scope` is optional in `openHold` until O8.
    (10) O3 adds a server-only `lib/billing/operator-alert.ts`, and O6 moves `billing.ts` onto it. (11) "Paid" is
    used consistently for R1's email rule. (12) C1 and C30's base case are labelled pins. (13) C21 moves to O6.
    (14) O4 takes the advisory key first, then the lease. (15) R1 prefers `active` over `trialing`. (16) O8
    removes the `scope` default.
- **Rev 2.1** (2026-10-14, the delta review of `d8b8ef592`: no blockers, three advisories, all taken). (1) When
  D6b′ cannot read the replaced subscription, it alerts anyway, so the write is never left unreported (§6, D6).
  (2) §8 lists the permanent refusal on a legacy shared customer, with the operator's fix. (3) D2 (a′) states that
  expiring another org's keyless session costs a restart, never a charge. **Accepted** under the maintainer's
  delegation, after two adversarial money review rounds on PR #5982.

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
| **Org-plan subscription of O** | A subscription whose **own** metadata has `organization_id = O` and no `product_type` (`billing.ts:1560`, `:1457`, `:1712`). A linked create-a-team subscription carries `organization_id = O` too (`sweeper.ts:388-392`), so it is one (ADR 0002 §2: "it becomes an ordinary org subscription once the link writes `organization_id`"). An AI subscription (`product_type = "ai_subscription"`, `billing.ts:1624`) is not. Neither is another org's subscription on a shared customer. The customer is never evidence. This is what (b) may **close**. The live check (c) deliberately counts more: F3's classifier, every live non-AI subscription on O's customer (D2 (c)). |
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
'org_plan')`. The default exists only to carry the existing rows and callers through the rollout. O8 drops it once
every opener passes `scope`, so a later insert that forgets `scope` fails instead of being filed as `new_org`. The open-payer index becomes `(scope, payer_key) WHERE state <> 'released'`. Every existing row is
`new_org`, which is true by construction: every opener on `dev` is create-a-team (`opened_by` is `purchase`,
`backfill` or `link`, `schema/payment-holds.ts:63-64`, and all three are ADR 0002's).

The scope is enforced in five places:

1. **The fence.** The state-write fence requires the lease named by `leaseKeyFor(scope, payer_key)`, computed in
   the same statement (`store.ts:59-69` today hard-codes `'user:'`). A request holding `user:U` can never write an
   org-plan hold, and a request holding `org-plan:O` can never write a create-a-team hold.
2. **The open.** `openHold` takes an optional `scope`, defaulting to `new_org`, and refuses a lease whose key is
   not `leaseKeyFor(scope, payerKey)` (`store.ts:114` today checks `user:` only). Because it is optional, the
   create-a-team callers (`billing.ts:2105`, `sweeper.ts:454`'s link opener, `scripts/payment-holds.ts:565`'s backfill) are unchanged
   in O1. O8 makes it required, and updates those callers then.
3. **The create-a-team readers.** The readers that **block or route** a create-a-team purchase read
   `scope = 'new_org'` only: `paymentHoldsOfPayer`, `openPaymentHoldOn` and `latestReleasedHoldOn` as the link, the
   resume lookups and the guard's creator copy call them (`pending-org-setup.ts:177-222`; `billing.ts:994-1000`).
   The org-plan flow has its own reader, `paymentHoldsOf('org_plan', orgId)`. O1 builds it in `store.ts`, beside
   the scope-free `openHoldOn(subscriptionId)` that D2 (b) 4 needs; O6 is their first caller.
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

**Decision.** Under the `org-plan:<O>` lease (D3), `createSubscriptionIntent` calls `subscriptions.create` only when the
steps below pass, in this order (I1 for `org_plan`). `createCheckoutSession` runs the same steps before it creates a
session, and `startProTrial` before it mints its trial (D3):

- **(row)** `orgRowBlocksNewPlan` passes, before the lease is taken: the row names no `active` or `trialing`
  subscription, no `past_due` one (D7), and is not a live grant (D5).
- **(a) Holds.** Every open `org_plan` hold of O, advanced once by `advanceHold`, is `released` or
  `refund_pending` (ADR 0002 Q10 holds here too). Released `refunded` holds within 14 days are kept for the
  notice (D8).
- **(a′) Earlier Checkout sessions.** Every `open` subscription-mode Checkout Session on O's customer is expired,
  then re-read (S16, S17), when its own `metadata.organization_id` is O **or it has no such key**. A re-read
  showing `complete` means the customer finished it first: its subscription now exists, and (b) and (c) see it.
  One still `open` refuses (`UNSETTLED`). A session keyed to another org is left alone: it is that org's checkout
  on a shared customer, and it cannot give O a plan. A **keyless** session on a legacy shared customer may be
  another org's (O2's), and (a′) expires it too. That is deliberate and not a cross-tenant defect: it costs O2's
  open checkout a restart, never a charge, and keyless sessions stop existing 24h after O4's rollout.

  **Why a keyless session is expired too (B1).** Before O4, no session carries the key (`billing.ts:1452-1466`), and
  each one stays payable for Stripe's default 24h (S16). Left alone, a keyless Enterprise session opened before O4
  and finished after an embedded purchase gives the org two paid plans. D6 would only report that. Expiring it is
  safe for three reasons. `createCheckoutSession` is the only code that creates a session (`billing.ts:1452`, the
  one call site). On O's customer, a keyless session was made for the org whose row named that customer, which is
  O, or another org on a legacy shared customer (ADR 0002 §1.1). And an expired session costs that checkout only a
  restart, never a charge: a session that completed first re-reads `complete` and is counted by (b) and (c).

  **A second guard.** O6 deploys only once O4's rollout has been complete for more than 24h, so every keyless
  session has expired by then whatever (a′) reads. That bound is part of the deploy order (§9). (a′) does not
  depend on it.
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
     hold, found by the scope-free `openHoldOn`) is kept, untouched. The purchase refuses with **that hold's**
     clause, chosen by its state and `last_pay` (D8, "The cross-scope clause"), because that hold decides X.
     Without this rule, the E0 insert would conflict on the cross-scope unique index (ADR 0002 T0h), and the
     result would be a refusal with a less precise message. This is the one place an org-plan purchase reads a
     `new_org` hold (O1).
- **(c) The live check, read last.** F3's `liveOrgPlanCheck`: a full `subscriptions.list({ customer, status:
  "all" })` of O's customer. **Its classifier is F3's, unchanged:** every subscription whose plan line does not
  carry an AI price counts (`planItem`, then `aiTierForPriceId`), with no `organization_id` filter, on purpose (it
  refuses on what it cannot place). That is wider than §2's org-plan subscription of O, which only (b) uses to
  decide what it may **close**. Refusing beside another org's live plan on a legacy shared customer is the safe
  side. The copy names support there, and the purchase does not mint. Only the status set changes: F3 counts
  `active`, `trialing`, `past_due` (`PAID_SUBSCRIPTION_STATUSES`), and (c) counts the full live set (§2), adding
  `unpaid` and `paused`. `active` and `trialing` refuse with "change the plan instead". `past_due` and `unpaid`
  refuse with D7's copy. `paused` refuses with the contact-support copy. A subscription adopted in (a) is seen
  here. F3 already reads (c) after the sweep. O6 puts (a), (a′) and (b) under holds in front of it.

The mint then follows ADR 0002 §4.4 rules 1–4: renew before every Stripe write, the mint deadline, the artifact gate
before the client secret leaves, and the close-out after a failed gate. The close-out voids, then cancels stamped
`alethia:closeout`, and writes no hold. With (a′) and (b), **at most one payable org-plan artifact exists per org at a
time** (I9 for `org_plan`), and the trial mints only into that same state (D3). The org-plan flow then stops calling
`cancelNeverPaid` and `settleCancelledSubscription` (`billing.ts:1150-1310`). They, `cancelIncompleteSubscriptions`, `voidPayableInvoice`, `refundTakenPayment`,
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
`startProTrial` takes the same lease and runs (row), (a), (a′), (b) and (c) under it, as the purchase does. So a
trial never starts beside a payable client secret or an open session in another tab: (b) closes a never-paid
`incomplete` subscription under a hold, and keeps and refuses any other. Only the trial's own artifact has no gate
(Q5): it is a `trialing` subscription that takes no payment.

**Why the lease.** A hold's state writes are fenced on a `purchase_leases` row (ADR 0002 §4.1). An advisory lock
cannot fence them, and it holds a pooled connection for the whole Stripe sequence (§1.1, "The lock").

**Why Checkout moves with it, in the same slice.** An advisory lock and a lease row on the same name do not exclude
each other. If only one flow moved, an intent and a Checkout in two tabs would stop excluding each other.

**Rolling deploy.** For one release, both flows take the lease **and** the old advisory key, as ADR 0002 S2 did
for create-a-team (§8 step 1 there). Every new pod takes them in one order: the advisory key first
(`withPurchaseLock` is the outer call), then the lease inside it, released in reverse. Two new pods therefore
queue on the advisory key and never hold one each while waiting for the other. An old pod takes only the advisory
key, so it is excluded either way. The trial takes the lease alone: it had no advisory key to keep. The release
after drops the advisory key (O6), and deploys only after the first one's rollout has completed (§9).

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
  read **live**, and syncs one with no event time, chosen in this order: the newest `active` one by `created`, else
  the newest `trialing` one, else the newest other live one. `active` comes before `trialing` so a card-less trial
  (which cancels itself without a card, `billing.ts:1711`) is never named over a plan the customer pays for.
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
disagree. Checkout, which has no row check today, gains all three. **A subscription-less row is judged by D5
alone,** whatever its status: live and unexpired gives the contract copy, and lapsed gives no refusal. The operator
plane can write `past_due` on a grant (`scripts/set-org-plan.mjs:33`), and D7's arm does not apply to it (B2).

**The row rule stays (Q2).** A paid Stripe subscription still takes a row that holds a grant (`queries.ts:262-264`).
If one ever does, through a race with `setOrgPlan` or a create-a-team link beside a grant, D6 alerts with both named.

**Rejected: make a live grant "owned" in the row guard (the K2 review's fix).** A create-a-team X linked beside a
grant would then be paid, live, and never on the row. The link's refusal (`namesOtherLivePlan`) does not see a grant,
because it needs a subscription id, so the link would mark X linked. That reopens the stranded-X defect ADR 0002
spent rev 5.1 and rev 7 closing (0002-C80, I14). The purchase-side guard prevents the org-plan sequence without that
cost.

### D6. The two-live detector

**Decision.** One function, `reportTwoLive(orgId, a, b)`, raises `system.platform.payment_needs_support` through
an operator-alert helper with its own summary, never `alertPaymentNeedsSupport`'s "which the purchase flow cancelled"
text. That helper is `alertOperator` today (`billing.ts:858-879`), but it is a private function of a `"use server"`
file (`billing.ts:1`). Exporting it from there would publish it as a server action that any client could call to
page the operator. So O3 adds `lib/billing/operator-alert.ts`, a `server-only` module (no `"use server"`) with the
same contract: it emits on `ALETHIA_PLATFORM_ALERT_ORG_ID`, it is true only when a delivery was queued, and it never
throws. O6, which owns `billing.ts`, deletes the private copy and imports this one. The newer subscription is the subject, so the alert rule's throttle collapses repeats. It also logs
`billing.org_plan.two_live` with both ids. It runs at four points, and nowhere else:

| Point | Seen when | Cost |
|---|---|---|
| **D6a**, R2 finds Y live | a live X's write was refused beside a live Y | the one retrieve R2 already makes |
| **D6b**, a write **replaced** a live subscription | a paid X took a row that named a different `past_due` Y, or a live grant (`queries.ts:262-264`) | no Stripe call. The guarded write reports the subscription id and status it replaced, read with the row locked in the same transaction as the write (O3 adds this; `RETURNING` alone gives only the new values) |
| **D6b′**, a write replaced a subscription the row stored as `none` | a paid X took a row naming a different Y whose stored status was `none`, which is how `mapStatus` stores both an `incomplete` and a **`paused`** Y (`sync.ts:44-60`) | one `subscriptions.retrieve(Y)`, in the webhook handler, only when a paid X just replaced a different stored-`none` Y. It alerts only when Y reads `paused`, which is live (§2). An `incomplete` Y is a checkout, not a plan |
| **D6c**, R1 finds two or more live | Y ended, and more than one sibling is live | the list R1 already makes |

**It never cancels.** Which of two live plans the customer meant to keep is a person's call. The machine never cancels
a live subscription (ADR 0002 §3.3: T2, T2o adopt and never cancel). Rev 4's Q8 recommended "alert only", and this
ADR adopts it (Q4).

**Coverage, stated.** A live org-plan subscription emits at least one event per billing period, its renewal invoice,
and every such event's sync passes through D6a or D6b. So a two-live state that none of the three purchase flows
created is reported within one billing period at worst. A two-live state created through the paths this ADR closes
(D2, D5, D7) is not created at all. A race with `setOrgPlan` is reported at the write that brings it to the row. A
`paused` Y that a paid X replaced is reported at that write (D6b′). If D6b′ cannot read Y, it alerts anyway (§6). The
cost is at worst an alert about a Y that turns out to be an abandoned `incomplete` checkout, and only when Stripe
fails that one read. Without D6b′ it would surface only when Y
resumed, which is also when it starts charging again.

**Rejected: a scheduled scan of every org's Stripe customer.** It costs one list per org per tick to find what the
row's own writes already reveal.

### D7. A `past_due` org cannot mint a second plan (Q13)

**Decision.** `orgRowBlocksNewPlan` treats a row that **names a Stripe subscription** (`stripeSubscriptionId` not
null) and whose status is `past_due` (Stripe's `past_due` or `unpaid`, `sync.ts:51-53`) as having a plan. A
subscription-less `past_due` row is a grant, and only D5 judges it. Telling a grant org to "update the payment
method" would be false: no Stripe invoice or payment method stands behind a grant. The three flows refuse with: "This team's plan has an unpaid invoice, so a second
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
  cannot be bought here. Contact support at <email>."), and the cross-scope clauses below. When (c) refuses beside
  another org's live subscription on a shared customer, the copy is "This team's billing account carries another
  subscription we cannot place, so nothing new was started. Contact support at <email>.", with an operator alert.
- **The cross-scope clause (D2 (b) 4).** The refusal carries the clause for **that** `new_org` hold, by its state and
  `last_pay`, as ADR 0002 §5.5 chooses them. When the buyer is the hold's payer (`payer_key` is the buyer's user
  id), it is `holdClause(hold, { refusing: true })` verbatim (`lib/billing/new-org-hold-copy.ts:103`). Anyone else
  gets the same clause reworded so it names no person, amount or card. "An earlier checkout" becomes "this team's
  setup checkout":

  | Hold state, `last_pay` | Payer-neutral clause |
  |---|---|
  | `closing` / `cancel_unproven`, `awaiting`, `failed` or none | "We could not confirm that this team's setup checkout was closed, so nothing new was started. Try again in a few minutes." |
  | `closing` / `cancel_unproven`, `in_flight`; or `payment_in_flight` | "This team's setup payment is still being processed, so nothing new was started. A bank debit can take several business days; try again once it settles." |
  | `closing` / `cancel_unproven`, `capturable` | "This team's setup payment was authorised but not completed, so nothing new was started. The authorisation can stay for up to 7 days before it is released or completed; try again once it is." |
  | `closing` / `cancel_unproven`, `succeeded` | "This team's setup payment has just gone through and is being confirmed, so nothing new was started. Try again in a few minutes." |
  | `invoice_payable` | "We could not yet close this team's setup checkout's invoice, so nothing new was started. Try again in a few minutes." |
  | `refund_due` | "This team's setup payment went through after its checkout was cancelled, and its refund has not gone through yet, so nothing new was started. Contact support at <email> if this lasts." |
  | `needs_operator` | "We could not settle this team's setup payment automatically, so nothing new was started. Contact support at <email>." Then "We have raised an alert." **only when** the hold alerted in its current state entry (ADR 0002 I8). |

  (b) lists only `incomplete` subscriptions, and a hold on an `incomplete` X can only be in `closing`,
  `cancel_unproven` or `needs_operator` (ADR 0002 §3.3: the other open states need X ended). The other rows are
  defined so the clause is true wherever else the lookup meets a hold. `refund_pending` never blocks (Q10), so it
  has no row.
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
| P3 | the row names a Stripe subscription and is `past_due` (D7) | refuse: update the payment method | same | same |
| P4 | the row names no subscription and is a live, unexpired grant, in any of `active`, `trialing`, `past_due` (D5) | refuse: contract | same | same |
| P4′ | the row names no subscription and its grant has lapsed | go on to P5 | same | same |
| P5 | the lease is held past the wait | refuse: in progress | same | same |
| P6 | (a): an `org_plan` hold of O still blocks after one advance | refuse with the composed clauses | same | same |
| P7 | (a′): an earlier session of O's, keyed to O or keyless, is still `open` after its expire | refuse: unsettled | same | same |
| P8 | (b): an `incomplete` org-plan subscription of O not proven `never_paid`, or one under another scope's open hold | keep it; refuse with its clause (D8) | same | same |
| P9 | (b): a never-paid one whose hold could not be written (T0f) | refuse, no block promised; nothing voided or cancelled | same | same |
| P10 | (c): a live non-AI subscription on O's customer (F3's classifier) | refuse by its status (D2 (c)) | same | same |
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
| a different Y, stored `none` (an `incomplete` or a `paused` Y) | X paid | applies | **D6b′**: retrieve Y; alert only when it reads `paused` |
| a different Y, stored `past_due` | X not paid | ignored | R2 when X is `past_due` (live); else nothing |
| no subscription id, a live grant | X paid | applies (superseder) | **D6b** alert |
| no subscription id, a live grant | X not paid | ignored (`billing-sync.test.ts:367`) | ~~nothing~~ **alert (D6)** when X is live, and nothing for an `incomplete` X (**Note (2026-10-14, #6003, as built):** D4 and invariant O6 raise the two-live alert here; `reconcileAfterSync` in `lib/billing/org-plan-row.ts` reports X and the grant when X is live and the row is a live grant) |
| Y, and Y's `deleted` arrives | — | Y's `canceled` applies | **R1**: name the newest `active` sibling, else the newest `trialing`, else the newest other live one; two or more live → **D6c** alert; R1 named a paid (`active`/`trialing`) one → no cancellation email |

---

## 5. Invariants

ADR 0002's invariants I1–I16 hold for `new_org` as written. For `org_plan`, I1–I11 hold with "the user" read as
"the org", `user:` read as `org-plan:`, and the create-a-team steps replaced by D2's. I12–I16 are about setups, and do
not apply to `org_plan`. New:

- **O1, scope isolation (AC 8).** No reader that decides a create-a-team purchase, link or resume reads an
  `org_plan` hold. An org-plan reader reads a `new_org` hold in exactly one place: (b)'s scope-free `openHoldOn`, which
  keeps a subscription another scope's hold is deciding and refuses with that hold's clause (D2 (b) 4). The other
  cross-scope readers are the setup predicates of D1 rule 4, the partial unique index, and the webhook's
  subscription-keyed lookups.
- **O2, scope is fixed.** `scope` and `payer_key` are written at E0 and never change.
- **O3, the fence names the scope.** A state write succeeds only under the live lease `leaseKeyFor(scope, payer_key)`
  (D1, rule 1).
- **O4, never beside a live plan, a `past_due` plan, a live grant or a payable artifact.** No org-plan flow mints,
  hands out a Checkout URL or starts a trial while `orgRowBlocksNewPlan` is true, while an `open` session keyed to O
  or keyless remains on O's customer, while (b) keeps a subscription, or while (c) finds a live one (D2, D3, D5, D7).
- **O5, the row follows a live subscription.** When the row's subscription ends and a live org-plan subscription of
  O exists, the row names one within the same webhook delivery, a paid one first (R1). When a live subscription's write is refused, the
  row's subscription is re-read before the refusal stands (R2).
- **O6, two live are always reported, never cancelled.** Every write that reveals two live org-plan subscriptions,
  or one beside a live grant, alerts (D6a, D6b, D6b′, D6c). No detector path calls a Stripe write.
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
| D6b′'s retrieve | the write already applied is kept, and the alert is raised **anyway**, naming X and Y and saying that Y could not be read (fail closed). A redelivery could not re-detect it, because the row now names X | fail the event over a report; drop the report |
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

Every new test must fail on the `dev` head its slice starts from, on its assertion, unless the row labels it a
**pin**. A pin guards a behaviour `dev` already has, and that this ADR could break. It passes on `dev`.

| ID | Case | Source | Mechanism | Test |
|---|---|---|---|---|
| C1 | An org-plan hold blocks the same user's create-a-team purchase. | AC 8; 0002 §1.2 family 3 | D1 rule 3; O1 | **Pin** (on `dev` no hold has a scope, and `paymentHoldsOfPayer(U)` already misses a hold whose `payer_key` is O). N: an open `org_plan` hold in `payment_in_flight` for O, with `opened_by_user_id = U`. U's `createNewOrgSubscriptionIntent` mints. C3 is this rule's failing-first case. |
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
| C16 | The org-plan sweep closes a subscription that a create-a-team hold is deciding, or refuses with a false clause. | D2 (b) 4; B3 | cross-scope keep; D8 table | A2: X as in C15, with an open `new_org` hold. No hold is opened, nothing is voided or cancelled, and the purchase is refused. One case per row of D8's table, for a buyer who is not the payer: `closing` with `last_pay` `awaiting`, `in_flight` (matches `/several business days/`, not `/few minutes/`), `capturable` and `succeeded`; `cancel_unproven` with `failed`; and `needs_operator`, with and without an alert in its current entry (matches `/contact support/`; `/raised an alert/` only when alerted). The same hold for a buyer who **is** its payer gets `holdClause(hold, { refusing: true })` verbatim. |
| C17 | Webhook lag: Stripe lists an `active` plan while the row reads `none`. | AC 12; F3 | D2 (c) | A: F3's test, re-run after the move. `subscriptions.create` is not called. |
| C18 | (c) reads before the sweep, so a subscription adopted during (a) is missed. | 0002 I1 order | D2 (c) last | A2: a `closing` hold whose X reads `active` is released `adopted` in (a). (c) then refuses with "change the plan instead". No refund, no Q3 email. |
| C19 | `unpaid` or `paused` in Stripe is not "live" to the check. | D2 (c) | the full live set | A: a `paused` org-plan subscription refuses with the contact-support copy. An `unpaid` one refuses with D7's copy. |
| C20 | The lease expires mid-purchase: two payable org-plan subscriptions. | 0002-C52 | D3 | L: A's `org-plan:<O>` lease expires before its mint, and B mints. Exactly one secret is returned. A's only writes after the failed gate are `voidInvoice` and a cancel stamped `alethia:closeout`. |
| C21 | An intent and a Checkout in two tabs are not serialised. | D3 | one lease | A2 (O6): with `org-plan:<O>` held by an intent, `createCheckoutSession` waits, then its (b) finds the intent's `incomplete` subscription and closes or keeps it before it creates a session. |
| C22 | A Checkout URL leaves a request that lost its lease. | D3 | Checkout's gate | A: the renewal after `checkout.sessions.create` matches no row. `session.url` is not returned, and `checkout.sessions.expire` is called. |
| C23 | An earlier open Checkout of the same org is paid beside a new purchase. | Rev 4 Q11 | D2 (a′) | A2: an `open` session with `metadata.organization_id = O` is expired before the mint. A re-read showing `complete` leads (c) to refuse. A re-read still `open` refuses `UNSETTLED`. |
| C24 | A session keyed to another org on a shared customer is expired. | S17 | D2 (a′) | A2: an `open` session with `metadata.organization_id = O2` on O's customer gets no `expire` call, and O's purchase is not refused for it. |
| C25 | During the rolling deploy, an old pod and a new pod both run an org-plan purchase, or two new pods wait on each other. | D3 | both keys, one order | A: O4's flow takes `withPurchaseLock('org-plan:<O>')` first and acquires the lease inside it; the lease is released before the lock. O6's flow takes the lease alone. |
| C26 | The trial starts beside a blocking hold, a payable artifact or a live plan. | D3; Q5; advisory 5 | (a), (a′), (b), (c) | A (O4): with `org-plan:<O>` held, the trial waits. A2 (O6): an open `refund_due` `org_plan` hold refuses it; an `open` keyed session is expired first; an `incomplete` org-plan subscription whose payment is `processing` is kept and refuses it; a live one that only Stripe shows refuses it. |
| C27 | **Q13: a `past_due` org mints a second plan.** | 0002 retired C44 | D7 | A: the row names `sub_y` and is `past_due`. `createSubscriptionIntent` returns D7's copy, and calls no `customers.*`, `subscriptions.*` or `checkout.*`. O2 also changes F3's `it.each(["trialing", "past_due"])` case (#5979): `past_due` now expects D7's copy, `trialing` still expects "change the plan instead", and an `unpaid` case is added. |
| C28 | Checkout or the trial beside a `past_due` plan. | D7 | one predicate | A: the same row. `createCheckoutSession` and `startProTrial` each refuse with D7's copy. |
| C29 | **A purchase replaces an off-Stripe grant.** | K2 sequence 2 | D5 | A: the row is `enterprise`, `active`, with no subscription id and a future `currentPeriodEnd`. All three flows refuse with the contract copy, and nothing is minted. |
| C30 | A lapsed grant blocks a purchase for good. | D5; B2 | `isManualGrantExpired`; D7 needs a subscription id | A: the same row with a past `currentPeriodEnd` is not refused (**pin** for `active`: `dev` refuses no grant). The `past_due` variant, a subscription-less `past_due` row with a past `currentPeriodEnd`, is not refused either, and is not given D7's copy. That variant fails first once D7's arm exists without the subscription-id condition. |
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
| C44 | **B1: a keyless Checkout session opened before O4 is finished after an embedded purchase.** | money review B1 | D2 (a′) | A2: an `open` subscription-mode session with **no** session-level `metadata.organization_id` on O's customer is expired and re-read before the mint. If it re-reads `complete`, (b) and (c) refuse. If it is still `open`, the purchase refuses `UNSETTLED`. The trial (C26) and Checkout do the same. |
| C45 | **B2: an unexpired `past_due` grant is told to "update the payment method".** | money review B2 | D5; D7 | A: a row with no subscription id, status `past_due`, and a future `currentPeriodEnd`. All three flows refuse with the contract copy, which does not match `/payment method\|unpaid invoice/`. |
| C46 | A `paused` Y replaced by a paid X goes unreported until it resumes. | advisory 4 | D6b′ | W: the row names Y, stored `none`. `updated(X, active)` applies, the handler retrieves Y, and Y reads `paused`: one two-live alert. Y reads `incomplete`: no alert. The retrieve rejects: the event still succeeds, and one alert names X and Y and says Y could not be read. |
| C47 | R1 names a card-less trial over a paying plan. | advisory 15 | R1 order | W: Y is deleted. X1 is `active` and older, and T is `trialing` and newer. R1 names X1, with one two-live alert. |
| C48 | `alertOperator` is reachable as a server action. | advisory 10 | `lib/billing/operator-alert.ts` | `tests/lib/billing/operator-alert.test.ts`: the module has no `"use server"` directive, and it resolves false with the variable unset and true only when a delivery was queued. After O6, `billing.ts` exports no `alertOperator` (checked by `check:action-boundary`). |

That is 48 cases. C17 and C38 re-run an existing test, and each adds only what this ADR changes. C1 and C30's
`active` half are pins.

---

## 8. Not covered, and why

| Not covered | Why | What handles it |
|---|---|---|
| The AI subscription (`createAiSubscriptionIntent`) | A separate product, written to the AI slot only (`sync.ts:141-146`). It cannot take the plan row. | F2: its own `ai:<org>` lock, and no org-plan sweep touches it. No holds. A future scope `ai` would be an ADR of its own. |
| Holds for hosted Checkout's own payment | A session has no subscription until it completes, so there is nothing to void or cancel. | D2 (a′) expires earlier sessions, keyed or keyless; D3 gates the URL. |
| The trial's gate and close-out | It takes no payment. ADR 0002 K1 showed the gate needs a marker the webhook honours, which is not worth it for a subscription that cancels itself after 30 days without a card (`billing.ts:1711`). | D3: under the lease, it runs (row), (a), (a′), (b), (c) before it mints. |
| Renewals, dunning, plan changes, cancels and resumes | Not first payments (ADR 0002 §7). | As on `dev`. R1 changes what follows a dunning-ended `canceled` only when a paid sibling exists. |
| Credit packs, disputes, deployments with no Stripe | As in ADR 0002 §7. | As on `dev`. |
| Choosing which of two live plans to keep | A person's decision (D6, Q4). | The alert, and the operator in Stripe. |
| An org on a **legacy shared customer** whose customer also carries another org's live plan, or a live unlinked create-a-team subscription | (c) uses F3's classifier with no `organization_id` filter on purpose, so it refuses every purchase, Checkout and trial by O for as long as that subscription lives. That is the safe side: it never mints beside a subscription it cannot place. | The refusal names support. The operator's fix is the one F3's over-cap alert already describes: once nothing of O's is live on the shared customer, point O's `organization_billing.stripe_customer_id` at a new Stripe customer with no subscription history. New customers are no longer shared (ADR 0002 §4.2 (2)), so no new case arises. |
| The org-plan sheet showing `notice` | A UI change. | O7, `class:ui`, a draft until the maintainer accepts it (CLAUDE.md §4). Until then the clause still rides the response. |

---

## 9. Migration and rollout

The order, with §11 giving each step's PR boundary:

1. **The scope (O1).** The `scope` column, the index, the scope-aware fence, open, readers (including the org-plan
   reader and the scope-free `openHoldOn`), sweeper, script and emails. No `org_plan` hold exists yet, so behaviour
   is unchanged. C1–C8 pass on synthetic rows.
2. **The row predicates (O2).** D5 and D7 in all three flows, and the widened live set. These close live defects,
   with or without holds.
3. **The superseder and the detector (O3).** R1, R2 and D6 in the webhook and the row write, and the server-only
   operator-alert module. Independent of holds, and parallel with 1 and 2.
4. **The lease (O4).** Both org-plan purchase flows, and the trial, on `org-plan:<O>`, with the gate and the
   close-out, taking the old advisory key as well for one release. Checkout gains its session-level key and the
   30-minute `expires_at`.
5. **The backfill and the runbook (O5).** `payment-holds reconcile --backfill` widened to org-plan subscriptions: B1
   becomes "an org-plan subscription of some org (§2), or a create-a-team one", and B2–B6 are unchanged. A held
   org-plan subscription gets `scope = 'org_plan'` and `payer_key` = its `organization_id`. The runbook gains the
   org-plan rows.
6. **The flow on holds (O6).** D2 in full: drop the advisory key, I1 (a), (a′), (b), (c) for all three flows, the
   composer and `notice`, and the deletion of the memory-less path. **Deploy only when all three hold:** O4's
   rollout has been complete for more than 24h, which is the advisory key's precondition and B1's second guard
   (every keyless session has then reached Stripe's default expiry); an operator has run the widened backfill
   (step 5); and the backfill runs again once this rollout has completed, for the reason ADR 0002 §8 gives (old
   pods keep cancelling without holds until then).
7. **The notice in the sheet (O7, `class:ui`).**
8. **Scope required (O8).** `openHold` takes `scope` as a required argument, every opener passes it, and a
   migration drops the column's default. Rebase first (CLAUDE.md §5).

**What the backfill can and cannot find.** The memory-less org-plan path stamped none of its cancels
(`billing.ts:1287-1289`). B2's `cancellation_requested` therefore also matches a customer's own cancel. B3 (exactly one
invoice, `subscription_create`) and B4 (unpaid when it ended) keep a cancelled, used subscription out. Every cancel on
that path that it could not settle (a payment in flight, a payment it could not read, a void or a refund that
failed, a cancel it could not prove) alerted an operator (`billing.ts:1186-1252`, `:1298-1305`), so the backfill's
review list can be checked against those alerts.

**Rollback.** Every step is code, plus one additive column (its default dropped in O8). A reverted build leaves `org_plan` holds
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
- **Q5.** The trial: run (row), (a), (a′), (b) and (c) under the lease, without a gate on its own artifact (D3)?
  **Recommended: yes.** A gate needs rev 4's gate marker in the webhook, for a subscription that takes no payment.
  Running (a′) and (b) keeps the trial from starting beside a payable artifact in another tab.
- **Q6.** Expire an org's earlier open Checkout Session, keyed to O or keyless, before a new purchase, rather than
  refuse until it expires (D2 (a′))? **Recommended: expire**, as rev 4's Q11. The newest purchase is the one the customer wants, and a session
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
| O1 | **The hold scope (D1)** | `payment_holds.scope` exists with its check, its temporary default and the `(scope, payer_key)` open index. `leaseKeyFor` replaces `payerLeaseKey` in the store, the sweeper and the script. `openHold` takes an **optional** `scope` (default `new_org`), so `billing.ts:2105` is untouched. The create-a-team readers filter `new_org`. `store.ts` gains the org-plan reader `paymentHoldsOf('org_plan', orgId)` and the scope-free `openHoldOn(subscriptionId)`, tested here and first called in O6. `releaseHold` closes a setup only for `new_org`. The script lists `--scope`. The Q3 sender resolves the `org_plan` recipient. C1–C8, C32 (sender half) and C42 pass. | `apps/console/lib/db/schema/payment-holds.ts apps/console/lib/db/migrations/** apps/console/lib/billing/payment-holds/store.ts apps/console/lib/billing/payment-holds/sweeper.ts apps/console/lib/billing/payment-holds/emails.ts apps/console/lib/billing/pending-org-setup.ts apps/console/scripts/payment-holds.ts apps/console/tests/integration/payment-holds.test.ts apps/console/tests/integration/payment-hold-sweeper.test.ts apps/console/tests/scripts/payment-holds.test.ts apps/console/tests/actions/billing-new-org-holds.test.ts` | none (rebase first, CLAUDE.md §5) | **yes** | **yes** (a service-role table's fence and readers) |
| O2 | **The row predicates (D5, D7)** | `orgRowBlocksNewPlan` refuses a row naming an `active` or `trialing` subscription, a row naming a subscription and `past_due`, and a subscription-less row that is a live, unexpired grant, in `createSubscriptionIntent`, `createCheckoutSession` and `startProTrial`, before any Stripe call, each with its copy. F3's `liveOrgPlanCheck` keeps its classifier, and its status set gains `unpaid` and `paused`, with copy by status. F3's `it.each(["trialing", "past_due"])` assertion changes for `past_due` only (C27). C19, C27–C30 and C45 pass. | `apps/console/app/server/actions/billing.ts apps/console/tests/actions/billing-subscription.test.ts` | F2, F3 | no | no (money review yes) |
| O3 | **The superseder with a fresh read, and the detector (D4, D6)** | `lib/billing/org-plan-row.ts` holds R1 (with its `active` → `trialing` → other order), R2, D6b′, `reportTwoLive` and `isOrgPlanSubscriptionOf`. `lib/billing/operator-alert.ts` (server-only, no `"use server"`) carries the operator alert. The guarded write reports the subscription id and status it replaced. The `deleted` handler runs R1, and suppresses the cancellation email when R1 named a **paid** (`active`/`trialing`) sibling. A refused live sync runs R2. C33–C41 and C46–C48 (the module half) pass, and `billing-sync.test.ts` stays green. | `apps/console/lib/billing/org-plan-row.ts apps/console/lib/billing/operator-alert.ts apps/console/tests/lib/billing/operator-alert.test.ts apps/console/lib/billing/sync.ts apps/console/lib/billing/queries.ts apps/console/lib/billing/webhook-handler.ts apps/console/tests/integration/billing-sync.test.ts apps/console/tests/lib/billing/webhook-handler.test.ts apps/console/tests/lib/billing/sync.test.ts apps/console/tests/lib/billing/org-plan-row.test.ts` | none. **Parallel with O1 and O2.** | no | **yes** (the webhook) |
| O4 | **The `org-plan:` lease (D3)** | `createSubscriptionIntent` and `createCheckoutSession` run under the old advisory key (outer) **and** `org-plan:<O>` on `purchase_leases` (inner), with the fence, the mint deadline, the gate and the close-out. Checkout carries its session-level key and a 30-minute `expires_at`. The trial takes the lease. S17 is checked against the pinned SDK types and recorded in §1.3. C20, C22, C25 and C26 (the lease half) pass. | `apps/console/app/server/actions/billing.ts apps/console/lib/billing/purchase-lease.ts apps/console/tests/integration/payment-hold-lease.test.ts apps/console/tests/actions/billing-subscription.test.ts` | O2 (`billing.ts`), F2 | no | **yes** (the purchase path) |
| O5 | **The backfill and the runbook (§9 step 5)** | `reconcile --backfill` widens B1 to org-plan subscriptions and opens them as `org_plan` holds. The runbook documents the org-plan rows, the scope flag and the deploy order. C43 passes. | `apps/console/scripts/payment-holds.ts apps/console/docs/stripe-prod-runbook.md apps/console/tests/scripts/payment-holds.test.ts` | O1. **Parallel with O3 and O4.** | no | **yes** (an operator command that opens holds) |
| O6 | **The org-plan flow on holds (D2, D8)** | I1 (row), (a), (a′) with keyless sessions, (b), (c) as D2 says, in `createSubscriptionIntent`, `createCheckoutSession` and `startProTrial`, calling O1's org-plan reader and `openHoldOn`. The cross-scope clause by state and `last_pay`, and the org-plan composer and `notice`. `billing.ts` imports O3's `operator-alert.ts` and deletes its private `alertOperator`. `cancelNeverPaid`, `settleCancelledSubscription` and the memory-less outcomes and copy are deleted. The advisory key is dropped. `billing-subscription.test.ts:725-760` is flipped. C9–C18, C21, C23, C24, C26 (hold half), C31, C44 and C48 (the `billing.ts` half) pass. **Deploy only when O4's rollout has been complete for more than 24h and the O5 backfill has run, and run the backfill again after this rollout (§9).** | `apps/console/app/server/actions/billing.ts apps/console/lib/billing/org-plan-hold-copy.ts apps/console/lib/billing/new-org-hold-copy.ts apps/console/tests/actions/billing-subscription.test.ts apps/console/tests/actions/billing-org-plan-holds.test.ts` | O1, O3 (`isOrgPlanSubscriptionOf`), O4, O5 | no | **yes** (the purchase path) |
| O7 | **The notice in the upgrade sheet (D8)** | `components/org/upgrade-org-sheet.tsx` shows `notice` above the payment form. If the board labels it `class:ui`, it opens as a draft and stays one (CLAUDE.md §4). | `apps/console/components/org/upgrade-org-sheet.tsx apps/console/tests/components/org/**` | O6 | no | no |
| O8 | **`scope` required (D1)** | `openHold`'s `scope` is required, and every opener passes it: the create-a-team purchase (`billing.ts:2105`), the link's opener (`sweeper.ts:454`), the backfill (`scripts/payment-holds.ts:565`) and O6's org-plan opener. A migration drops the column's default. A test inserts a hold without `scope` and expects a `not null` violation. | `apps/console/lib/db/schema/payment-holds.ts apps/console/lib/db/migrations/** apps/console/lib/billing/payment-holds/store.ts apps/console/lib/billing/payment-holds/sweeper.ts apps/console/scripts/payment-holds.ts apps/console/app/server/actions/billing.ts apps/console/tests/integration/payment-holds.test.ts` | O6 (`billing.ts`, the migration chain) | **yes** | no |

Order: F2 and F3 first. Then O1, O2 and O3 in parallel. Then O4 (after O2) and O5 (after O1). They join at O6, then
O7 and O8 (in parallel: disjoint scopes). O1, O2 and O3 have disjoint scopes. O4 and O6 reach `billing.ts` after O2, and O5 reaches the script after O1,
which is sound because each runs after the one it shares a file with.

**What changes in ADR 0002 on acceptance.** §2's "the rev 4 notion of a purchase scope … is gone", §7's "The
org-plan purchase" and "Two live subscriptions on one org" rows, and Q13 are superseded by this ADR. That amendment
is a follow-up with its own scope, `docs/adr/0002-*`; this ADR's scope is its own file only.
