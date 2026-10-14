---
status: "Accepted (maintainer delegation 2026-10-08; veto window open)"
issue: "#5506"
date: 2026-10-04
accepted: 2026-10-08
---

# Payment holds on the first payment of a paid team setup

**Decision (accepted under the maintainer's delegation, 2026-10-08; veto window open).** The paid
create-a-team setup is the purchase that charges a card before the organization it pays for exists. Before that flow makes an earlier first-payment subscription
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

This replaces, for create-a-team, the "refuse without memory" behaviour that #5489 shipped. It was
written before any code, as #5506 requires. The maintainer delegated its acceptance on 2026-10-08:
the open questions are answered in §9, each with its reason, and any of them can still be vetoed by
number before the slice that builds it (§10) lands. It meets the ADR bar for two reasons. A new table and new webhook behaviour are hard to reverse. And a write-ahead row before a
Stripe call is surprising without this context. The alternatives (Stripe metadata as the store,
holds written after the fact) were real and are recorded below.

Every claim about today's code cites `file:line` at `origin/dev` `e02417059` (2026-10-08). Rev 6
re-checked every citation there. Rev 7 re-checked them at `37af47c95`: no file under
`apps/console/app/server/actions/billing.ts`, `lib/billing/`, `components/org/` or `lib/db/schema/`
changed between the two, so every line number still holds. Three billing changes merged after rev 5.1 and are now part of
"today": #5518 (`f586e91e5`, the row guard), #5549 (`835c01937`, N2) and #5539 (`9cb8b9539`, the
plan state the sheet shows). **Every path is relative to `apps/console/`**, including
`docs/stripe-prod-runbook.md` and `scripts/stripe-setup.ts`, which exist only there. There are two
exceptions: this ADR's own folder, `docs/adr/` at the repo root, and §10's `scope:` globs, which are
relative to the repo root, as the board's `scope:` lines are.

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
  | **K2.** W2 and W4: a row whose live Y ends while an unnamed live X exists drops to `community`; an off-Stripe grant is unprotected | `PRRT_kwDOPdRG6s6o0ENR` | **Closed by the narrowing.** Every two-live state the design created came from the org-plan, Checkout or trial flows: adoption beside a live plan (Q8), the Checkout detector, a failed trial close-out. All of them are out of scope. In scope, a new org has exactly one subscription. The live check returns `resume` beside a live create-a-team subscription instead of minting (§4.3). Rev 5.1: the link links X beside a row whose subscription is not live, and #5514 lets X take the row. It refuses only beside a live, paid one (§5.6). The org's other purchase flows refuse while the org's setup is unlinked (§5.7). The off-Stripe-grant sequence enters through `createSubscriptionIntent` or `startProTrial`, both out of scope. |
  | **K3.** The owed receipt: the webhook's fallback needs a lease it does not hold, and a T2 run by the purchase or the link never sends the owed receipt | `PRRT_kwDOPdRG6s6o0ENV` | **Addressed.** The owed-receipt mechanism and its two columns are removed. The receipt is decided by the fresh read alone: it is sent unless the subscription is ended (§5.3 (2)). That is sound because void-first means the machine never cancels a subscription whose first invoice is paid. This also answers the advisory about an `incomplete` subscription with no hold. |
  | **K4.** #5514's "Done when" admits implementations that break W1–W5 | `PRRT_kwDOPdRG6s6o0ENY` | **Addressed within the narrowed scope.** The contract shrinks to three rules on the **one** subscription the new org's row names (N1–N3, §5.3 (2)). It was checked against #5514's PR, #5518 at `4a306a0f6`. N1 and N3 hold and are tested. N2 does **not** hold: a write with no event time skips the order check, so the link's own stale sync can drop a paid org to `community` (C76). §8 step 3 is blocked on it, and #5518 has been told. |
  | **K5.** The sheet discards what the link returns, and turns every refusal into "Retry to complete setup" | `PRRT_kwDOPdRG6s6o0ENZ` | **Addressed.** The link returns a typed result. The sheet stops **before creating the org** when the resume lookup reports a held or ended setup. A refusal is non-retryable and carries its clause. A deferred plan is shown as processing. `components/org/pending-paid-setup.ts` and `components/org/create-org-sheet.tsx` are now in §8 step 4 and Q7 (§5.6). The success half ("Subscription active" for any state) is a live defect today, with or without holds. It is fixed separately by #5522. |

  **Revision 5.1** (the money review of `4332d792f`). One blocker. The link's one-subscription
  refusal could strand a paid X that would never be linked and kept renewing. Rev 5 had assumed
  that a new org has one subscription, but the org exists before the link runs, so the
  out-of-scope org-plan flow or the trial can write its row first. Three changes fix it:
  - The link refuses only beside a **live, paid** subscription (§5.6).
  - The org's own purchase flows refuse while the org carries an unlinked paid setup (§5.7, new).
  - A refusal that still happens opens a `needs_operator` hold on X, so a paid X is never left
    without an alert (C80).

  Five advisories were taken:
  - the receipt rule and the backup-card skip are scoped to held invoices (§5.3);
  - the sheet stops only where the link would refuse (§5.6);
  - T2 also adopts from `needs_operator` (T2o);
  - the refused-link clause now says what happened to the team.

  The review's two advisories:
  - The receipt rule for an `incomplete` subscription with no hold is now the same rule as for
    every other subscription (K3).
  - W1's Stripe reads inside the webhook transaction are no longer required. The narrowed
    contract needs no fresh read (§5.3 (2)). (Rev 6: #5518 as merged does make one. Its
    `customer.subscription.created` and `.updated` handlers sync a fresh `subscriptions.retrieve`,
    `webhook-handler.ts:110-121`. That is #5518's choice, and this design does not depend on it.)

- **Revision 6** (2026-10-08, the acceptance pass under the maintainer's delegation). It re-checks
  the text against `e02417059`, answers the open questions (§9), and adds the implementation slices
  (§10). What changed:
  - **#5518 and #5549 have merged, so §8 step 3's precondition is met.** N1, N2 and N3 hold on
    `dev`. C76 is tested at `tests/integration/billing-sync.test.ts:222` (§5.3 (2)).
  - **#5539 has merged.** The link now returns the plan state it read (`NewOrgPlanReport`,
    `lib/billing/new-org-plan-state.ts`). The sheet shows that state, not "Subscription active".
    The link's typed result (§5.6) builds on that report, and its "linked" arm carries the report
    unchanged. The §5.5 "link and defer" clause is replaced by #5539's copy.
  - **The deletion email.** `customer.subscription.deleted` now mails only when the deletion
    reached the row (`webhook-handler.ts:122-133`). §5.3 (4) is narrowed to match.
  - **New gap R6-1, fixed: §5.7's guard could block an org's plan purchases for good.** The guard
    refuses while `linked_at IS NULL`, and a refused link never sets `linked_at`. So an org created
    before a refused link could never buy a plan, and the guard's message sent the customer to a
    Create a team that would refuse again. A refusal now closes the setup (`closed_at`, §5.7), and
    the guard reads only setups that are still open (C85).
  - **New gap R6-2, fixed: #5539's payment link can point at an invoice a hold is closing.** For
    `action_needed`, #5539 returns Stripe's hosted invoice page. While a hold names X, that page
    asks the customer to pay an invoice the machine is about to void, or is refunding. No
    `paymentUrl` is returned while an open hold names X (§5.6, C84).
  - **New gap R6-3, fixed: an ended X with no hold, whose payment is not proven unmoved.** Rev 5.1
    refused it with the "nothing more will be charged" clause. That is true only when no money
    moved. When money may have moved, the link refuses with a contact-support clause and raises
    the alert. It does not refund: refunds come only from a hold (C34, C86).
  - Every `file:line` is re-pinned to `e02417059`. One rev-5 statement was false: it said no line
    cited in `lib/billing/pending-org-setup.ts` had moved by `7de07b4e8`, but
    `unlinkedPendingOrgSetupCustomers` had moved by five lines.
  - **No advisory is rejected.** Every advisory from the five reviews is taken, or is closed by the
    rev-5 narrowing, as the table above records.

- **Revision 7** (2026-10-08, the money review of `3bb3e8ca2`: three blockers, ten advisories). The
  review also confirmed a **live double-charge window on `dev`** (§1.1, "The link ignores a refused
  sync"), and S1 now closes it alone, first.
  - **R7-1 (blocker): `closed_at` had one writer, so I15 was false.** The sheet's pre-link stop and
    every setup whose link never runs again left the §5.7 guard on for good, and S1 shipped the guard
    with no writer at all. New invariant **I16**: no slice ships a guard without the writers that
    release it, and every open setup state has an exit. S1 now ships, with the guard: a closer that
    runs wherever an ended X is **read** (the link, both resume lookups and the guard itself, §5.7
    "Every open setup has an exit"); the link's refusal of a refused sync; and an audited operator
    command, `pending-org-setups close-setup`. The guard's message to a co-owner names the creator and
    offers support, and never says "finish the setup". New cases C87–C90.
  - **R7-2 (blocker): T2o plus `closed_at` stranded a paid, live, unlinked X.** A setup whose
    subscription has an **open hold** is never closed. A refusal while a hold is open leaves the setup
    open with `refused_reason`, and the hold's terminal transition closes it or links it (§5.6 "When a
    hold ends"). T2 and T2o adoption on a setup that has an org re-attempt the link. C57 and C80 are
    corrected; new cases C91 and C92.
  - **R7-3 (blocker): "ADR 0003" was taken** by #5548. F1 is now ADR 0004 (§10.2).
  - **Advisories, all taken:** (1) §4.3 names its record set, which includes org-created and closed
    records (C94); (2) S8's backfill is re-run after its rollout completes; (3) S3 removes S2's
    advisory lock key; (4) §8 step 3 no longer stamps the cancels, S8 does; (5) `forgetPendingOrgSetup`
    is specified (§8); (6) the Q3 email has one sender, the sweeper, and a claim column (§4.1, C95);
    (7) the Q10 two-charges window is stated in §3.1 and in the `refund_pending` copy; (8) C81's
    co-owner half is a real-Postgres integration test; (9) the guard also matches the org's
    `newOrgSubscriptionId` marker (C93); (10) the gap test is `:1524-1550`, not `:1522-1545`.

- **Revision 7.1** (2026-10-08, the delta review of `5eae33a88`: two blockers, six advisories).
  - **R71-1 (blocker): an open setup already linked in Stripe had no exit.** When the link throws
    after `subscriptions.update` (`billing.ts:1907`) and before `markPendingOrgSetupLinked` (`:1930`),
    X's metadata names the org and the org's row names X, but `linked_at` stays null. On `dev` the
    creator's return does not link it (the resume record carries `linked: state.linked`, so
    `runSteps` skips the link), and an `individual` payer's row stamps `declared_at`, so the setup is
    never offered again. Rev 7's "the creator returns" row was false for it. The setup closer now
    also **marks such a setup linked** (§5.7, the "adopt" branch), so the guard releases. New case C96.
  - **R71-2 (blocker): an X that Stripe cannot find had no exit.** `close-setup` now accepts an X that
    reads `resource_missing`, with the same `--reason` and log event (§5.4). Nothing closes on
    `resource_missing` automatically, because a wrong key makes every X read missing. New case C97,
    and a C90 variant.
  - **Advisories, all taken, all in S1:** (1) `alertPaymentNeedsSupport` takes a `context` so S1's
    alerts do not say "which the purchase flow cancelled or was replacing" (`lib/billing/payment-alert.ts`
    joins S1's scope); (2) "audit event" here means a **structured log event with a stable name**:
    the console has no billing audit table, and this ADR adds none (§5.4); (3) S1's scope gains
    `tests/components/org/paid-setup-plan-state.test.tsx` (its link mock gains `kind: "linked"`) and
    `apps/console/package.json` (the `billing:pending-org-setups` alias); (4) a failed Stripe read
    inside the guard **refuses** the purchase with a try-again message, never passes it (§5.5, C87);
    (5) only the caller whose compare-and-set returned the row raises the alert or logs the event
    (§5.7); (6) in `createSubscriptionIntent` the guard runs after the existing live-plan check
    (`billing.ts:1187-1194`).

- **Amendment** (2026-10-08, as shipped in #5715, S1). (a) The link's `org_has_plan` refusal also
  treats a `past_due` Y on the org's row as live (§5.6 "The refused sync"). (b) The refusal's alert
  is skipped in one case only (§5.6). (c) The co-owner's guard copy never says "finish" in any form
  (§5.5). Three follow-ups from the S1 review are recorded in the slices that own them (S9, S10).
- **Amendment** (2026-10-09, maintainer delegation: T14 timing wins over Q4's ~32h; #5774, S5b). The
  fifth failed refund attempt goes to T14 at once, so a person sees a failing refund after about 8h35m
  (5m, 30m, 2h, 6h), not about 32h. Q4's decision text is corrected to match.
- **Amendment** (2026-10-14, #5974; the maintainer decided on 2026-10-14 to amend, then build; it is
  accepted under the maintainer's delegation once its money review passes, as rev 7.1 was). The S9
  money review (recorded on #5506, 2026-10-13) found that a `link_refused` hold had no way out once
  support **moved** X to the right team, although the §5.5 clause promises that support "will refund
  it or move it to the right team". New: §5.8 (the moved release), event E2m and row T16m (§3.2,
  §3.3), a row in §5.7's exits table, cases C98–C102 and slice S11 (§10). I14's list of the closes
  that may happen while X is live gains this one, with the reason the invariant still holds (X is then
  an ordinary subscription of the team it was moved to). **No other decision changes.** Every
  `file:line` this amendment cites is at `origin/dev` `6f050e0b7` (2026-10-14), where S1–S9 have
  merged. Two deliberate departures from #5974's proposal are stated in §5.8: the flag is
  `--moved-to <team id>`, not `--reason moved --team <id>`.
  **Revised after the money review of #5980 (three blockers, seven advisories, all taken).**
  - B1: the moved release refuses when T is billed by another plan, `past_due` included. It checks
    the row before any sync, and also a Z the webhook already displaced (rows 11–12).
  - B2: X's customer, and so U's payment method, keeps paying after the move. The path refuses unless
    U is an active owner of T holding `manage_billing` (row 4), and the runbook covers the payment
    method.
  - B3: S10b's lookup keeps the link's alert (the second amendment below).
  - Advisories: `unpaid` and `paused` X are refused (row 8). T's row is re-checked under
    `FOR SHARE` inside the release transaction, so `store.ts` joins S11's scope. The audit event
    carries the row it saw. §5.7's "only in the last row" is corrected. C98 gains a plain-release
    control. C105's expected strings are pinned literally. The split of the free-plan sentence is
    stated.
  **Revised after the delta review of #5980** (two blockers and five advisories, all taken):
  - N1: an `incomplete` or unindexed Z on T is refused. Row 11 now refuses any non-`canceled` other
    subscription on T's row. Row 12 lists T's customers directly, with no index lag. New row 13
    (`too_soon`) waits 15 minutes when X's own sync has already replaced T's customer on the row. The
    command holds T's `org-plan:<T>` purchase lock from the Stripe reads through the commit. The one
    remaining window is named in §5.8.
  - N2: row 12 counts only org-plan subscriptions (`isOrgPlanSubscription`, F3's classification), so
    an AI add-on never refuses.
  - Advisories:
    - Stripe is read only after the database rows pass.
    - Every listing and search is capped, and a reached cap fails closed.
    - The audit event records what was listed.
    - The runbook needs T's owner's agreement before U is made an owner.
    - C109 uses two connections and a lock timeout.
    - S11's `sweeper.ts` scope is re-checked when S11 is filed.
  **Final pass after the second delta review of #5980** (no blockers; seven advisories, all taken):
  - The live observation is printed only after rows 1–4.
  - The payer's lease is renewed after the Stripe reads (`lease_lost`).
  - The named window gains the hosted-Checkout shape.
  - Row 4 and the runbook say that every later purchase of T bills U's customer.
  - S10b removes `billing.ts`'s private `isOrgPlanSubscription`.
  - Row 11's refusal says how to unstick a stale `none` row.
  - A typo is fixed.
- **Accepted by maintainer delegation 2026-10-14 after three adversarial money review rounds (PR
  #5980).** This covers both 2026-10-14 amendments (the moved release, §5.8 and S11; the ended
  lookup, §5.6 and S10b). As for rev 7.1, the veto window stays open until the slice that builds each
  one lands.
- **Amendment** (2026-10-14, #5974 widened; S10's lane found it). §5.6 sheet rule 1 could not be
  built as written for an **ended** X. The rule stops the sheet when "it reports X ended", but the
  lookup reports no such thing. `NewOrgSetupState` (`lib/billing/new-org-setup.ts:73-108`) carries
  only `hold`, which is null once X has ended with no open hold (`billing.ts:2979`, `:2987`). And
  `planState` cannot stand in for it. `not_active` also covers `paused` and unknown statuses
  (`lib/billing/new-org-plan-state.ts:84`, `:103`), which the link would **link**: the link refuses
  only `canceled` and `incomplete_expired` (`ENDED_SUBSCRIPTION_STATUSES`, `billing.ts:1261`, `:2691`).
  The sentences the link uses live in a `"use server"` file as private constants (`billing.ts:1`,
  `:922-929`). If the sheet copied them, it would show a false sentence for an X that a hold refunded
  and released. In that case no hold is open and the PaymentIntent succeeded, so `planState` is
  `not_active`, and the "could not confirm" sentence would appear where the link says "refunded in
  full" (`refuseEndedLink`, `billing.ts:2753-2782`; `latestReleasedHoldOn`,
  `lib/billing/pending-org-setup.ts:187-195`). So:
  - the lookup gains `ended: { clause } | null`, filled with exactly `refuseEndedLink`'s choice of
    sentence. Both read it through one helper outside the `"use server"` file, so the two cannot
    drift. The lookup keeps the link's alert, under the link's own rule (revised after the review
    of #5980, blocker 3).
  - rule 1 reads `ended`.

  This adds cases C103–C107 and slice S10b, which takes the ended half out of S10. Citations are at
  `origin/dev` `6f050e0b7`. No other decision changes. The one wording change is S10's done-when,
  whose ended half moves to S10b.
  - **Note (2026-10-14, money review of #6002):**
    - `ended` is set only for a setup that is **not linked**: X's metadata names no organization, and
      the setup record has no `linked_at`. The sheet does not call the link for a setup the server
      reports as linked, so the sheet must not stop there either.
    - When the lookup's own closer has just closed the record, the dedupe counts from the database's
      clock, read before the closer ran, instead of from `closed_at`.
    - The lookup's alert detail begins "a resume lookup of the setup reported it ended".
- **Notes** (2026-10-14, #6068: the text made true to code merged that day; **no decision changes**).
  - **The closer's lock (#6059, closing #6052).** §5.7 "Who alerts" described the close as one
    compare-and-set. It now also takes `LOCK TABLE payment_holds IN SHARE MODE`, behind a 2s
    `lock_timeout`, before that compare-and-set, so a hold write in flight commits first (I14,
    I16 (a)). A lock timeout fails closed. `close-setup` follows the same steps. New case C110.
  - **Who still closes `org_has_plan` beside a live Y (S9 follow-up 1, #5506, 2026-10-13).** I14's
    rev 7 and rev 7.1 sentences, §5.6's "From S9 on" sentence and §5.7's "two rows only" read as if
    only S1's link, before holds existed, ever closed a setup beside a live Y. That was never what
    §5.7's adopt branch says (rev 7.1, and C96's variant), and it is not what runs. Since S9 (#5938)
    the **link** no longer closes there: it passes `linkRefuses`, and refuses under a `needs_operator`
    hold. The **guard and both resume lookups** still run the adopt branch's S1 refusal: they close
    with `org_has_plan` and alert, and open no hold. Notes in I14, §5.6, §5.7 and §8 say so, and §8
    says which of those closures its listing prints: an `incomplete` X closed that way is not printed.
- **Amendment (2026-10-14, #6078; S9 follow-up 2, #5506): a failed relink of an adopted hold is
  retried.** Before it, a relink after an `adopted` release that threw (Stripe, the database) was only
  logged by the create-a-team purchase (`relinkIfAdopted`) and only alerted by the sweeper's visit
  (`relinkAfterVisit`). Nothing tried again, so X stayed unlinked to its team until an operator acted.
  The maintainer chose to keep the retry state on the released hold itself, with no migration
  (decision on #6078, option (a)). §4.1 gains one more kind of write, the **relink write**, on a
  released `adopted` `new_org` hold only. The `adopted` release now schedules a relink check, and the
  sweeper gains a relink pass (§5.4) that retries on a backoff until the relink is decided. A
  permanent failure ends in an alert, recorded once it reaches a channel. Money review of #6079
  (2026-10-14) fixed three things: the alert is raised before it is recorded; a lost lease counts as
  an attempt; and the tests cover the open-setup and open-hold predicates and the lost claim. New
  cases C111–C119.

---

## 1. Context

### 1.1 What the create-a-team flow does today (after #5489)

- **The flow.** `createNewOrgSubscriptionIntent` → `startNewOrgSubscription`
  (`app/server/actions/billing.ts:1563-1751`) mints a `default_incomplete` subscription with
  `metadata.created_by = <user>` and no `organization_id` (`billing.ts:1710-1720`). There is no org
  yet. The sheet confirms the card, creates the org, then calls `linkSubscriptionToNewOrg`
  (`components/org/pending-paid-setup.ts:495`, `:539-548`).
- **The record.** `pending_org_setups` (`lib/db/schema/pending-org-setups.ts:36-60`, migration
  `0159_ancient_lily_hollister`) is written before the client secret is returned
  (`billing.ts:1729-1749`). The customers of a user's unlinked records are reused and swept, capped at
  5 (`lib/billing/pending-org-setup.ts:217-235`).
- **The prior.** When the browser passes `priorSubscriptionId`, the flow reads it
  (`ownNewOrgSubscription`, `billing.ts:1774-1786`). A paid prior returns `resume`
  (`:1603-1610`). An `incomplete` or `incomplete_expired` prior is cancelled or settled only when
  `readFirstPayment` proves it `never_paid` (`:1611-1632`). A `canceled` prior has its latest invoice
  voided, and a void that fails refuses (`:1633-1650`). A `canceled` prior with a **paid** invoice is
  left alone, and a new subscription is minted.
- **The sweep.** Before minting, the flow lists the `status: "incomplete"` subscriptions of every
  customer it uses (`cancelIncompleteSubscriptions`, `billing.ts:1072-1096`, called at `:1692-1699`).
  The list is `limit: 100` and ignores `has_more` (`:1074-1078`). It lists **every** incomplete
  subscription on the customer, including an org-plan or AI one when the customer is shared. Each
  is cancelled only when `readFirstPayment` proves it `never_paid` (`lib/billing/first-payment.ts:43-76`).
- **Cancel, then prove.** `cancelNeverPaid` (`billing.ts:1028-1055`) cancels, then re-reads, and counts
  only `canceled` or `incomplete_expired` as gone (`:1008`, `:1033-1052`).
  `settleCancelledSubscription` (`:925-1005`) then re-reads the payments
  (`readPaymentAfterCancel`, `first-payment.ts:99-124`) and does one of the following:
  - voids when no money moved (`voidPayableInvoice`, `billing.ts:866-899`);
  - refunds when money was taken (`refundTakenPayment`, `billing.ts:820-835`, with the key
    `refund-cancelled-first-payment-<pi>` at `:826`);
  - otherwise alerts (`alertPaymentNeedsSupport`, `lib/billing/payment-alert.ts:31-57`) and refuses.
- **Nothing is remembered.** The sweep lists only `incomplete`, so a subscription this flow
  cancelled is invisible to the next request. The `PaymentOutcome` docblock says so (`billing.ts:685-704`).
  A test pins the gap for create-a-team: `tests/actions/billing-subscription.test.ts:1524-1550`.
- **Lock.** `withPurchaseLock` (`lib/billing/purchase-lock.ts:32-46`) runs
  `pg_advisory_xact_lock(hashtextextended('purchase:'+key))` in a transaction on a pooled service
  connection, with `lock_timeout = 30s` (`:22`). The key here is `new-org:<userId>` (`billing.ts:1582`).
  The pool is `poolMax`, default 10 (`lib/config/database.ts:20`). Nothing in the repo sets
  `idle_in_transaction_session_timeout`.
- **A Stripe customer is not 1:1 with a payer.** `ensureCustomer` stamps an org's customer with both
  `organization_id` and `created_by` (`billing.ts:666-670`). Create-a-team reuses any customer whose
  `created_by` is the caller, from the browser (`:1657-1663`) or from a record (`ownedCustomer`,
  `:1757-1767`), and never checks `organization_id`. So the create-a-team sweep can meet, and cancel,
  an existing org's `incomplete` org-plan or AI subscription. Linking rewrites the customer's
  `organization_id` to the new org (`:1903-1906`).
- **The link does not gate on the subscription's status.** `linkSubscriptionToNewOrg` retrieves the
  subscription (`billing.ts:1869`), checks only the customer and the metadata, rewrites both, and syncs
  (`:1869-1913`). It links an ended X as readily as a live one. It does not check whether the org's
  billing row already names another subscription. Since #5539 it returns the plan state it read
  afterwards (`Promise<NewOrgPlanReport>`, `:1860`, `:1935`; `readNewOrgPlanState`, `:1948-1971`).
  For `action_needed`, that report includes Stripe's hosted page for the open first invoice
  (`openInvoicePaymentUrl`, `:1989-2000`).
- **The link ignores a refused sync: a live double-charge window (rev 7, confirmed by the review of
  `3bb3e8ca2`).** `syncSubscriptionToBilling` returns `"applied" | "ignored"` (`lib/billing/sync.ts:105`,
  `:118-121`), and the link discards it (`billing.ts:1913`). It then marks the setup linked (`:1930`)
  and returns `readNewOrgPlanState(linked)` (`:1935`), which reads X's own status. The sequence:
  1. The tab pays X. The org O is created (`recordNewOrgCreated` stamps `created_org_id`,
     `lib/billing/pending-org-setup.ts:494-511`), and `setActiveOrganization` runs.
  2. The link throws before `subscriptions.update` writes `organization_id`, so no event for X writes
     O's row.
  3. The user opens O's billing. `createSubscriptionIntent` sees no row (`billing.ts:1187-1194`), and
     `ensureCustomer` mints a fresh customer, so X's customer is never swept. The user pays Y, and the
     webhook writes O's row naming Y, `active`.
  4. The retried link writes X's metadata. The sync of X is refused by the superseder rule
     (`queries.ts:249-258`), and the result is ignored. The link marks the setup linked and reports
     X's `active`, so the sheet toasts "Subscription active".

  X renews beside Y, and each renewal sends a receipt. `startProTrial` (a `trialing` Y) and
  `createCheckoutSession` reach the same state. S1 (§10) closes it.
- **The sheet shows the server's plan state, but has no refusal (rev 6).** `runSteps` keeps the
  link's report (`pending-paid-setup.ts:539-548`) and toasts it (`:582-593`), so "Subscription
  active" appears only for `active` (#5539). It still replaces any thrown error other than
  `SetupStopped` with "Retry to complete setup — you won't be charged again." and `retryable: true`
  (`:559-569`). The org is created **before** the link (`:495`).
- **Scheduled work already exists in-process.** `instrumentation.ts:27-60` boots `setInterval` loops,
  for example `startConnectionSweeper` (`:42-43`, `lib/cloud-providers/sweep.ts:204-212`), each with an
  optional twin behind `ALETHIA_CRON_SECRET` (`app/api/internal/connections/sweep/route.ts:1-40`).
- **Webhook redelivery.** A thrown handler marks the event `error` and returns 500
  (`app/api/webhooks/stripe/route.ts:67-74`), and a later delivery of an event that is not `done`
  runs again (`lib/billing/webhook-events.ts:38-45`). The handler runs inside one transaction that
  holds a per-event advisory lock (`runWebhookEventExactlyOnce`, `webhook-events.ts:92-121`).
- **What the webhook writes for a create-a-team subscription.** `syncSubscriptionToBilling` ignores a
  subscription with no `metadata.organization_id` (`lib/billing/sync.ts:123-129`). So **before the
  link**, no event for X writes any org row. **After the link**, X's events write the new org's row
  through #5518's guarded write (`webhook-handler.ts:103-121`, `sync.ts:157-170` →
  `applySubscriptionToBilling`, `queries.ts:288-337`), as does the link's own sync
  (`billing.ts:1913`). That write is conditional. A same-subscription event older than the stored
  watermark is refused. A write with no event time may not lower the lifecycle rank (#5549). A
  different subscription takes the row only when the row holds nothing live, or when it is paid and
  the row holds a `past_due` subscription or none (`queries.ts:125-150`, `:233-258`).
  `invoice.payment_succeeded` sends a receipt for any subscription invoice, whatever its status (`webhook-handler.ts:168-181`). `invoice.payment_failed` runs
  `attemptBackupPayment` (`:183-212`, `lib/billing/payment-methods.ts:67-…`) on the customer's backup
  cards. `customer.subscription.deleted` emails "subscription canceled" only when the deletion reached
  the row (`webhook-handler.ts:122-133`, `lib/email/billing-email.ts:262`). A deletion of a
  subscription the row does not name, which includes every unlinked create-a-team subscription, sends
  nothing.
- **The sheet is card-only.** It confirms with `stripe.confirmCardPayment`
  (`components/billing/billing-checkout-form.tsx:8`, `:309`). A `processing` bank debit, or a
  subscription that is `active` before it is paid (S4), reaches create-a-team only through a payment
  confirmed outside the sheet.
- **Machine cancels leave no mark today.** Every `subscriptions.cancel` the purchase code has made
  passes only an id (`billing.ts:1034`, `:1744`; `git log -G'subscriptions\.cancel\('` from
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
  (`refundTakenPayment`'s docblock, `billing.ts:812-819`).
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
| **Create-a-team subscription** | A subscription whose own metadata has `created_by` and no `organization_id` (`billing.ts:1717`). It becomes an ordinary org subscription once the link writes `organization_id` (`:1907-1909`). |
| **Payer** | The user id. There is no org yet, so the user pays. |
| **Classification** | A subscription belongs to user U's create-a-team flow when **its own metadata** has `created_by = U` and no `organization_id`, or when an open hold opened by U names it (I12). Anything else on the same customer is **not this flow's**: never swept, never held, never counted (§4.2). A shared customer is never evidence. |
| **Payment hold** | A row saying that one create-a-team subscription, which the flow touched, is not yet proven settled. While it is open, it blocks U's next create-a-team mint. |
| **Held invoice** | The invoice the hold was opened on: `latest_invoice` at the moment of the write-ahead. **The only invoice a hold ever reads, voids or refunds.** |
| **Settled** | The held invoice is `void`, or `paid` and fully refunded. Or the subscription became a live purchase that the user now owns (adopted). |
| **Live subscription** | Stripe status `active`, `trialing`, `past_due`, `unpaid` or `paused`. |

`PAID_SUBSCRIPTION_STATUSES` (`lib/billing/new-org-setup.ts:104-108`) is `active`, `trialing` and
`past_due`. **Live** is deliberately wider: an `unpaid` or `paused` subscription still exists.

~~The rev 4 notion of a **purchase scope** (`org_plan`, `new_org`, `ai`) is gone. Only one flow opens
holds, so a hold is keyed by its payer alone (§4.1). Widening is Q13.~~
**Superseded by ADR 0004 (2026-10-14), D1** (a hold scope per flow: `payment_holds.scope`, with every hold keyed by
`(scope, payer_key)`). The struck text is what this ADR said at rev 5 and stays true of the create-a-team code until
ADR 0004's O1 lands.

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

**The window this leaves, stated (rev 7).** While a hold is `refund_pending`, the user may mint and pay
Y. If X's refund then fails (T10f), the customer carries **two charges** (X's, not yet refunded, and
Y's) until T5's next refund attempt succeeds or an operator refunds it (T14). That is a delay on money
already owed back, not a second plan: X is ended. The `refund_pending` clause says so (§5.5), so
"not a second charge for the same thing" is never read as "never two charges at once".

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
| `operator` | An operator released it. Amendment (2026-10-14, #5974): this includes the moved release (§5.8), whose `release_note` names the team X was moved to. |

A failed **observation** (a Stripe read error) is **not** an event. It never moves a hold. It only
writes `attempts`, `last_error` and `next_check_at`.

### 3.2 Events

| Event | Raised by |
|---|---|
| **E0 `open`** | The create-a-team flow, under the lease, just before it voids or cancels a swept subscription or the prior. **Rev 5.1:** also the link when it refuses a live X (§5.6, the "live, paid plan" row). That row is written directly in `needs_operator` and alerts. It voids, cancels and refunds nothing. |
| **E1 `observe`** | `advanceHold(hold)` reads the subscription, the held invoice, that invoice's payments, and their refunds, and classifies them as **O** below. Callers, **each holding the user's lease**: (a) the create-a-team flow, for **every** open hold of its user, and the link for a hold on its subscription (§5.6); (b) the scheduled sweeper, for every hold that is **due**: `next_check_at <= now()`, or `nudged_at > observed_at` (§4.1, §5.4); (c) the operator's `show` and `reconcile`. The webhook only nudges (§5.3). |
| **E2 `operator_release`** | The audited operator command (§5.4). |
| **E2m `operator_release_moved(T)`** (amendment 2026-10-14, #5974) | The same command with `--moved-to <T>`, for a `link_refused` hold only, after support moved X to team T in Stripe (§5.8). |

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
| T2 | `closing`, `cancel_unproven` | `sub = live` | none. The flow treats it as the user's paid setup and returns `resume` (§4.3). **Rev 7:** the release runs §5.6 "When a hold ends": a setup with an org is re-linked, one without stays open for the resume. | `released(adopted)` |
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
| T2o (rev 5.1, corrected in rev 7) | `needs_operator` | `sub ∈ {active, trialing}` | none. A paid, live subscription is the customer's to keep, so waiting for an operator only delays their team. **Rev 7 (R7-2):** the release runs §5.6 "When a hold ends" in the same caller, under the same lease. A setup with an org is re-linked at once. A setup with no org stays **open**, so `findUnfinishedNewOrgSetup` resumes it and §4.3's live check returns `resume`, and the sweeper sends the Q3 "finish creating your team" email. A setup is never closed while this hold is open (I16), so a refusal earlier in the hold's life cannot hide X. Not for a hold opened by the link's refusal (C80), which carries `open_note = link_refused` and is the operator's. | `released(adopted)` |
| T15 | `needs_operator` | E1 `observe`, anything T2o does not match | Observe and record only. Never auto-releases. | `needs_operator` |
| T16 | any open state | E2 `operator_release(reason)` | Under the user's lease (up to 30s wait, refused if still busy). Prints the live observation, then writes `released_by`, `release_note` and an audit event with a compare-and-set on `version`. | `released(operator)` |
| T16m (amendment 2026-10-14, #5974) | `needs_operator` with `open_note = link_refused`, and no other | E2m `operator_release_moved(T, reason)` | Under the user's lease, as T16. Reads X, X's customer, U's membership of T, T's billing row and T's other subscriptions **fresh, after the lease is taken** (§5.8). Refuses with a typed code, and writes nothing, unless all of these hold:<br>- U is an active owner of T holding `manage_billing`.<br>- X reads `active`, `trialing` or `past_due`.<br>- X's and its customer's `metadata.organization_id` are T.<br>- Nothing else bills or is buying T: T's row, read before any sync, names no other subscription that is not `canceled`. No other non-ended **org-plan** subscription with `organization_id = T` is listed on T's customers or found by search. If X's own sync already replaced T's customer on the row, 15 minutes have passed.<br>- The command holds T's `org-plan:<T>` purchase lock from the Stripe reads through the commit.<br>- T's billing row names X, after at most one `syncSubscriptionToBilling(X)`.<br>- T is not the setup's own team. Makes no Stripe write. Then T16's compare-and-set on `version` writes `released_by` and `release_note = "moved to <T>: <reason>"`. The same transaction first checks T's row with `FOR SHARE`, and it must still name X. The same transaction closes the open setup (`hold_released`, §4.1). The audit event is T16's, with `moved_to`, the payer, the paying customer and the row it saw added. | `released(operator)` |
| T17 | any open state | `sub` reads a status outside these rows (`unpaid`, `paused` on an ended sub, an unknown value) | alert | `needs_operator` |
| T18 | `released` | any event | none (inert) | `released` |

### 3.4 Why void before cancel

Today the order is cancel, read, then void (`billing.ts:1034`, `:931`, `:946`). Between the cancel
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
  a refunded charge (`charge_already_refunded`, mapped at `billing.ts:830-832`), and the read runs
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
- **I14, a paid create-a-team subscription is never left live, unlinked and unwatched (rev 5.1).**
  The link links it, defers it, or refuses it with a `needs_operator` hold that alerts. And the
  org's own purchase flows cannot take the org's row while its setup is open (§5.7). **Rev 7:** a
  setup is never closed while X may still become live and unlinked: it closes only when X reads
  ended and no open hold names X (I16). Rev 7.1: the one other close is the operator's, on an X that
  Stripe reports `resource_missing` (§5.4), which no automatic writer does. An adoption re-links a setup that has an org (§5.6 "When a
  hold ends"), and since #6078 (amendment 2026-10-14) a re-link that throws is retried by the sweeper
  on a bounded backoff and ends, if it never succeeds, in an alert that is repeated daily until it reaches
  a channel (§4.1 "The relink retry"). **Amendment (2026-10-14, #5974):** there is one more close while X is live: the moved
  release (§5.8). It is the operator's too. It closes only after fresh reads show three things: X,
  its customer and team T's billing row all name T; nothing else bills or is buying T (§5.8 rows
  11–13, under T's purchase lock); and the payer U is an
  active owner of T holding `manage_billing`. U's payment method keeps paying for X. X is then an ordinary subscription of T, written to and
  watched through T's row (§2, "Create-a-team subscription"). It is not unlinked, so the invariant
  holds.
  **Note (2026-10-14, #6068; S9 follow-up 1, #5506):** the rev 7 sentence ("it closes only when X
  reads ended") and the rev 7.1 sentence ("the one other close is the operator's") leave out a close
  that §5.7 has specified since rev 7.1, and that runs: the setup closer's adopt branch. When X is
  not ended, its metadata names the setup's org O and user U, and O's billing row names another
  `active` or `trialing` Y after one sync of X, the closer closes the setup with `org_has_plan` and
  raises `alertPaymentNeedsSupport` with X as the subject (`settleOpenSetup`,
  `lib/billing/pending-org-setup.ts`; §5.7 "Adopt", C96's variant). It opens no hold. Since S9
  (#5938) the link passes `linkRefuses`, so this close is made only by the readers that run the
  closer without refusing: the open-setup guard and both resume lookups. X can then be live, or
  `incomplete` and still payable, with the setup closed; what watches it is that one alert, and
  §8's listing for an X that reads live when the operator runs it.
- **I15, the guard never locks the org out (rev 6, corrected in rev 7).** Every open setup has an
  exit that does not depend on the creator coming back (§5.7 "Every open setup has an exit"). Rev 6
  claimed this from one writer, the link's refusal, and the claim was false (R7-1).
- **I16, no guard ships without the writers that release it (rev 7).** A slice that adds a refusal
  also adds every write that lifts it, in the same PR. Two rules make the setup's exits sound:
  (a) **a setup whose subscription has an open hold is never closed**, by any writer; a refusal
  while a hold is open records `refused_reason` and leaves the setup open; (b) **a hold's terminal
  transition decides the setup**: `adopted` links it (or leaves it open for the resume when no org
  exists), and every other release closes it. Each half has a case (C91, C92).

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
- `notified_state`, `notified_at` (rev 7, Q3): the state whose email has been **claimed** for
  sending (`refund_pending`, `released:refunded` or `released:adopted`), and when. Null when no
  email was claimed. The sweeper is the only writer (§5.4).
- `opened_by_user_id`, `opened_by` (`purchase | backfill | link`), `open_note`
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
| **Notice stamp (amendment 2026-10-14, #6029)** | `stampHoldNotice`, after a response carries a hold's §5.5 clause | `notice_last_sent_at = now()` and nothing else: not `updated_at`, not `version` | No `version` check, no bump, no lease, and **no state predicate**: `WHERE id IN (…)`. The hint row's `state <> 'released'` filter does not apply, so a `released` hold's refund clause is stamped too. |
| **Notice claim (rev 7)** | the sweeper, before it sends a Q3 email | `notified_state`, `notified_at` and nothing else | No `version` check, no bump. `WHERE id = $1 AND notified_state IS DISTINCT FROM $s RETURNING id`. Only a returned row lets the email out. A send that throws writes `notified_state = NULL WHERE id = $1 AND notified_state = $s`, so the next tick retries. |
| **Relink write (amendment 2026-10-14, #6078)** | `writeAdoptedRelinkState` (`lib/billing/payment-holds/store.ts`), called only through `relinkAdoptedHold` (`sweeper.ts`) by the sweeper's visit, its relink pass and the create-a-team purchase | `attempts`, `last_error`, `next_check_at`, `alerted_at`, `version` and nothing else: never `state` or a `release_*` column | The state write's fence (`version` and the payer's live lease, one statement), **plus** `state = 'released' AND release_reason = 'adopted' AND scope = 'new_org'`. Sets `version = version + 1`. It is the only write on a released row that changes `version`. |

**The relink retry (amendment 2026-10-14, #6078).** A released `adopted` `new_org` hold carries the
retry state of its setup's relink (§5.6 "When a hold ends") in four columns that an open hold uses for
its own observations. Release is still terminal: nothing here changes `state` or a `release_*` column,
and nothing reopens the hold.

- **The schedule.** The release write of an `adopted` `new_org` hold sets `next_check_at = now()`,
  `attempts = 0` and `last_error = NULL`. The open hold's failed-observation count and last error are
  dropped there: they described observations, and the adoption ended those. Every other release, and
  an `org_plan` adoption (ADR 0004 D1 rule 4: it has no setup), sets `next_check_at = NULL` as before.
  The release schedules the check itself, so a relink that never ran (the process stopped between the
  release and the relink) or that threw with nothing recorded (its lease was lost) is still picked up.
- **Who records.** Every relink after an adoption runs through `relinkAdoptedHold` under the payer's
  lease: the visit's, the purchase's (`relinkIfAdopted`) and the relink pass's. It runs
  `relinkAdoptedSetup` unchanged, then records the outcome with the relink write, prepared on the
  hold's `version`:

  | The relink | The write | Alert |
  |---|---|---|
  | `linked`, `refused` (§5.6: a `link_refused` hold names X, or, with no invoice to hold, the refusal alerted), `no_setup` (linked or closed meanwhile), `no_org` (the creator's resume finishes it, §5.6) | `next_check_at = NULL` | none here: a refusal alerts as it always has (§5.6) |
  | `not_linked`: a check failed (another creator, a customer not minted by U, X linked to another team, U without `manage_billing`, an org U is not an active member of) | the alert decision below, with `last_error = why` | the check's own alert, held while the relink runs and raised through the alert decision |
  | `not_linked` because X reads ended | `next_check_at = NULL`, `last_error = why` | none: the setup closer closes that setup (§5.7) |
  | thrown, attempt *n* < 6 | `attempts = n`, `last_error`, `next_check_at = now + delay(n)` | none |
  | thrown, attempt *n* ≥ 6 | the alert decision below, with `attempts = n` and `last_error` | the give-up alert, with X as the subject (`context: "payment_hold"`), "failed *n* times" |
  | the lease is lost: the relink throws `PurchaseLeaseLostError`, or the renewal made before every relink write finds the lease taken over | none under the lost lease | none. The relink pass takes the payer's lease afresh, with a 0s wait, re-reads the hold, and records the loss as a **thrown attempt** (the two rows above). The visit logs it and carries on. The purchase (`relinkIfAdopted`) rethrows it, and the purchase ends as on any lost lease. In both cases nothing is recorded, and the check is left for the pass. A fresh lease that is busy means another caller holds the payer, and the next tick tries again. |

  The session's link (`linkSubscriptionToNewOrg`) adopts under its own advance and then runs the
  link's core itself (§5.6, the `closing` / `cancel_unproven` row). It records nothing on the hold.
  A link that succeeds or refuses takes the setup out of the pass's selection (linked, or
  `refused_reason = org_has_plan`). A link that throws leaves the release's check in place, so the
  pass retries it with no session, through `relinkAdoptedHold` and every check that makes.
- **The alert decision.** It follows the order the machine and the link's refusal use (I8): alert
  first, and record the alert only when it reached a channel.
  1. **Claim.** One relink write records the decision (`last_error`, and `attempts` for a give-up)
     and sets `next_check_at = now + RELINK_UNDELIVERED_ALERT_RETRY_MS` (24 h). When the claim matches
     nothing (another caller recorded first, prepared on a newer `version`), nothing is raised.
  2. **Alert.** The caller whose claim returned the row raises the alert. `alertPaymentNeedsSupport`
     returns whether it reached a channel.
  3. **Stamp.** Only when it did, a second relink write sets `next_check_at = NULL` and
     `alerted_at = now`. Nothing selects the hold again. When it did not (no operator org, no rule or
     channel, a throttle, an emit failure), the claim's check stays: 24 h later the pass runs the
     relink again, which may now link X, and otherwise decides and alerts again.
- **The bounds.** At most `RELINK_MAX_ATTEMPTS = 6` thrown attempts, a lost lease included, before the
  give-up. The delays after attempts 1–5 are
  `RELINK_RETRY_DELAYS_MS` = 5 min, 15 min, 1 h, 4 h and 12 h. So the sixth attempt runs about 17h20m
  after the first, and the alert follows it. Each delay counts from the app clock of the failed
  attempt. The pass runs on the 5-minute tick, so an attempt may run up to one tick late.
  So every attempt costs at most one relink, and a relink that always outlives its lease still
  reaches the give-up. After the give-up, a decision whose alert reaches no channel repeats once
  every 24 h until one does. That is one relink and one alert attempt per day for each such hold,
  for as long as no channel takes it.
- **What is guaranteed about the alert.** One caller raises each decision's alert: the one whose
  claim returned the row. Two ticks on two instances are serialised by the payer's lease, and the
  second's claim, prepared on the old `version`, matches nothing. `alerted_at` set means an alert
  reached a channel, and then nothing is raised again. While no alert has reached a channel, the
  decision is alerted again every 24 h. The alert can be raised **more than once** for one decision
  in two cases:
  - it reached no channel, so it is raised again by design;
  - the process stopped, or the lease was lost or a write failed, between the alert and its stamp.

  So the guarantee is **at least one delivered alert** whenever a channel takes it, and normally
  exactly one. It is not "exactly one". A relink write that fails is logged and raises nothing, and
  the check it would have moved stays as it was.
- **What the retry cannot do.** It runs `relinkAdoptedSetup`, so every check that function makes is
  made on every attempt, under the payer's lease and fence: X's and its customer's `created_by` are U,
  X names no other team, and `holdsManageBilling(U, O)`. It never links to a team U cannot manage. It
  never touches a setup that is linked or closed, because the pass does not select it and
  `relinkAdoptedSetup` returns `no_setup` for it.
- **Holds released before this amendment** carry `next_check_at = NULL` and are never selected. Their
  failed relinks were alerted by the visit, or logged by the purchase, under the old code.

**A release decides the setup (rev 7, I16).** The state write that moves a hold to `released`
also writes, in the same transaction, the `pending_org_setups` row whose `subscription_id` is the
hold's: for every `release_reason` except `adopted`, `closed_at = now()` and `closed_reason =
'hold_released'` when the row is still open. An `adopted` release leaves the row open, and its caller
runs §5.6 "When a hold ends" after the commit.

A hint write cannot change state, counters or schedule, so it needs no fence. A notice claim cannot
either, and its compare-and-set makes each email at most once per hold and state. A crash between
the claim and the send loses that one email; the `notice` (§5.5) still carries the clause. Because it never
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
(`billing.ts:1074-1078`). On a shared customer it can cancel an existing org's `incomplete`
org-plan or AI checkout.

1. **A subscription that is not U's is left alone.** It is reported to the operator with the
   subscription as the alert's subject, which the alert rule's throttle collapses
   (`payment-alert.ts:23-25`, `:50`). The alert has its own summary, not `alertPaymentNeedsSupport`'s
   fixed "which the purchase flow cancelled or was replacing" (`:38-40`). The purchase is **not**
   refused for it, because it cannot double-charge U's create-a-team purchase.
2. **No new sharing.** `ownedCustomer` and the browser-customer branch (`billing.ts:1657-1663`) also
   require that the customer has **no** `organization_id`. An org's customer, including one a
   previous link rewrote, is never reused for create-a-team.

### 4.3 The live check, against webhook lag (AC12)

Before minting, after the hold pass and the sweep, the flow lists
`subscriptions.list({ customer, status: "all" })` for every customer U's records name, fully paged,
and filters to U's create-a-team subscriptions.

**Which records (rev 7).** Every `pending_org_setups` row of U with `linked_at IS NULL`, **whether or
not `created_org_id` is set and whether or not it is closed**, keyset-paged and capped at 50
customers (over the cap, refuse), plus the customers of U's open holds. This is a new helper. It is
**not** `unlinkedPendingOrgSetupCustomers`, which excludes every record with `created_org_id` set
(`pending-org-setup.ts:227`) because it answers a different question (which customer to reuse). With
that helper, a paid, unlinked X whose org exists was invisible to I1 (c) (C94). A **live** one returns `kind: "resume"` through
`newOrgSetupStateFor` (`billing.ts:2036`), as the paid-prior path does at `:1603-1610`. A linked one
is no longer U's create-a-team subscription. It belongs to the new org, and its later purchases are
out of scope (§7).

### 4.4 The lease

**Key.** `user:<userId>`, taken by the create-a-team flow, the link, the sweeper and the operator
command. **Rev 5:** this replaces `new-org:<userId>` (`billing.ts:1582`). The org-plan flow keeps
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
3. **The artifact gate (I9).** After `subscriptions.create` returns (`billing.ts:1710`), and before
   `recordPendingOrgSetup` and the return (`:1729-1750`), the holder runs the same fenced renewal.
   **Only a renewal that returns a row lets the secret out.**
4. **The close-out exemption.** After a failed gate, the stale holder may make exactly the Stripe
   writes that close the subscription it created in this request, and nothing else. It voids Z's first
   invoice, then cancels Z, stamped `alethia:closeout` (S12). It writes **no hold row**: no payment can
   land on a subscription whose secret never left the server. Z carries no `organization_id`, so none
   of its events writes any org row (`sync.ts:123-129`, C67). **If the close-out fails**, Z stays
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
- `unlinkedPendingOrgSetupCustomers` (`pending-org-setup.ts:217-235`, `limit = 5`) moves to keyset
  pages over all of the user's unlinked records, capped at 50 customers. Over the cap, the flow
  refuses.

---

## 5. Failure handling for every external call

### 5.1 Stripe calls inside `advanceHold` and the create-a-team flow

Every read goes through `readTwice` (`billing.ts:842-848`). Every Stripe **write** below is preceded
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
| Lease acquire or renewal returning no row | Refuse with `PURCHASE_IN_PROGRESS` (`billing.ts:793-794`). After a mint, §4.4 rule 3. |
| `recordPendingOrgSetup` after the mint | As today (`billing.ts:1734-1749`), but as a close-out: void, then cancel stamped `alethia:closeout`, no hold row, and the secret is never returned. |

### 5.3 The webhook (`lib/billing/webhook-handler.ts`)

**The webhook makes no Stripe call for a hold.** The handler runs inside
`runWebhookEventExactlyOnce`'s transaction (`webhook-events.ts:92-121`). For holds it only *reads*
holds (one indexed query) and *writes* `nudged_at = now()` (a hint write, §4.1) on the ones the event
names, in the same transaction that marks the event `done`. After the response, the route wakes the
in-process sweeper without awaiting it. **No event is ever deferred or failed because of a hold.**

Four changes:

1. **No backup-card retry on a held or ended create-a-team subscription's invoice.** On
   `invoice.payment_failed` the handler runs `attemptBackupPayment` (`webhook-handler.ts:183-212`),
   which `invoices.pay`s the invoice with each of the customer's backup cards. On an `incomplete`
   first invoice that a hold is closing, or a cancelled subscription's still-open invoice (S1), **that
   is us charging a checkout we cancelled**. The fix (rev 5.1, scoped): skip the retry when a hold,
   open or released, names the invoice, or when the invoice's subscription is a create-a-team
   subscription (§2) that is not live. Then nudge. Every other invoice, including a renewal's dunning
   retry and an org-plan or AI first invoice, keeps today's behaviour (§7).
2. **The receipt and the org row.**

   **The receipt (rev 5, K3; scoped in rev 5.1).** On `invoice.payment_succeeded` for an invoice
   that a hold names (its held invoice), the receipt is decided by the subscription `subForInvoice`
   just retrieved (`webhook-handler.ts:48-54`):
   - **ended** (`canceled`, `incomplete_expired`): no receipt. The payment landed after our cancel,
     and the hold refunds it (T5). The refund is what the customer is told about (§5.5, Q3).
   - **anything else** (`incomplete`, live): send it, as today.

   Every invoice that no hold names keeps today's rule: a receipt whatever the status. That covers
   renewals, org-plan and AI invoices, and an ordinary create-a-team first payment with no hold. Only
   a held invoice can be a payment that is being refunded, because every create-a-team machine cancel
   has a hold (I4).

   §3.4 proves why an `incomplete` subscription with a paid invoice is a purchase the customer keeps.
   The machine cancels only after a void it proved, and a paid invoice cannot be voided (S2). So
   that subscription goes `active`, and no state the machine can reach takes it back. Revision 4
   held the receipt back for `incomplete` under a hold and sent it on adoption. That needed a
   lease-fenced column the webhook could not write, and a send that callers other than the sweeper
   were never told to make. Both are gone.

   **The org row: what this design needs from #5514 (rev 5, K4).** Before the link, X has no
   `organization_id`, so no event for X writes any row (`sync.ts:123-129`). While the setup is
   unlinked, the org's own purchase flows refuse (§5.7). The link links X only beside a row whose
   subscription is not live and paid (§5.6). So the row names X from the link on. Later purchases on
   that org are out of scope. Of rev 4's W1–W5, this design therefore needs only the rules about
   **one subscription's own events**, plus #5514's existing rule that another subscription may take a
   row holding nothing live (§5.6):

   - **N1, no regression by a stale or out-of-order event of the same subscription.** An event older
     than one already applied for X changes nothing. Two events stamped in the same second, `incomplete`
     and `active`, delivered in either order, end on `active`.
   - **N2, a write with no event time does not demote the subscription the row names.** The link's own
     sync (`billing.ts:1913`) writes the subscription object it read during the link. If X went
     `active` after that read and the webhook already applied `active`, the link's write must not take
     the row back to `none` / `community`. It may apply only when it does not lower X's lifecycle stage
     (`none` < live < ended).
   - **N3, a cancellation touches only the row that names it,** and never inserts a row.

   W2 (another live subscription), W5 (the AI columns) and W1's fresh read are **not** needed in this
   scope. N1 with a same-second tie-break meets the same purpose as W1 for one subscription. Revision
   4's live set (`unpaid`, `paused`) mattered only for W2.

   **Checked against `dev` at `e02417059` (rev 6). All three hold.** At rev 5, #5518 at `4a306a0f6`
   met N1 and N3 but not N2. A write with no event time skipped the order check, so the link's
   stale `incomplete` snapshot could overwrite the `active` the webhook had applied (C76). #5549
   (`835c01937`) closed that with a rank guard.
   - **N1.** The event-time watermark has a lifecycle tie-break (`sameSubscriptionMayApply`,
     `lib/billing/queries.ts:233-242`). Tested at `tests/integration/billing-sync.test.ts:172` and
     `:191`.
   - **N2.** A write with no event time may only hold or raise the lifecycle rank (`:238-240`, the
     #5547 block comment at `:205-232`). The C76 sequence is tested at `:222`, and the AI columns at
     `:238`. The link's sync passes no event time (`billing.ts:1913`), so it is exactly this case.
   - **N3.** An ended event updates only the row that names it (`queries.ts:307-321`). Tested at
     `:149` and `:163`.
   - **The superseder rule that the link's "not live and paid" row relies on** (`subscriptionMayApply`, `:249-258`) is tested
     at `:313`, `:327` and `:348`.

   **§8 step 3's precondition is therefore met.** One limit from #5547's comment matters to a future
   caller, not to this design. A no-event-time write of a `paused` subscription maps to `none` and is
   refused over a live row (`queries.ts:226-231`). No create-a-team code path observes `paused`.
3. **Events nudge holds.** `invoice.payment_succeeded`, `invoice.payment_failed`,
   `customer.subscription.updated` and `customer.subscription.deleted`, each for a subscription with an
   open hold, and `charge.refund.updated` for a PaymentIntent with an open hold.
4. **A cancel the machine made sends no "subscription canceled" email.** Since #5518,
   `customer.subscription.deleted` mails and reports revenue only when the deletion reached the row
   (`webhook-handler.ts:122-133`, `billing-email.ts:262`). So a machine cancel of an **unlinked**
   subscription is already silent, because no row names it. That covers every swept subscription and
   every close-out. One machine cancel is not covered: the hold on a **linked** X. The link deferred
   it (§5.6), its payment then failed, and the hold voided and cancelled it. The row names X, so the
   deletion applies and today it would mail "subscription canceled" for a plan that never started.
   Every machine cancel is stamped in `cancellation_details.comment` (`alethia:checkout_closed:<hold
   id>` or `alethia:closeout`, S12), and the subscription carries the stamp in the event
   (`Subscriptions.d.ts:364`). A stamped deletion still writes the row, but sends no email and no
   revenue event. An unstamped one keeps both.

`WEBHOOK_EVENTS` (`scripts/stripe-setup.ts:67-75`) already includes the four events in (3), but not
`charge.refund.updated` (Q6).

### 5.4 The sweeper and the operator commands

**The sweeper is required.** `startPaymentHoldSweeper()` is booted from `instrumentation.ts`, beside
`startConnectionSweeper` (`:42-43`) and in the same `registerLoop` shape, every 5 minutes. Each tick:

- selects the open holds that are due, oldest first;
- for each one, takes the user's lease with a 0s wait. A busy lease skips that hold for this tick;
- **(amendment 2026-10-14, #6078) the relink pass:** selects, oldest `next_check_at` first and at most
  50, the holds with `scope = 'new_org'`, `state = 'released'`, `release_reason = 'adopted'` and
  `next_check_at <= now()`. The payer's setup for the hold's subscription must be open (`linked_at` and
  `closed_at` null) and not refused `org_has_plan`, and no open hold may name the subscription. For
  each one, it takes the payer's lease with a 0s wait, re-reads the hold under it with the same
  predicate, and runs `relinkAdoptedHold` (§4.1 "The relink retry"). A lost lease is recorded as a
  failed attempt under a lease taken afresh with a 0s wait. The query joins `payment_holds`
  to `pending_org_setups` on `subscription_id` and `user_id::text = payer_key`. It needs no migration.

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
  an audit event (`billing.payment_hold.released`). Rev 7.1: an **audit event** in this ADR is a
  structured log line with that stable event name (and the subscription, operator and reason as
  fields), emitted only by the caller whose compare-and-set returned the row. The console has no
  billing audit table and this design adds none; the durable record is the row's own columns
  (`released_by`, `release_note` here; `closed_by`, `closed_note` for a setup). It is the way out of `needs_operator` and of the
  `unpaid` or `paused` dead end (AC9). **Rev 7:** the release decides the setup (§4.1): it closes it,
  or, when X reads live, runs §5.6 "When a hold ends", which links it. A live X whose link is refused
  makes the command refuse the release and print why (the org's row names a live Y): the operator
  first cancels and refunds X, or Y, in Stripe. **Amendment (2026-10-14, #5974):** or support moves X
  to the right team in Stripe and runs `release <X> --moved-to <team id>` (§5.8). That path exists only
  for a `link_refused` hold.

**The setup command (rev 7, shipped by S1).** `scripts/pending-org-setups.ts close-setup
<subscription_id> --reason "<text>" --operator <userId>` is the operator's exit for a setup no
reader can close (§5.7). It refuses with no reason. It reads X from Stripe and prints it with the
setup row. It refuses unless X reads ended (`canceled` or `incomplete_expired`) **or** Stripe
answers `resource_missing` for it (rev 7.1, R71-2: it then prints "X not found in this Stripe
account", so the operator can see a wrong key before closing). An operator who decides a live or
`incomplete` X must go cancels it in Stripe first (refunding it when it was paid), because closing
the setup of a live X would hide it from §4.3. Any other read failure refuses and writes nothing.
`resource_missing` is never closed **automatically**, by the closer or anyone else: a misconfigured
key makes every X read missing, and only a person can tell that from a reset test account. From S8 on
it also refuses while an open hold names X (I16): `payment-holds release` is the way out then.
Otherwise it writes `closed_at`, `closed_reason = 'operator'`, `closed_by` and `closed_note` with a
compare-and-set on `closed_at IS NULL AND linked_at IS NULL`, and, only when that returned the row,
emits the audit event `billing.pending_org_setup.closed` (a structured log line, as above, with
`x_read = ended | resource_missing`). A second run matches no row and emits nothing. The runbook
invokes it as `pnpm -C apps/console billing:pending-org-setups close-setup …`, an alias S1 adds to
`apps/console/package.json` on the `tsx scripts/…` pattern the other operator scripts there use.

**Who sends the Q3 emails (rev 7).** The sweeper, and nothing else. Each tick also selects every
hold whose state is `refund_pending`, `released(refunded)` or `released(adopted)` (the last only
when its setup has no org, §5.6), released within the last 14 days for the two released states,
and whose `notified_state` is not that state. For each one it
takes the notice claim (§4.1) and then sends. The purchase flow, the link and the operator command
move holds but never send, so an email cannot be sent twice by two callers, and a state entered by
any caller is mailed within one tick.

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
| `refund_pending` | "An earlier payment went through after that checkout was cancelled. We have issued its refund, and it is on its way back to you. If you buy again now and that refund fails, you may see both charges until we have refunded it again." (Rev 7: the second sentence states the §3.1 window.) |
| `needs_operator` | "…contact support at <email>…", plus "we have raised an alert" **only when alerted**. |
| `released(refunded)` or `released(already_refunded)` in the last 14 days | **Appended** to any of the above (C26): "An earlier payment was refunded in full; it can take 5–10 business days to reach you." |
| a link refused on an ended X with no hold, read `not_charged` (§5.6) | "This checkout was closed before its payment completed, so it was not linked to a team. It was not charged. A team already created for it stays on the free plan." (Rev 6: rev 5.1's "nothing more will be charged" is dropped. A cancelled subscription's open invoice can still be paid from a stale tab (S1), so the clause says only what the read proved.) |
| a link refused on an ended X with no hold, read anything else (§5.6, rev 6) | "This checkout was closed, and we could not confirm whether its payment went through, so it was not linked to a team. Contact support at <email> with the time of the payment." Add "We have raised an alert." **only when alerted**. Add "A team already created for it stays on the free plan." when one was. |
| a link refused beside a live, paid plan (§5.6), including S1's refused sync | "This team already has an active plan, so this payment was not linked to it. Contact support at <email>, who will refund it or move it to the right team." Add "We have raised this with support." **only when alerted** (I8). |
| §5.7's guard, to the setup's creator (rev 7) | "Your paid setup for this team has not finished, so a plan cannot be started here yet. Open Create a team to see where it stands, or contact support at <email>." From S8, when an open hold names X, the hold's clause replaces the first sentence. |
| §5.7's guard, to anyone else (rev 7; amended 2026-10-08, #5715) | "<Creator> started paying for this team's plan and it is still being set up, so a plan cannot be started here yet. Ask them, or contact support at <email>." `<Creator>` is the creator's name as the org's member list shows it, and "Another member of this team" when the creator is no longer a member. It never says "finish" or "finished", in any form: only the creator can finish the setup. |
| §5.7's guard found an open setup and its Stripe read of X failed (rev 7.1), to anyone | "We could not check this team's earlier paid setup just now, so a plan cannot be started yet. Try again in a few minutes." The guard fails closed: a read failure refuses and never passes the purchase. |
| a link that succeeded (§5.6, rev 6) | #5539's `NEW_ORG_PLAN_COPY[planState]` (`lib/billing/new-org-plan-state.ts`), unchanged. Its `processing` copy says the payment went through only when a PaymentIntent succeeded, and its `confirming` copy claims nothing about the outcome. Rev 5's own "link and defer" sentence is withdrawn. |
| T0h | The clause of the existing hold. |
| T0f | `UNCONFIRMED` text, with no promise of a block. |

"You won't be charged twice" appears **nowhere** in the create-a-team flow, its link or its sheet
(C32). **Rev 5:** that includes the sheet's own sentences (`pending-paid-setup.ts:92-97`, `:476-480`,
`:559-569`), which say "you won't be charged again" today. Inside this scope they say what is true
for that outcome instead. The org-plan flow's `PAYMENT_MAY_BE_UNDER_WAY` (`billing.ts:746-747`) is
out of scope (§7).

**Where a clause travels when the request mints.** The create-a-team `{ kind: "intent" }`
(`billing.ts:1750`) gains an optional `notice: string`, which the sheet shows above the Payment
Element. `notice_last_sent_at` means "returned", never "delivered". So the `released(refunded)`
clause is appended to every create-a-team response of that user for 14 days after `released_at`.

### 5.6 The link, the resume lookups and the sheet (rev 5: the sheet is in scope)

**The link consults holds and returns a typed result.** Right after the retrieve
(`billing.ts:1869`), **under the `user:<userId>` lease**, and **before any Stripe write**. The result
type is `{ kind: "linked" } & NewOrgPlanReport | { kind: "refused"; clause: string }` (rev 6). The
linked arm is #5539's report unchanged: `planState` from `readNewOrgPlanState` and its `paymentUrl`.

**A refusal closes the setup only when it is terminal (rev 6; corrected in rev 7, R7-1 and R7-2).**
Before it returns `refused`, the link writes `refused_reason` (`ended`, `held` or `org_has_plan`) on
U's row for X. It also writes `closed_at = now()` and `closed_reason = refused_reason`, but **only
when X reads ended and no open hold names X** (I16), in one statement:
`… WHERE subscription_id = $x AND linked_at IS NULL AND closed_at IS NULL AND NOT EXISTS (SELECT 1
FROM payment_holds WHERE subscription_id = $x AND state <> 'released')`. Every other refusal leaves
the setup open, and the hold that names X decides it when it ends ("When a hold ends", below). S1's closer has
no `payment_holds` table to read, and none is needed before holds exist; S8 adds the `NOT EXISTS`
to it and to `close-setup`. A
closed setup is no longer unfinished: `findUnfinishedNewOrgSetup` skips it, and §5.7's guard ignores
it. Its memory stays where it was: the hold row, and the `closed_*` and `refused_reason` columns.

Rev 6 closed on every refusal. That lost X twice: a `needs_operator` hold on an `incomplete` X could
adopt after the refusal (T2o), and then nothing listed X (R7-2); and the sheet's pre-link stop never
reached the link, so nothing closed the setup at all (R7-1).

**The refused sync (rev 7, S1).** The link no longer ignores what `syncSubscriptionToBilling`
returns (`billing.ts:1913`). It refuses with `org_has_plan` when the org's billing row names a
subscription other than X whose status is `active`, `trialing` or `past_due` (`namesOtherLivePlan`),
in two places. **Amendment (2026-10-08, #5715):** `past_due` is a deliberate widening for this
refusal only. The sync's row guard also refuses an X that does not supersede a `past_due` Y, so
without it the link would mark X linked while X and Y both bill, silently; the refusal sends both to
a person instead. **The setup closer's set is narrower on purpose:** its adopt branch closes a setup
with `org_has_plan` only beside an `active` or `trialing` Y (`LIVE_BILLING_STATUSES`,
`lib/billing/pending-org-setup.ts:632`), and leaves a setup beside a `past_due` Y open, because the
link refuses that case itself (`namesOtherLivePlan`): right afterwards when the link ran the closer,
and on the resumed link when a guard or resume lookup did. The two sets differ by design; do not
align either to the other:
- **before any Stripe write**, from the row as read; nothing is written to X or its customer;
- **after the sync**, when the sync returned `"ignored"` and the row, read again, still names such a
  Y. This is the race in which Y took the row between the first read and the sync. X's metadata
  already names the org here; nothing undoes that, and the alert below is what reaches it.

A refused link never reports a plan state, never calls `markPendingOrgSetupLinked`, never writes the
payer facts, and returns `{ kind: "refused", clause }` with the "already has an active plan" clause
(§5.5). It logs the stable event `billing.new_org_link.refused` (subscription, customer, org, the
row's subscription) and calls `alertPaymentNeedsSupport` with X as the subject. **Amendment
(2026-10-08, #5715):** the alert is skipped in exactly one case: this call's compare-and-set closed
nothing **and** the setup's `closed_reason` is already `org_has_plan` (an earlier refusal of the same
X raised the same alert). Every other case alerts, including no setup record, and a setup closed as
`ended`, `operator`, or already linked. An `"ignored"` sync
whose row names **X itself** is not a refusal: that is #5549's rank guard keeping a later `active`
(C76), and the link reports X's state as today. Neither is an `"ignored"` sync beside a row that
holds an off-Stripe grant while X is `incomplete`: that is link and defer (C77). (Amended: a row that
holds a `past_due` Y is refused, above.)
Until S9, the S1 refusal closes the setup (no holds exist yet, and S1's closer has no hold to wait
for). From S9 on, the `org_has_plan` refusal of a live or `incomplete` X opens the `needs_operator`
hold below, so the setup stays open (I16).
**Note (2026-10-14, #6068):** "the `org_has_plan` refusal" in the sentence above is **the link's**.
The link runs the closer with `linkRefuses` (`billing.ts`, before `linkSetupToOrg`), so the closer
writes nothing beside the live Y and the link's own refusal opens the hold (#5938). The guard and both
resume lookups run the same closer without `linkRefuses`, and it still closes beside an `active` or
`trialing` Y with `org_has_plan` and an alert, as §5.7's adopt branch says (I14 note).

| X, and any open hold naming X | The link returns |
|---|---|
| X is ended (`canceled` or `incomplete_expired`) and a hold names it | `{ kind: "refused", clause }` with the hold's clause (§5.5). X keeps its create-a-team metadata, and its hold keeps the user as payer (I12). Rev 7: an **open** hold leaves the setup open (`refused_reason = held`); its release closes it (§4.1). A hold already released closes it now. |
| X is ended, **no** hold names it **(rev 6, R6-3)** | The link reads the held-invoice payments as #5539's `readNewOrgPlanState` does. If it reads `not_charged` (no money moved), it returns `{ kind: "refused" }` with the "closed before its payment completed" clause. If it reads anything else (`not_active`: money may have moved, or the read failed), it returns `{ kind: "refused" }` with the "contact support" clause (§5.5) and raises `alertPaymentNeedsSupport` with X as the subject. **It refunds nothing.** Only a hold may refund (I3, C34), and a hold is opened only by a flow that voided or cancelled X. An operator decides this case (C86). |
| an open hold in `payment_in_flight`, `invoice_payable`, `refund_due`, `refund_pending` or `needs_operator` | `{ kind: "refused", clause }` with that hold's clause. Rev 7: the setup stays open (`refused_reason = held`), and the hold's end decides it. |
| an open hold in `closing` or `cancel_unproven` | Run `advanceHold` first (the link holds the lease). `released(adopted)`: link as below. A T4-shaped observation that is still open: **link and defer**. Otherwise X was just closed: refused, as in the first row. |
| **the org's billing row names a different subscription Y that is `active`, `trialing` or `past_due` (rev 5, narrowed in rev 5.1; `past_due` added by the 2026-10-08 amendment, #5715)** | `{ kind: "refused", clause }` with the "already has an active plan" clause (§5.5). Rev 6: the clause says "we have raised this" only when the alert returned true (I8). **Before** it returns, the link opens a hold on X in `needs_operator` (`open_note = link_refused`, T2o does not apply), which alerts with X as the subject and blocks U's next create-a-team. A paid, live X is therefore never left renewing without an alert (C80). With §5.7 in place, only a race can reach this row. Rev 7: the hold is open, so the setup stays open (I16) until an operator releases the hold. Checked both before the Stripe writes and after the sync ("The refused sync"). |
| the row names a different subscription Y that is **not** live and paid (`none`, `canceled`, or no subscription id) **(rev 5.1, corrected in rev 6; amended 2026-10-08, #5715: `past_due`, which includes Stripe's `unpaid` (`sync.ts:51-53`), moved to the row above)** | Link X as below. #5518's rule (`queries.ts:249-258`): any X, `incomplete` included, takes a row whose status is `none` or `canceled`. Only a **paid** X takes a row that holds a live status with no subscription id (an off-Stripe grant); an `incomplete` X takes such a row once its own `active` event arrives (C77). Y is untouched: an abandoned `none` Y expires (S3). |
| X `incomplete`, no hold | **Link and defer**: `{ kind: "linked", ...readNewOrgPlanState(X) }`. That is `processing`, `confirming`, `action_needed` or `unconfirmed`, with #5539's copy. |
| X live | Link as today: `{ kind: "linked", planState: "active", paymentUrl: null }`. |

**No payment link while a hold is open (rev 6, R6-2).** #5539 returns Stripe's hosted invoice page
for `action_needed` (`openInvoicePaymentUrl`). When an open hold names X, the link and both resume
lookups return `paymentUrl: null`. A hold in `closing` or `cancel_unproven` is about to void that
invoice, and in every later state the invoice belongs to a subscription that is ended. Paying it then
is at best a payment the machine must refund. The void-first order (§3.4) keeps a payment that wins
anyway from being cancelled under the customer, so this rule is about not inviting the payment
(C84).

**Link and defer** is today's link, unchanged: the metadata writes (`billing.ts:1903-1909`), then the
sync (`:1913`), which keeps the org on `community` while X is not live (`sync.ts:150-156`). X now
carries `organization_id`, so the webhook that reports X `active` applies the plan. That relies on
N2, which holds on `dev` since #5549 (§5.3 (2), C76). If X's payment later fails, the hold that names X voids and cancels it.
With no hold, Stripe expires it (S3). The team stays on `community`, and nothing is charged.

**When a hold ends (rev 7, R7-2).** A hold's release decides the setup whose `subscription_id` is
the hold's (I16 (b)):
- **Any release except `adopted`:** X is ended, or settled for good, so the release's own state write
  closes the setup (`closed_reason = 'hold_released'`, §4.1).
- **`adopted` (T2, T2o, or T16 on a live X), and the setup has an org** (`created_org_id`, or the
  org's `newOrgSubscriptionId` marker): the caller that released it runs the link's core for that
  setup at once, still under U's lease. The core takes no session. It re-checks what the session
  checks: X's `metadata.created_by` and its customer's `created_by` are U, and U still holds
  `manage_billing` in that org (an authorization check for U, not for whoever runs the sweeper). A
  link that succeeds marks the setup linked. A link that is refused takes the §5.6 table's row: beside
  a live, paid Y, a new `needs_operator` hold (`link_refused`) opens and alerts, and the setup stays
  open. A U who no longer holds `manage_billing` gets no link; the caller alerts with X as the subject
  and leaves the setup open for an operator.
- **`adopted`, and the setup has no org:** the setup stays open. `findUnfinishedNewOrgSetup` returns
  it (X is paid), §4.3's live check returns `resume` for it, and the sweeper sends the Q3 email that
  the payment went through and the team can be finished from Create a team (§5.4).

Between S8 and S9 the re-link does not exist yet: an adopted setup with an org stays open, and the
creator's next Create a team links it through today's link.

**Note (amendment 2026-10-14, #6078):** "at once" is the first attempt, not the only one. A re-link
that throws is retried by the sweeper's relink pass on a bounded backoff, and a permanent failure ends
in an alert, recorded once it reaches a channel (§4.1 "The relink retry"). A `not_linked` check is a
decision for an operator, not a transient failure. It alerts through the same decision and is not
retried, except a day later when its alert reached no channel.

**The resume lookups report a held setup.** `NewOrgSetupState` (`lib/billing/new-org-setup.ts:72-103`)
gains `hold: { state; notice } | null`, and `resolveNewOrgSetup` (`billing.ts:2107`) and
`findUnfinishedNewOrgSetup` (`:2158`) fill it. A held setup is never reported as resumable. A
reported hold is not a settling plan state, so #5539's re-read loop (`pollSettlingPlanState`,
`pending-paid-setup.ts:615-654`) stops on it.

**The lookup reports an ended setup (amendment 2026-10-14, #5974; S10b).** `NewOrgSetupState`
(`lib/billing/new-org-setup.ts:73-108`) gains `ended: { clause: string } | null`.
`newOrgSetupStateFor` (`billing.ts:2924-2996`) fills it, so both `resolveNewOrgSetup` (`:3032`, which returns it at `:3052`) and
`findUnfinishedNewOrgSetup` (`:3083`) carry it. Today the second calls it only for a paid X
(`:3124`, `:3139`, each behind a paid-status check at `:3105` and `:3137`), so for it `ended` is always null.
- **When it is set.** No open hold names X (the `openPaymentHoldOn` read at `:2979` returned null),
  and X's status is in `ENDED_SUBSCRIPTION_STATUSES`, which is `canceled` or `incomplete_expired`
  (`billing.ts:1261`). That is exactly the link's condition for `refuseEndedLink` (`:2691`). And
  (note of 2026-10-14) the setup is **not linked**: X's metadata names no organization, and the setup
  record has no `linked_at`. The sheet does not call the link for a linked setup. With an
  open hold, `ended` is null and `hold` carries the hold's clause, as in the link, which reads holds
  first. A `paused` X, or one with an unknown status, is **not** ended: the link would link it. So
  `planState` is never the test.
- **Which sentence.** The choice moves out of `billing.ts`, which is a `"use server"` file
  (`:1`) and so can export only async actions, into two pure exports of
  `lib/billing/new-org-setup.ts`. That module is already imported by both the server and the sheet,
  and has no `server-only` import.
  - `endedSetupRead(releasedReason: PaymentHoldReleaseReason | null, planState: NewOrgPlanState):
    "refunded" | "not_charged" | "unconfirmed"`. It returns `refunded` when the newest released hold on
    X (`latestReleasedHoldOn`) has reason `refunded` or `already_refunded`. Otherwise it returns
    `not_charged` when `planState` is `not_charged`. Otherwise it returns `unconfirmed`. These are
    `refuseEndedLink`'s three branches (`billing.ts:2754-2767`).
  - `endedSetupClause(read, { alerted, teamExists }): string`. It returns the §5.5 sentences now held
    in `billing.ts:922-929`, which move into this module, and **two of them change shape (review
    advisory 5)**.
    - `LINK_REFUSED_NOT_CHARGED` and `LINK_REFUSED_REFUNDED` each carry the free-plan sentence inside
      the constant (`:922-923`, `:927-928`). Both are **split**: the moved constants end before
      " A team already created for it stays on the free plan.", and that sentence becomes
      `LINK_REFUSED_FREE_PLAN` (`:929`), appended once, only when `teamExists` is true, for all three
      reads.
    - A builder who keeps the embedded copy and also appends the constant prints the sentence twice.
      C106's byte-for-byte literals catch that.
    - The alert sentence is added only for `unconfirmed`, and only when `alerted` is true.
  - `refuseEndedLink` calls both with `teamExists: true`, because the link runs only once the team
    exists. So its three strings stay byte for byte what they are today. Its alert behaviour is
    unchanged.
- **The lookup's inputs.**
  - `releasedReason` is `latestReleasedHoldOn(X)?.release_reason ?? null`.
  - `planState` is the report the lookup already reads (`readNewOrgPlanState`, `:2980`), the same
    read `refuseEndedLink` makes.
  - `teamExists` is `org !== null`.
  - `alerted` is decided by `refuseEndedLink`'s own rule (`:2768-2777`), through one billing.ts
    function both call (next bullet). `closedAt` comes from the setup row read **again after**
    `settleOpenSetupQuietly` (`:2956`), because that closer may just have closed it.
- **The alert: the link's, under the link's rule (revised after the review of #5980, blocker 3).**
  - **The function.** The alert half of `refuseEndedLink` (`billing.ts:2768-2777`) becomes one
    billing.ts-private function, `alertEndedUnconfirmed(sub, record, trigger)`. Both callers use it:
    the link with `trigger: { link: orgId }`, and the lookup with `trigger: "resume"`. The two
    callers cannot drift, because there is one function.
  - **What it does.** It runs only when the read is `unconfirmed`, and returns whether an alert
    reached a channel.
    1. It returns true, raising nothing, when `alertedAboutSince(X, record?.closed_at ?? endedAt)`
       (`:2790`) finds a delivered alert. That is the link's dedupe, unchanged. In the lookup, when
       its own closer has just closed the record, the database's clock read before the closer replaces
       `closed_at` (note of 2026-10-14).
    2. Otherwise it calls `alertPaymentNeedsSupport` with X as the subject and
       `context: "setup_closed"`, and returns what that call returns.
    3. Its `detail` is the link's (`:2776`), except the first clause, which says who read it: "the
       link to team <id> was refused" or "a resume lookup of the setup reported it ended" (note of
       2026-10-14).
  - **Why the lookup must alert.** The reason is `refuseEndedLink`'s own comment
    (`billing.ts:2743-2747`). The closer reads the payments at its own moment, and a stale tab can pay
    a cancelled X's open invoice afterwards with no hold opened. So a close that alerted nothing is
    followed by this alert. On `dev`, the sheet reaches the link for an ended X and the link raises
    it. Rule 1 now stops the sheet before the link, so the lookup must carry the same watch.
    - The closer cannot carry it. It returns at once for a closed row (`billing.ts:3015`), and alerts
      only in its own close branch (`lib/billing/pending-org-setup.ts:988-996`).
    - So a setup closed earlier with `never_paid`, closed by a hold release (`hold_released`), or
      closed with an alert that reached no channel would otherwise lose the alert.
  - **Where it sits.** The alert lives in the lookup, a server read. The sheet's stop itself still
    writes nothing.
  - **What it does not dedupe.** Two concurrent lookups, or a lookup and a link, can each alert once
    before either delivery row exists. That is the same window the link has on `dev` today, and the
    alert rule's throttle is its only bound.
  - **The clause** claims an alert only when one reached a channel (I8): this call's, or the
    delivered one that silenced it.

**The resume lookups close what they read as ended (rev 7, R7-1; shipped by S1).** Both lookups
already retrieve X (`billing.ts:2115`, `:2175`). When X reads ended and the setup is open, they run
the setup closer (§5.7 "Every open setup has an exit") **before** they answer, so the sheet's
pre-link stop (sheet rule 1) needs no write of its own: the server has closed the setup by the time
the sheet sees "ended". On `dev`, `findUnfinishedNewOrgSetup` drops an `incomplete_expired` record
only when it has no org (`forgetPendingOrgSetup`, `pending-org-setup.ts:128-147`); a record with
`created_org_id` set was skipped and kept open for good. It is now closed instead.

**The sheet (rev 5, K5).** `runSteps` (`components/org/pending-paid-setup.ts`) changes in four places:

1. **Stop before creating the org, only where the link would refuse (rev 5.1).** `resolveNewOrgSetup`
   runs before the org is created (`:476`). It reports X ended (amendment 2026-10-14: `ended` is set;
   see "The lookup reports an ended setup" below, and the run throws `SetupStopped(ended.clause)`), or
   a hold in `payment_in_flight`,
   `invoice_payable`, `refund_due`, `refund_pending` or `needs_operator`. In those cases the run throws
   `SetupStopped(notice)` **before** `authClient.organization.create` (`:495`), and the browser
   record is cleared, because the server keeps the memory. Rev 7: this rule also runs when the org
   already exists (`server.org` set, `:483-492`), and the stop writes nothing: the lookup has already
   closed an ended, unheld setup, and a held one stays open until its hold ends (I16). A hold in `closing` or `cancel_unproven`
   does **not** stop the run. The link advances it under the lease, and adopts, defers or refuses
   it (the link's `closing` / `cancel_unproven` row). That way a card payment that succeeded while another tab's sweep opened a hold
   is linked, not stopped.
2. **Render the link's result.** `{ kind: "refused" }` throws `SetupStopped(clause)`: non-retryable,
   with the clause as the message. The browser record is then cleared, because the server keeps the
   memory (the hold row, and the `pending_org_setups` row: closed when X is ended and unheld, open
   with `refused_reason` while a hold decides it), and a retry would only be refused again. An org created before a racing refusal stays on the free plan, and the clause says so.
   The linked arm is carried to the outcome as #5539 carries the report today (`:548`).
3. **No false success. Already true on `dev` (#5539).** `done` carries `planState`, and the toast
   and the final view show it (`pending-paid-setup.ts:582-593`). "Subscription active" appears only
   for `active`. This design changes nothing here.
4. **The generic retry text is true only for a thrown error.** "Retry to complete setup" stays for an
   exception (an outage), and loses "you won't be charged again". A typed refusal never reaches it.

**Reachability.** The sheet is card-only (§1.1), so a T4-shaped X at link time is mostly the seconds
between a succeeded card payment and the invoice settling. The rules do not depend on which.

### 5.7 An org with an unlinked paid setup (rev 5.1)

The org is created **before** the link, and `setActiveOrganization` puts the user inside it
(`pending-paid-setup.ts:495-501`, `:532`). If the link then fails once, the user can open the org's
billing and start a plan or a trial there:
- `createSubscriptionIntent` checks only the row's `active` or `trialing` (`billing.ts:1187-1194`);
- `startProTrial`'s `accountHasLiveSubscription` reads only org rows (`:1411-1421`);
- neither can see an unlinked X.

So a second subscription Y can name the org before X does. That breaks the assumption §5.3 (2)
relies on, and it would strand X (C80). The review of `4332d792f` found it.

**The guard.** `createSubscriptionIntent`, `createCheckoutSession` and `startProTrial` refuse for an
org that an **open** `pending_org_setups` row names. Open means `linked_at IS NULL AND closed_at IS
NULL`. A row names the org when `created_org_id = <org>`, **or** (rev 7) when its `subscription_id`
is the subscription in the org's own `newOrgSubscriptionId` marker (`NEW_ORG_SUBSCRIPTION_KEY`,
`lib/billing/new-org-setup.ts:25`, read with `newOrgSubscriptionIdOf`, `:44`). The marker is
written in the same insert as the org row, so the guard holds even when the `afterCreateOrganization`
write of `created_org_id` (`recordNewOrgCreated`, `pending-org-setup.ts:494-511`) failed (C93). The
message depends on who is buying (§5.5, rev 7): the creator is sent to Create a team or support,
and anyone else is told who started the setup and offered support, never "finish the setup", which
only the creator can do. Rev 6's "and nothing more will be charged" is dropped: nothing proves it
at that point. The guard changes those three out-of-scope flows only for this one case, and it is
the only change this design makes to them. `createAiSubscriptionIntent` is not gated: an AI price
routes to the AI columns only (`sync.ts:141-146`, `:215-234`), so it cannot take the plan row from X.

**Guard order and failure (rev 7.1).** In `createSubscriptionIntent` the guard runs **after** the
existing live-plan check (`billing.ts:1187-1194`), so an org on a live plan still reads "change the
plan instead", and the guard's copy appears only where a purchase could otherwise proceed. In all
three flows the guard **fails closed**: when it finds an open row and its Stripe read of X (the
`subscriptions.retrieve`, or the closer's `readFirstPayment`) throws, it refuses with the
try-again clause (§5.5) and never passes the purchase.

**Every open setup has an exit (rev 7, R7-1, I15, I16; rev 7.1, R71-1).** The setup closer is one
function in `lib/billing/pending-org-setup.ts`. The guard, both resume lookups and the link run it
before they answer. It has two branches, and nothing else in it writes:

- **Close.** It closes a setup (`closed_at`, `closed_reason`) only when X reads ended (`canceled` or
  `incomplete_expired`) and, from S8, no open hold names X. When X ended and `readFirstPayment` does
  not read `never_paid`, it also raises `alertPaymentNeedsSupport` with X as the subject, because
  money may have moved on a setup nobody will finish; it refunds nothing (I3).
- **Adopt (rev 7.1).** It marks a setup **linked** (writes `linked_at`, as the link's last step
  would, `markPendingOrgSetupLinked`, `billing.ts:1930`) when X is not ended and all three hold:
  X's `metadata.organization_id` is the org O, X's `metadata.created_by` is the setup's user U, and
  O's billing row names X. That is the state a link leaves when it throws after
  `subscriptions.update` (`billing.ts:1907`) and before the mark: Stripe and the org's row already
  agree, and only the setup row is behind. When the metadata names O but the row does not name X yet
  (the sync threw, and the webhook has not run), the closer runs `syncSubscriptionToBilling(X)` once,
  the same idempotent call the webhook makes, and then applies the rule: the row names X, adopt; the
  row names another live Y, the S1 refusal (§5.6 "The refused sync": closed, `refused_reason =
  org_has_plan`, alert); anything else, the setup stays open. The adopt branch writes no payer facts:
  it has no declared input, and the payer write is outside this ADR's scope. Metadata that names a
  different org or user is never adopted; the setup stays open for the operator.

**Who alerts.** Each write is a compare-and-set: `UPDATE … SET closed_at … WHERE closed_at IS NULL
AND linked_at IS NULL RETURNING`, and the same predicate for `linked_at`. Several readers can find
the same X at once (the guard, both lookups, the link). Only the caller whose statement returned
the row raises the alert, logs `billing.pending_org_setup.closed` or `billing.pending_org_setup.adopted`,
and calls it closed. A caller that matched nothing raises nothing, so "alerted once" has a mechanism.

**Note (2026-10-14, #6059, closing #6052; S8 follow-up 4):** the close is no longer a single
statement. The closer runs without the payer's lease, so E0 can be inserting a hold on the same X
while it runs, and under READ COMMITTED the `NOT EXISTS` reads the statement's snapshot: it neither
sees nor waits for an uncommitted hold insert, so the close could land and the hold commit beneath it
(I14, I16 (a)). `closePendingOrgSetup` (`lib/billing/pending-org-setup.ts`) now runs one transaction:
1. `set_config('lock_timeout', '2s', true)` (`HOLD_LOCK_WAIT`).
2. **The fast path.** When a committed open hold of any scope names X, it returns null (closed
   nothing) at once, without taking a lock.
3. `LOCK TABLE payment_holds IN SHARE MODE`. Every hold insert or update takes ROW EXCLUSIVE, which
   SHARE conflicts with: a hold write in flight commits before the compare-and-set takes its
   snapshot, and one that starts later waits until the close commits. SHARE does not conflict with
   itself, so closers do not wait on each other. No hold writer changed.
4. The same compare-and-set as above, `NOT EXISTS` included.

A lock not free within 2s throws (SQLSTATE `55P03`) with nothing written, and fails closed: the guard
refuses with the try-again clause (§5.5), the resume lookups log it and leave the setup open for the
next reader, and the link fails as on any other database error, with the setup open. The operator's
`close-setup` (`scripts/pending-org-setups.ts`, `closeOpenSetup`) repeats the same four steps, and on
`55P03` refuses, writes nothing and says to run it again. "Who alerts" is unchanged: only the caller
whose compare-and-set returned the row alerts or logs. Case C110.

These are every state an open setup can be in, and its exit:

| Open setup, X reads | Exit | Writer | From |
|---|---|---|---|
| ended, no open hold | closed by whichever reader sees it first: the guard (it retrieves X when it finds an open row, so a co-owner is never blocked by an ended X), either resume lookup, or the link | the closer | S1 |
| ended or not, an open hold names X | the hold's release closes it, or `adopted` links it (§5.6 "When a hold ends") | the hold store, the link core | S4, S9 |
| `incomplete`, no hold | Stripe expires X after about 23h (S3), and the row above applies | the closer | S1 |
| live, no hold, linked in Stripe (metadata names O and U, O's row names X) but `linked_at` null (rev 7.1) | adopted by whichever reader sees it first: the guard, either resume lookup, or the link. On `dev` the creator's return does **not** link it: the resume record carries `linked: state.linked` (`components/org/create-org-sheet.tsx:417`, `billing.ts:2045`, `:2089`), so `runSteps` skips the link (`pending-paid-setup.ts:535-536`); and an `individual` payer's row stamps `declared_at` (`billing.ts:2079`), which drops the setup from both lookups (`pending-org-setup.ts:197`, `billing.ts:2193`). | the closer | S1 |
| live, no hold, not yet linked in Stripe, the creator returns | the creator's Create a team resumes and links it | the link | `dev` |
| live, no hold, not yet linked in Stripe, the creator does not return | the co-owner's message names the creator and support; support cancels (and refunds) X in Stripe, then runs `pending-org-setups close-setup` (§5.4) | the operator | S1 |
| Stripe answers `resource_missing` for X (rev 7.1, R71-2) | the guard refuses as for any open setup (the message offers support); the operator checks the key, then runs `close-setup`, which accepts a missing X with a reason (§5.4). Never closed automatically. `findUnfinishedNewOrgSetup` already keeps such a setup (`billing.ts:2175-2178`). | the operator | S1 |
| the link refused beside a live Y (S1, no holds yet) | closed by the refusal, with the alert | the link | S1 |
| live or `incomplete`, no hold, linked in Stripe to O and U, and O's row names another `active` or `trialing` Y after one sync of X (note 2026-10-14, #6068) | closed with `org_has_plan` and the alert by the guard or either resume lookup (the adopt branch's S1 refusal). Since S9 the link writes nothing here (`linkRefuses`) and refuses under a `needs_operator` hold instead (§5.6) | the closer | S1; the link's half removed by S9 |
| live, an open `link_refused` hold names X, and support has moved X to another team T (amendment 2026-10-14, #5974) | `payment-holds release <X> --moved-to <T>` releases the hold. The same transaction closes the setup (`hold_released`). Before #5974 this row had no exit (§5.8, "The gap"). | the operator | S11 |

A setup that closes while X is still live occurs in two rows only.
- **S1's refusal before holds exist.** X is then outside every reader, and the alert is its watch.
  §8 lists those setups for the operator when S9 deploys.
  **Note (2026-10-14, #6068):** "two rows only" is not what runs. The row added above (the guard's
  or a resume lookup's closer beside a live Y) also closes while X is live or `incomplete`, after
  S9 as before it. It is the same S1 refusal, with the same watch: the one alert, whose delivery the
  closer does not check, and §8's listing, which prints such a setup only when its X reads live at
  the time the operator runs it.
- **The moved release (amendment 2026-10-14, §5.8).** X is then **not** outside every reader. Before
  the close commits, T's row is checked to name X (`FOR SHARE`, §5.8 step 8). From then on X's events
  write T's row under #5518's guard. T's row is X's watch, as for any org's subscription.

Three details, each corrected in rev 6:
- **`closed_at IS NULL` (R6-1).** Without it, a refused link left `linked_at` null for good. The org
  could then never buy a plan, and the message sent the customer to a Create a team that would
  refuse again. Rev 7: the closer and the operator command, not only the refusal, now write it.
- **An index.** `pending_org_setups` is indexed only on `(user_id, created_at)` (`lib/db/schema/
  pending-org-setups.ts:60`). The guard reads by `created_org_id`, so the migration that adds
  `closed_at` also adds a partial index on `(created_org_id) WHERE linked_at IS NULL AND closed_at IS
  NULL`. The marker branch reads by `subscription_id`, which is already unique (`:44`).
- **The service role.** RLS scopes a row to its `user_id` (`programmables.sql`). The buyer may be
  another owner of the same org, so the guard reads with the service role. It returns only whether
  an open row exists and that row's `user_id`, which it turns into a name only through the org's own
  member list, which the buyer can already see. No other column of U's row reaches the other owner.

**The race it leaves.** The guard's read and the link are not serialised: the org-plan flow holds
`org-plan:<org>`, and the link holds `user:<user>`. A plan started in the same seconds as a retried
link can still mint Y beside X. Then the link's "live, paid plan" row (§5.6) refuses X under an alert and a `needs_operator`
hold (C80), checked again after the sync (§5.6 "The refused sync"). That is an operator's case with
nothing lost silently, which is the bar.

### 5.8 The moved release of a `link_refused` hold (amendment 2026-10-14, #5974)

**The gap.** The S9 money review found it, and it was recorded on #5506 on 2026-10-13. Beside the
org's other live, paid plan Y, the link refuses X. It opens a `needs_operator` hold on X with
`open_note = link_refused` (`lib/billing/payment-holds/sweeper.ts:454-464`). It leaves the setup open
with `refused_reason = org_has_plan` (`:479`). And it tells the customer that support "will refund it
or move it to the right team" (§5.5, `LINK_REFUSED_ORG_HAS_PLAN`, `sweeper.ts:304`). The refund has an
exit: once X is cancelled, X reads ended, and T16 releases and closes. The move has no exit:

1. T2o never adopts this hold (`machine.ts:214-220`), so every observation lands on T15 (`:232`).
2. Support moves X to the right team T in Stripe, so X's and its customer's `metadata.organization_id`
   name T. `payment-holds release` then reads X live beside an open setup
   (`scripts/payment-holds.ts:264-265`) and runs the re-link first (`:266`, `relinkBeforeRelease`,
   `:316-323`). The re-link resolves the setup's own team O, not T (`relinkOrgOf`,
   `sweeper.ts:565-594`). It finds X's metadata naming another team (`:537`), alerts (`:540-545`) and
   returns `not_linked` (`:546`). The command refuses (`scripts/payment-holds.ts:269-274`). Each attempt
   raises that alert again.
3. `close-setup` refuses a live X (`scripts/pending-org-setups.ts:139-144`), and it refuses while an
   open hold names X (`:148-158`).

So the hold blocks U's next create-a-team (I1 (a)), and §5.7's guard stays on for O's purchases. This
lasts until someone cancels X, which is the refund path that support chose not to take.

**The decision.** One more operator path, E2m / T16m (§3.2, §3.3). The command is:

```
pnpm -C apps/console billing:payment-holds release <X> --moved-to <T> --reason "<why>" --operator <user id>
```

The command checks that the move has fully happened. It reads that fresh, under the payer's lease. It
then releases the hold with T16's own write. It moves nothing itself: the move is support's decision,
made in Stripe, and the command records who made it and verifies it.

**Why `--moved-to`, not #5974's proposed `--reason moved --team <id>`.** `--reason` is T16's required
free text. It is stored as `release_note` (`scripts/payment-holds.ts:236`, `machine.ts:764`). If one
word inside it chose the code path, the path would depend on how a note was worded. A note that began
"moved …" for some other reason would take the moved path. So `--moved-to <T>` is its own flag, and
its presence alone selects the path. `--reason` and `--operator` stay required, as for T16
(`scripts/payment-holds.ts:236-237`, `:716-721`). A `--moved-to` with no value is refused there too,
before anything is read. Without `--moved-to`, `release` is T16, unchanged.

**What it does, in this order.** Steps 1–4 are T16's existing steps (`scripts/payment-holds.ts:239-259`).

1. It finds the open hold of X. If there is none, it prints that and returns `not_open` (exit 0), as
   T16 does (`:239-243`).
2. It takes the payer's lease, `user:<payer_key>`, and waits up to 30s (`LEASE_WAIT_MS`, `:100`). If
   the lease is still busy, it refuses with `lease_busy` (`:244-247`).
3. It re-reads the hold under the lease (`:250-254`). If the hold was released meanwhile, the result is
   `not_open`. **Only this read counts** for the next step's hold check.
4. It prints the hold and the setup (`:255-256`). The live observation (`:257-259`) is **not**
   printed here. It is a Stripe read, so it moves to the start of step 7, after rows 1–4 have passed
   (final review of #5980, advisory 1). It is still only a display read, never evidence.
5. **The database facts, read after the lease (rows 1–4 of the table below):**
   - team T's `organization` row (`id`, `metadata`);
   - U's membership of T: U's `member` row in T (`role`, `status`), and `holdsManageBilling(U, T)`
     (`lib/billing/payment-holds/sweeper.ts:497-501`, exported for this);
   - the setup row for X (`pendingOrgSetupFor(payer_key, X)`, `lib/billing/pending-org-setup.ts:224`).

   Nothing is read from Stripe until rows 1–4 pass (review of #5980, delta advisory 1). In particular,
   the search query in step 7 is built only from a T that row 2 found in the database.
6. **T's org-plan purchase lock.** The command runs steps 7–9 inside
   `withPurchaseLock('org-plan:<T>', …)` (`lib/billing/purchase-lock.ts:32-46`). That is the lock
   `createSubscriptionIntent` holds around T's mint (`app/server/actions/billing.ts:1511-1513`). If the
   lock is still busy after its 30s wait, the command refuses with `team_purchase_in_progress`. So no
   embedded org-plan purchase of T can mint a subscription between the step 7 reads and the step 9
   commit.
   - The lock holds one pooled connection in a transaction for the command's Stripe reads. That is
     the cost §4.4 describes. It is paid once per operator release.
   - `releaseHold` runs its own transaction on another connection, so the advisory lock and the
     `FOR SHARE` in step 9 do not wait on each other.
7. **The Stripe facts, all read-only, all under the payer's lease and T's lock:**
   - X itself (`subscriptions.retrieve(X)`, the purchase Stripe client);
   - X's customer (`customers.retrieve`), only when X was read;
   - T's billing row (`getOrgBilling(T)`, `lib/billing/queries.ts:34`), read **before any sync**:
     its `stripeSubscriptionId`, `status`, `stripeCustomerId` and `updatedAt`;
   - **T's subscriptions, listed directly, with no index lag.** Every subscription
     (`subscriptions.list({ customer, status: "all" })`, paged, capped at 1000 per customer) on each
     of these customers:
     - the customer on T's pre-sync row;
     - X's customer;
     - every customer whose `metadata.organization_id` is T (`customers.search`, capped at 50).

     `ensureCustomer` writes T's customer to T's row **before** any org-plan subscription of T is
     minted (`billing.ts:682-726`). `createSubscriptionIntent` (`:1525`) and `createCheckoutSession`
     (`:1442`) both call it. So a just-minted Z, `incomplete` and not yet indexed, is listed here,
     until X's own sync has replaced that customer on the row (step 7's `too_soon`, below).
   - **T's subscriptions, by search**, for a Z on a customer none of those reads names:
     `subscriptions.search({ query: "metadata['organization_id']:'<T>'" })`, capped at 10 pages of
     100. This is the shape `findUnfinishedNewOrgSetup` already uses (`billing.ts:3130`).
   - A cap that is reached is **not** a clean read. It is `stripe_unreadable`, and the command fails
     closed (delta advisory 2).

   The hold's stored observation, `last_pay` and the setup's columns are never evidence of the move.

   **Then the payer's lease is renewed** (final review, advisory 2). The lease lives 120s
   (`PURCHASE_LEASE_TTL_SECONDS`, `lib/billing/purchase-lease.ts:33`). The command may already have
   spent up to 30s waiting for T's lock, plus the listings, before any write. So once the step 7
   reads are done, and before the decision may lead to a sync, it calls
   `renewPurchaseLease(lease)` (`purchase-lease.ts:115-125`).
   - The renewal matches on key and holder. It fails only when another caller has taken the lease
     over.
   - A failed renewal refuses with `lease_lost`, before any sync and with nothing written, the same
     rule the link's core follows before its writes (`fenceFor`, `:134`).
   - A lease that expired but was not taken over renews, which is safe: nobody else acted under it.
   - Step 9's own fence still checks `expires_at > now()` (`store.ts:63-69`).
8. **The decision**, `decideMovedRelease` (a new pure function in `machine.ts`, next to
   `operatorRelease`). It takes the facts from steps 3, 5 and 7 and returns one of four answers:
   `refuse(code)`, `read_stripe` (rows 1–4 passed and the Stripe facts are not read yet),
   `sync_first` or `release`. It evaluates the table below top to bottom, and the first failing row
   wins.
   - On `sync_first`: X's metadata names T, nothing else bills or is buying T (rows 11–13 passed), and
     T's row does not name X yet.
   - The command then runs `syncSubscriptionToBilling(X)` **once** (`lib/billing/sync.ts:118`), with
     the X object read in step 7 and no event time, so #5549's rank guard applies (N2). That is the
     webhook's idempotent call, which the setup closer's adopt branch also makes (§5.7).
   - It reads T's row again and decides again with `syncedOnce = true`. A second `sync_first` is
     `row_not_x`.
   - No other step syncs, and no sync runs before rows 1–13 have passed.
9. On `release`, still under T's lock: it calls `operatorRelease` (`machine.ts:748-767`) with the
   reason `moved to <T>: <reason>` and a new input, `expectOrgRow: { orgId: T, subscriptionId: X }`.
   That is T16's compare-and-set on `version` and on the payer's lease (`store.ts:243-284`), with
   **one addition in the store** (review of #5980, advisory 3).
   - Inside `releaseHold`'s transaction, before the hold's update, the store runs
     `SELECT stripe_subscription_id FROM organization_billing WHERE organization_id = $T FOR SHARE`.
     When that does not return X, the transaction writes nothing and returns null.
   - While the lock is held, a webhook sync that would rewrite T's row (an `UPDATE` of that row)
     waits for this commit. So the row the release depends on cannot change between that check and
     the commit.
   - The same transaction closes the open setup with `closed_reason = 'hold_released'`
     (`store.ts:271-281`, §4.1).
   - On null, the command reads T's row again. If it no longer names X, the command refuses with
     `row_changed`. Otherwise the hold moved on or the lease was lost, and it prints T16's "Nothing was
     written" (`scripts/payment-holds.ts:288-291`). Either way, no event is emitted.
   - Without `expectOrgRow` (every other caller, and the plain T16), `releaseHold` behaves exactly as
     today.
10. It writes the audit event, only when step 9 returned the row (§5.4, rev 7.1). The event is T16's
    `billing.payment_hold.released` line (`:293-302`), with the same fields plus:
    - `moved_to: T` and `payer: U`;
    - `customer_id`: X's customer, which keeps paying (below);
    - `row_subscription_id` and `row_status`: T's row as step 9's check read it;
    - `listed_customers` and `listed_subscription_count`: what step 7 listed, so a later reader can
      tell what the release saw (delta advisory 2);
    - `setup_closed`: the setup id the release closed, or null.

    To report that id, `operatorRelease` passes through the `closedSetupId` that `store.releaseHold`
    already returns. Today it drops it (`machine.ts:761-766`). The plain T16 event is unchanged and
    carries none of these fields. The durable record is the row: `released_by`, and a `release_note`
    that names T.
11. It releases T's lock and gives the payer's lease back in every case (`:305-307`).

**The checks and their typed answers.** A refusal returns
`{ kind: "refused"; code: MovedReleaseRefusal; reason: string }` and exits 1. It writes nothing to
`payment_holds` or `pending_org_setups`, makes no Stripe write and raises no alert. Only `row_not_x`
and `row_changed` can have run the step 8 sync before them. Each `reason` tells the operator what to
do instead.

| # | Code | Refused when | What the operator is told |
|---|---|---|---|
| 1 | `not_link_refused` | The re-read hold is not `needs_operator` with `open_note = link_refused` (`LINK_REFUSED_NOTE`, `machine.ts:95`). | "This hold was not opened by a refused link; use `release` without `--moved-to`." |
| 2 | `team_not_found` | No `organization` row has id T. | "No team has id T; check the id." |
| 3 | `same_team` | T is the setup's own team: `created_org_id = T`, or T's metadata marker names X (`newOrgSubscriptionIdOf`, `lib/billing/new-org-setup.ts:44`). | "That is the team this setup was made for; `release` without `--moved-to` re-links X to it once its other plan is gone (§5.6 'When a hold ends')." |
| 4 | `payer_not_in_team` | U, the hold's payer, is not an **owner** of T with `member.status = active`, **or** `holdsManageBilling(U, T)` is false. The first half is the resume lookup's ownership test (`billing.ts:2935-2948`) plus `relinkOrgOf`'s active test (`sweeper.ts:589-591`). The second is the question `relinkSetup` asks (`sweeper.ts:538`). | "U's customer, and so U's payment method, would pay for X and for every later purchase T makes, and U is not an active owner of T who can manage its billing. Do not move X there: refund it (`release` once it is cancelled). If U should own T, T's existing owner must agree and make U an owner first: that changes who governs T, not only who pays." |
| L | `team_purchase_in_progress` | Step 6's lock on `org-plan:<T>` is still busy after 30s. | "T is buying a plan right now; try again in a minute, then check T's subscriptions with `show`." |
| 5 | `x_missing` | Stripe answers `resource_missing` for X. | "X is not in this Stripe account; check the key, then use `release` without `--moved-to`, which accepts a missing X." |
| 6 | `stripe_unreadable` | Any other failure reading X, its customer, a listing or the search; or a step 7 cap was reached. | "Could not read everything about X and T from Stripe; nothing was written; try again, or work it by hand." |
| 7 | `x_ended` | X reads `canceled` or `incomplete_expired`. | "X has ended; use `release` without `--moved-to`, which releases and closes the setup." |
| 8 | `x_not_movable` | X's status is not `active`, `trialing` or `past_due` (`PAID_SUBSCRIPTION_STATUSES`, `lib/billing/new-org-setup.ts:111-115`). That means `incomplete`, `unpaid`, `paused`, or an unknown value. | "X is <status>; only a paid X is moved. Wait until it is paid, or cancel and refund it." |
| 9 | `subscription_not_moved` | X's `metadata.organization_id` is not T. It prints what it names, or "nothing". | "Set X's organization_id to T in Stripe first." |
| 10 | `customer_not_moved` | X's customer is deleted, or its `metadata.organization_id` is not T. | "Set X's customer's organization_id to T in Stripe first." |
| 11 | `team_has_other_plan` | T's row, read **before any sync**, names a subscription Z ≠ X whose row status is anything but `canceled`. That includes `none`, which is how an in-flight `incomplete` Z reads (`sync.ts:57-58`). This is **deliberately wider** than the link's `namesOtherLivePlan` (`sweeper.ts:323-335`), which stays as it is for the link. The link must link beside an abandoned `none` Y (C77). The moved path has no customer waiting, so it may wait for Z to settle. | "T's billing row names Z (<status>). T is billed by, or is buying, another plan. Decide X or Z in Stripe first, or wait for Z to settle. Check Z in Stripe. If Z has ended there but the row still names it `none` (its ending webhook never landed), redeliver Z's `customer.subscription.deleted` event from the Stripe dashboard, then run this again. A delivery that never reached `done` runs again (`lib/billing/webhook-events.ts:38-45`)." |
| 12 | `team_has_other_plan` | Step 7's listings or search return a subscription Z ≠ X with `metadata.organization_id = T`, **not** `canceled` or `incomplete_expired`, and **an org-plan subscription**: `isOrgPlanSubscription(Z)`. That is the classification F3 uses: `planItem`, then `aiTierForPriceId`. An AI price is AI, and everything else is a plan. It is defined in F3's PR #5979 (branch `feat/billing-f3-live-sub-check`, `fae17d048`, `app/server/actions/billing.ts:1426-1429`). There it is private to a `"use server"` file, so S11 defines it once, exported, in `lib/billing/sync.ts` beside `planItem` (`sync.ts:83-87`), with F3's body unchanged. Whichever of F3 and S10b touches `billing.ts` after S11 imports it there instead of the private copy. A standalone AI subscription (`product_type: "ai_subscription"`, `billing.ts:1624`) routes to the AI columns (`sync.ts:141-146`) and never to T's plan slot, so it is **not** counted. This row catches a Z the webhook already displaced from T's row, and a just-minted Z the row does not show yet. | "T has another plan subscription, Z (<status>). Moving X there would bill T twice. Decide X or Z in Stripe first." It never names an AI subscription. |
| 13 | `too_soon` | T's pre-sync row already names X (the webhook applied support's edit first), and its `updatedAt` is less than **15 minutes** ago. | "X was moved to T less than 15 minutes ago. Run this again after <time>, so that Stripe's search can see everything T bought before the move." |
| 14 | `row_not_x` | T's billing row does not name X after one sync. It prints the row's subscription and status. | "T's billing row names <Z, status> (or nothing); nothing was released." |
| — | `lease_lost` | The renewal at the end of step 7 failed: another caller took the payer's lease over. No sync has run. | "Another request took this payer's lease while the command read Stripe; nothing was written. Run it again." |
| — | `row_changed` | Step 9's `FOR SHARE` check found T's row no longer naming X. | "T's billing row changed while this ran (it names <Z, status>); nothing was written. Run `show` and decide again." |

Why each check is there:
- **Rows 1 and 3 keep the path narrow.** Every other hold, and a move back to the setup's own team,
  already has T16 and its re-link. The moved path closes the setup, and it must never close one that
  the re-link would mark linked.
- **Row 4 exists because U keeps paying** (review of #5980, blocker 2).
  - The move changes only `metadata.organization_id` on X and on X's customer. X's customer is still
    the one minted for U (`created_by = U`, `sweeper.ts:386-393`), with U's payment method, and
    Stripe does not let a subscription change customer.
  - Once T's row names X, the row's `stripeCustomerId` is U's customer (`lib/billing/sync.ts:161-162`).
    `ensureCustomer` returns that customer for every later purchase of T (`billing.ts:687-694`). So
    every renewal of X, and **every purchase T makes from then on** (a plan change, a seat change, a
    new plan through `createSubscriptionIntent`, a hosted Checkout), **charges U's customer** (final
    review, advisory 4).
  - The hold exists so that a person decides X's money (C80). A team in which U cannot see or cancel
    that plan is the one destination this design can check and must refuse.
  - Requiring **owner** also keeps U's resume true. The lookup returns null for X linked to an org U
    does not own (`billing.ts:2935-2948`). The sheet would then tell U "you won't be charged again"
    (`components/org/pending-paid-setup.ts:477-480`) while X kept renewing on U's card.
  - This refuses one legitimate case: U is an `admin` of T with `manage_billing`. That refusal fails
    closed, and its answer names both ways out.
- **Row 8** moves only a subscription whose first payment settled (review advisory 2). An `unpaid` or
  `paused` X would land on T's row as `past_due` (`unpaid`, `sync.ts:51-53`) or `none` (`paused`).
  Nothing proves it is the purchase anyone means to keep.
- **Rows 9 and 10 check what the link itself writes:** customer first, then subscription
  (`sweeper.ts:386-393`). With the customer's metadata naming T, U's create-a-team never reuses that
  customer again (§4.2 (2)).
- **Rows 11, 12, 13, step 6's lock and step 9's fence together keep T from being billed twice**
  (blocker 1 and delta blocker N1).
  - The link refuses beside a `past_due` Y because otherwise "X and Y both bill" (#5715). The moved
    path refuses beside any Z that could still bill T.
    - Row 11 covers a Z on the row, including one still `incomplete` (`none`).
    - Row 12 covers a Z the row no longer shows. Its lag-free listing finds a just-minted Z, because
      T's customer is on T's row before T's first mint. Its search finds an older Z on any other
      customer.
    - Row 13 waits out the one case where the row has lost T's customer: X's own webhook sync
      replaced it (`sync.ts:161-162`) before the command ran.
    - The lock stops an embedded purchase of T from minting during the command.
  - Without these, step 8's sync would let X take a row from a `past_due` or `none` Z
    (`subscriptionMayApply`, `queries.ts:262-265`). The hold would be freed while Z still bills, or
    goes on to bill, T, and Z would sit on no row.
- **Row 14 is the proof that X is watched.** T's row names X, so X's events write T's row, and
  #5518's guard covers it from then on.

**The windows that are left, named (delta blocker N1 (b); final review, advisory 3).** Two shapes of
Z can still be missed.

**Shape 1: an existing Z the reads cannot see.** All four conditions must hold together:
- (i) it was created **outside** T's org-plan lock: a hosted Checkout session (`createCheckoutSession`
  takes no lock, §7), or an embedded mint that finished before the lock was taken;
- (ii) its customer is **not** on T's row, because X's sync replaced it more than 15 minutes ago;
- (iii) its customer is **not** returned by `customers.search`;
- (iv) the subscription itself is **not** returned by `subscriptions.search`.

Conditions (iii) and (iv) mean that Stripe's search index lags by more than 15 minutes, for a
customer of T whose `organization_id` was written by `ensureCustomer`.

The 15 minutes is a stated assumption about Stripe's index lag. It has **not** been measured, like
S7 in §1.3: S11 records it in Stripe test mode, and the runbook says so. Such a Z is §7's "two live
subscriptions on one org", which this design does not cover. No new mechanism is introduced for it.

**Shape 2: a hosted Checkout session opened on T before the release and paid after it.**
- `createCheckoutSession` takes no lock (§7), and `ensureCustomer` gives it the customer on T's row
  (`billing.ts:1442`, `:687-694`).
- A session that is still unpaid has **no subscription** yet, so no listing or search can find it, and
  T's lock does not stop it from completing.
- If the customer pays after the release commits, Stripe creates Z on T. Z's sync is refused beside
  the live X on T's row, and T pays for two plans, with Z on no row.
- This is §7's "a Checkout completed beside an embedded purchase", which hosted Checkout's
  descoping already leaves uncovered. Rows 11–13 cannot see it, and this amendment does not change
  that. The runbook tells support to ask T's owners about any open Checkout before the move.

**What the lease does and does not fence.** The payer's lease does not fence Stripe (§4.4), so step
7's Stripe reads are current only against this codebase's own writers.
- **X's and its customer's metadata.** Nothing here writes them without U's lease: the link's core
  renews that lease before each of those writes (`sweeper.ts:385-393`). So no session link, re-link
  or sweeper visit can change the metadata between step 7 and step 9. A hand edit in Stripe during
  those seconds is the operator's own race.
- **T's mints.** Step 6's lock fences T's embedded mints.
- **T's row.** Step 9's `FOR SHARE` check, inside the release's own transaction, fences it. A webhook
  that rewrites the row first makes the release write nothing (`row_changed`). One that comes after
  the commit applies to a row that already names X, under §5.3 (2)'s rules.

**Why it closes the setup and does not mark it linked.** `markPendingOrgSetupLinked` also writes
`created_org_id = orgId` (`lib/billing/pending-org-setup.ts:408-425`). Marking the setup linked to T
would overwrite the record of the team the setup made (O) with a team that the setup's creator may not
belong to. A close keeps `created_org_id = O`, `refused_reason = org_has_plan`, and the hold row that
names T. Those three together say what happened. A closed setup releases §5.7's guard on O, and it
leaves §4.3's live check correct: X now carries `organization_id`, so it is no longer U's
create-a-team subscription (§4.2).

**Why the sweeper never does this on its own.** T15 is unchanged. A `link_refused` hold never
auto-releases, even when an observation could see the move. The hold exists so that a person decides
X's money (C80). A metadata edit in Stripe is not evidence that someone decided anything, and only the
operator's release records who did (`released_by`).

**The plain release points at the moved path.** When T16's re-link returns `not_linked` for a hold
whose `open_note` is `link_refused`, the refusal at `scripts/payment-holds.ts:269-274` adds one
sentence: "If support moved X to another team, run `release` with `--moved-to <that team's id>`." The
condition is the hold's `open_note`. It is not the text of `why`, because a check that matches a
message breaks when the message is reworded. The team id is already in that refusal: `why` names it
when X's metadata names another team (`sweeper.ts:537`). The plain path's other behaviour is
unchanged, including the re-link's alert.

**What it does not change.** No Stripe write. No customer email: the Q3 emails cover `refund_pending`,
`refunded` and `adopted`, never `operator` (§5.4). No change to T2o, T15 or T16. The store gains only
the optional `expectOrgRow` check (step 8), which no other caller passes. Nothing changes in the schema,
the release reasons (the `payment_holds_release_reason_known` check,
`lib/db/schema/payment-holds.ts:143-144`, keeps its seven values) or `close-setup`. After the
release, X belongs to T. Its renewals, plan changes and cancellation follow the org-plan rules
(§7), which this design does not cover.

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

Every new test must fail on the `dev` head its slice starts from, on its assertion. C69 and C76 are the exceptions: they are already on `dev` (§5.3 (2)).

**Reachability.** A case that needs a `processing` bank debit, or a subscription that is `active`
before it is paid (S4), is reached only through a payment confirmed outside the sheet. The tests mock
Stripe, so they reach every row regardless.

| ID | Case | Source | Transitions | Test |
|---|---|---|---|---|
| C1 | After the cancel, the PaymentIntent is `processing`, and the retry mints. If it succeeds, the customer paid twice. | 5506; AC1; 4176221898 | T0, T3, T6. Retry: E1 on `payment_in_flight`, so I1 refuses. | A: the create-a-team gap test at `:1524-1550`, flipped. The retry is refused and `subscriptions.create` is not called. |
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
| C35 | `priorSubscriptionId` from the browser cancels someone else's paid subscription. | P 4174412523 | `ownNewOrgSubscription` (`billing.ts:1774-1786`). Holds open only on server-read, `created_by`-checked subscriptions. | A: kept, plus a prior minted by another user is never held or cancelled. |
| C36 | `incomplete` is not "never paid". | P 4174573734 | T3/T3v act only on `pay ∈ {awaiting, failed}`. | A: kept. |
| C37 | Search lag offers a charged customer a second purchase. | P 4174185555 | Holds are a DB query by payer. | H: no `subscriptions.search`. |
| C38 | A lost `customerId` while the first payment is `processing`. | P ac002 adv 5 | Holds keyed by payer; recorded customers swept in full. | A: no `customerId`, a hold on another customer: refused. |
| C39 | An `incomplete` with zero payments, or `has_more`, says "a minute". | P adv 4 | The "kept" clause. | A: refused; no `/a minute/`. |
| C40 | OFFSET paging skips a record. | P adv 6 | Fixed by #5489, unchanged. | I: kept (`pending-org-setups.test.ts`). |
| C41 | `invoice.payment_failed` on a held or ended create-a-team subscription's invoice `invoices.pay`s it with a backup card. | New: `webhook-handler.ts:183-212` | §5.3 (1). | W: an ended subscription with an open invoice and a backup card calls no `invoices.pay`, and the hold is nudged (`version` unchanged). |
| C47 | After void-first, `readFirstPayment` reads `incomplete` + `void` + `canceled` PI as `not_proven_unpaid`. | New: `first-payment.ts:61-74` | §3.4 rule. | `tests/lib/billing/first-payment.test.ts`: gives `never_paid`. |
| C48 | The void succeeds and the cancel 503s: blocked 23h. | #5511 review 1 | T3v, then T9. | H: `cancel_unproven` + `incomplete` + `void` + `failed` cancels and reaches `released(voided_unpaid)`. |
| C49 | The void fails because the payment landed, and the cancel runs anyway. | #5511 review 1 | T3 cancels only after a re-read shows `void`. | H: `voidInvoice` rejects, re-read `paid`: **no** cancel, `cancel_unproven`. |
| C50 | A PaymentIntent succeeds between two reads. | #5511 review 1 | T11r. | H: first read empty, second `succeeded`: T5, no alert. |
| C51 | An operator release meets the unique `subscription_id`. | #5511 review 1 | Partial unique index. | I: release, sweep, E0 inserts a second row; a second open row is refused. |
| C52 | The lease expires mid-purchase: two payable create-a-team subscriptions. | #5511 review 1 | §4.4 rules 1–4. | L: expire A's lease before `subscriptions.create`; B mints. Exactly **one** secret is returned. A's only Stripe writes after the failed gate are `voidInvoice` and a `cancel` stamped `alethia:closeout`; no hold insert. Variant: A's close-out fails, and B's next purchase sweeps Z. |
| C53 | A settled ACH payment with nothing to run it again. | #5511 review 1; AC3 | §5.3 nudge; §5.4 sweeper (I10). | W: no Stripe write, `nudged_at` set, `version` unchanged, 2xx. I: one sweeper tick advances a due hold. |
| C54 | A pending SEPA refund is told "refunded in full", then fails. | #5511 review 1 | `refund` by status; T10p; T10f. | H: `pending` gives `refund_pending` and no "in full"; `failed` gives `refund_due`, `refund_attempt = 1`; only `succeeded` gives `released(refunded)`. |
| C55 | A customer shared with an org is reused for create-a-team. | #5511 review 1; `billing.ts:666-670`, `:1657-1663`, `:1757-1767` | §4.2 (2). | A: create-a-team does not reuse a customer that has `organization_id`, from the browser or a record. |
| C56 | A refund clause on a request that mints has nowhere to go. | #5511 review 1 | `notice` on `{ kind: "intent" }`. | A: each blocking state and the kept outcome produce a message; a minting response within 14 days of a refund carries `notice`. |
| C57 | Tab 1 pays X after X was ended, and the link links it and syncs a cancelled plan. | 4176267018; #5511 review 1 | §5.6. | A: X `canceled` with a `refund_due` hold: the link makes no `customers.update` or `subscriptions.update` and returns `{ kind: "refused" }` with the clause. **Rev 7:** the hold is open, so the setup stays open with `refused_reason = held` and `closed_at` null; when the hold then releases `refunded`, the same transaction closes it (C92). A: `resolveNewOrgSetup` returns the setup with `hold` set, not resumable. **S† (rev 5):** the run stops, its outcome is `failed`, `retryable: false`, with the clause as the message, and the browser record is cleared. No "Subscription active" toast. |
| C58 | The backfill refunds legitimate revenue. | #5511 review 2 | §8 B1–B6. | I†: `reconcile --backfill` holds only the never-live checkout; the others are listed. |
| C59 | A refund in `requires_action` is stuck. | #5511 review 2 | I11. | I: alerts once at 25h, stays `refund_pending`. |
| C60 | The link refuses a paid `incomplete` X, and the org gets no plan. | #5511 review 2 | Link and defer. | A: X `incomplete`, its payment `processing`, no hold: the link writes `organization_id`, returns `{ kind: "linked", planState: "confirming", paymentUrl: null }` (#5539's state for a payment in flight), and the row is `community`; then `updated(X, active)` syncs the plan (W). The sheet half (the toast is not "Subscription active") is already on `dev`, tested by #5539 in `tests/components/org/paid-setup-plan-state.test.tsx`. |
| C61 | A T4-shaped hold says "a few minutes" for days. | #5511 review 2 | §5.5 by `last_pay`; 14-day bound. | A: `/several business days/`, not `/few minutes/`. I: no age alert at 72h; one at 14 days. |
| C63 | The machine's cancels email "subscription canceled". | #5511 review 2 | §5.3 (4). | W (rev 6): a `deleted` for a **linked** X that the row names, stamped `alethia:checkout_closed:<id>`, writes the row but sends no email and no `subscription_canceled`. The same deletion unstamped does both. An unlinked one sends neither, as on `dev` today. |
| C64 | **Rev 5 (K3).** A customer who paid gets no receipt. | #5511 reviews 2 and 4 | §5.3 (2): the receipt follows the fresh read; nothing is owed or deferred. | W: `invoice.payment_succeeded` with the fresh read `incomplete`, with an open `closing` hold, sends one receipt. The same with no hold sends one receipt. With the fresh read `canceled`, it sends none. H: T2 sends nothing, and the table has no receipt column. |
| C65 | The operator release races a sweeper step. | #5511 review 2 | T16, `version`. | I: a write prepared on `version` n changes no row after a release committed n+1. |
| C66 | `advanceHold` inside the webhook transaction. | #5511 review 2 | §5.3 nudge. | W: no Stripe write for a held subscription; the sync runs on the first delivery even when the lease is held. |
| C67 | **Rev 5.** A stale holder's closed-out Z writes an org row. | #5511 review 3 | Z has no `organization_id` (§4.4 rule 4). | W: `created(Z, incomplete)` and a `deleted(Z)` stamped `alethia:closeout`, with no `organization_id`, write no row and send no email. |
| C69 | **Rev 5 (N1).** A stale or out-of-order event for X after the link. | #5511 reviews 3 and 4 | N1 (#5514). | Already on `dev` (#5518): `tests/integration/billing-sync.test.ts:172` and `:191`. Step 3 re-runs them, and adds nothing. |
| C71 | An empty payments read released `already_refunded`. | #5511 review 3 | Positive evidence; T11r above T5. | H: as rev 4. |
| C72 | `unrecognised` on an ended subscription matched T10 or T9. | #5511 review 3 | T9 needs `pay ∈ {awaiting, failed}`. | H: as rev 4. |
| C73 | A `refund_pending` hold whose payments read is empty. | #5511 review 3 | T11r. | H: as rev 4. |
| C74 | The nudge made a state write miss. | #5511 review 3 | Hint writes. | I: as rev 4. |
| C75 | A lost attempt increment reused a failed key. | #5511 review 3 | Reservation before the call. | H and I: as rev 4. |
| C76 | **Rev 5 (K4, N2).** The link's own sync writes an `incomplete` snapshot after the webhook applied X `active`. A paid org drops to `community`. | #5511 review 4 | N2 (#5514 / #5518). | Already on `dev` (#5549): `tests/integration/billing-sync.test.ts:222`, which fails on #5518's `4a306a0f6`. |
| C77 | **Rev 5.1 (B1).** The row names a different subscription Y that is not live and paid: an abandoned `none` Y, or a `past_due` one. | #5511 review 5 | §5.6, the "not live and paid" row. | A: the row names a `none` Y and X is `active`: the link links X and returns `{ kind: "linked", planState: "active" }`. With #5514's sync, an integration case shows X taking the row. |
| C78 | **Rev 5 (K5), narrowed in 5.1.** The sheet creates a team for a setup the link would refuse, or stops one it would link. | #5511 reviews 4 and 5; `pending-paid-setup.ts:476`, `:495` | §5.6 sheet (1). | S†: `resolveNewOrgSetup` reports a `refund_due` hold. `authClient.organization.create` is not called, the outcome is `failed` and non-retryable with the notice, and the browser record is cleared. A `closing` hold does **not** stop the run, which goes on to the link. |
| C79 | **Rev 5 (K5).** A thrown link error is reported as "Retry … you won't be charged again". | #5511 review 4; `pending-paid-setup.ts:559-569` | §5.6 sheet (4). | S†: a thrown link error is `retryable: true`, and its text does not match `/charged again/`. A typed refusal is never retryable. |
| C80 | **Rev 5.1 (B1).** A paid X is refused by the link beside a live, paid Y, and is left renewing with no alert. | #5511 review 5 | §5.6, the "live, paid plan" row; I14. | A: the row names an `active` Y. The link for an `active` X returns `{ kind: "refused" }`, makes no Stripe write and no billing-row write, opens a `needs_operator` hold on X (`open_note = link_refused`), leaves the setup **open** with `refused_reason = org_has_plan` (rev 7, I16), and calls the alert with X as the subject. H: T2o does not release that hold. |
| C81 | **Rev 5.1 (B1).** The org's own flows write its row while its paid setup is unlinked. | #5511 review 5; `billing.ts:1187-1194`, `:1411-1421` | §5.7. | A: a `pending_org_setups` row names the org with `linked_at` null. `createSubscriptionIntent`, `createCheckoutSession` and `startProTrial` each refuse with the finish-setup message and call no `subscriptions.create` or `checkout.sessions.create`. `createAiSubscriptionIntent` is unaffected. Rev 6: with `closed_at` set, or `linked_at` set, none of them is refused. **Rev 7:** the co-owner half moves to I (`tests/integration/pending-org-setups.test.ts`, real Postgres under RLS): a second owner of the org, whose session cannot read U's row, is refused too, and the refusal carries no column of U's row but the creator's member name. |
| C82 | **Rev 5.1 (advisory).** A paid, live X sits in `needs_operator` until an operator acts. | #5511 review 5 | T2o. | H: `needs_operator` with the subscription `active` gives `released(adopted)`. With `unpaid`, it stays `needs_operator`. |
| C83 | **Rev 5.1 (advisory).** The receipt and backup-card rules change invoices outside the scope. | #5511 review 5 | §5.3 (1) and (2), scoped to held invoices and create-a-team subscriptions. | W: an org-plan renewal invoice whose subscription reads `canceled` on redelivery still gets its receipt, and an org-plan first invoice still gets its backup-card retry. |
| C84 | **Rev 6 (R6-2).** #5539's hosted invoice link invites a payment of an invoice a hold is voiding or refunding. | rev 6; `billing.ts:1989-2000` | §5.6 "No payment link while a hold is open". | A: X `incomplete`, `action_needed`, with a `closing` hold: the link and `resolveNewOrgSetup` return `paymentUrl: null`. With no hold, the URL is returned as on `dev`. |
| C85 | **Rev 6 (R6-1).** A refused link leaves `linked_at` null, and §5.7 then refuses the org's plan purchases for good. | rev 6 | §5.6 "A refusal closes the setup only when it is terminal"; §5.7; I15. | A: an org created before a refused link (an ended X, no hold). `createSubscriptionIntent` for that org is **not** refused afterwards, and `findUnfinishedNewOrgSetup` does not return the setup. I: the partial index exists, and the guard's query uses it. |
| C86 | **Rev 6 (R6-3).** An ended X with no hold, whose payment may have moved, is told "it was not charged". | rev 6 | §5.6, the "ended, no hold" row. | A: X `canceled`, no hold, the payments read `succeeded`: the link returns `refused` with the contact-support clause, raises the alert, and calls no `refunds.create`. Read `none`: the "not charged" clause, and no alert. |
| C87 | **Rev 7 (R7-1).** The org exists, the link threw, X then ended; nothing ever reaches the link again, and §5.7 refuses the org for good. | #5511 review 6 | §5.6 "The resume lookups close what they read as ended"; §5.7 exits. | A: `resolveNewOrgSetup` reads X `incomplete_expired` for a setup with `created_org_id` set: `closed_at` is set before it answers, and `createSubscriptionIntent` for the org is not refused afterwards. Variant with no resume: a co-owner's `createSubscriptionIntent` finds the open row, reads X ended, closes it and proceeds. Variant: X `canceled` with a payment read `succeeded`: closed, and the alert is raised once. **Rev 7.1:** two readers close the same row concurrently: one `UPDATE … RETURNING` returns it, and only that caller raises the alert and logs `billing.pending_org_setup.closed`. Variant (fail closed): the guard finds an open row and `subscriptions.retrieve` (or `readFirstPayment`) throws: the purchase is refused with the try-again clause, nothing is written, and no Stripe purchase call is made. In `createSubscriptionIntent`, an org whose row is `active` gets "change the plan instead" and the guard is not reached. |
| C88 | **Rev 7.** The live double-charge window on `dev`: the link's sync is refused beside a live Y, and the link marks the setup linked and reports `active`. | #5511 review 6; `billing.ts:1913`, `:1930`, `:1935` | §5.6 "The refused sync". | A: the row names an `active` Y before the link: `{ kind: "refused" }`, no `customers.update` or `subscriptions.update`, `markPendingOrgSetupLinked` not called, no payer write, `billing.new_org_link.refused` logged, the alert called with X. Race variant: the row names nothing at the first read and Y after the sync: the same refusal, with X's metadata written. Control: an `"ignored"` sync whose row names X itself (C76) is linked. S: the sheet's run ends `failed`, `retryable: false`, with the clause; no "Subscription active". |
| C89 | **Rev 7.** The guard tells a co-owner to "finish" a setup only its creator can finish. | #5511 review 6 | §5.5 guard rows. | A: the creator gets the Create-a-team-or-support message; a second owner gets the creator's member name and support, and no `/finish/`; a creator who left the org reads "Another member of this team". |
| C90 | **Rev 7.** An open setup with a live X whose creator never returns has no exit. | #5511 review 6 | §5.4 "The setup command". | `tests/scripts/pending-org-setups.test.ts`: `close-setup` with no `--reason` refuses; on a live or `incomplete` X it refuses and writes nothing; on an ended X it writes `closed_at`, `closed_reason = operator`, `closed_by`, `closed_note` and the audit event; a second run changes nothing and emits no event. **Rev 7.1:** on an X that reads `resource_missing` it prints that, needs `--reason`, and closes with `x_read = resource_missing`; any other read failure refuses and writes nothing. From S8: with an open hold naming X it refuses. |
| C91 | **Rev 7 (R7-2).** `needs_operator` on an `incomplete` X; the link refuses; X goes `active`; T2o adopts silently and nothing links X. | #5511 review 6 | T2o; §5.6 "When a hold ends"; I16. | A: the link refuses with the hold's clause and the setup stays open (`refused_reason = held`). H and I: the sweeper's T2o releases `adopted`, and, with an org, the link core links X (`linked_at` set, the row names X). Without an org: the setup stays open, `findUnfinishedNewOrgSetup` returns it, §4.3 returns `resume`, and the Q3 adoption email is claimed once. Variant: U no longer holds `manage_billing`: no link, an alert, the setup open. |
| C92 | **Rev 7 (I16).** A setup is closed while a hold on its subscription is open. | #5511 review 6 | §4.1 "A release decides the setup"; the closer's `NOT EXISTS`. | I: with an open hold on X, the closer, the link's refusal and `close-setup` each leave `closed_at` null. The hold's release to `voided_unpaid` sets `closed_at` and `closed_reason = hold_released` in the same transaction; a release to `adopted` does not. |
| C93 | **Rev 7 (advisory 9).** `recordNewOrgCreated` failed, so `created_org_id` is null and the guard misses. | #5511 review 6 | §5.7, the marker branch. | I: an org whose metadata carries `newOrgSubscriptionId = X`, and an open row for X with `created_org_id` null: `createSubscriptionIntent` for that org is refused. |
| C94 | **Rev 7 (advisory 1).** The live check cannot see a paid, unlinked X whose org exists, because its customer helper excludes `created_org_id`. | #5511 review 6; `pending-org-setup.ts:227` | §4.3 "Which records". | A: U's only record has `created_org_id` set and X `active`, unlinked: the purchase returns `resume` and calls no `subscriptions.create`. The same with the record closed. |
| C95 | **Rev 7 (advisory 6).** The Q3 email is sent twice, or by a caller with no fence. | #5511 review 6 | §4.1 notice claim; §5.4 "Who sends the Q3 emails". | I: two sweeper ticks over one `refund_pending` hold send one email; a send that throws un-claims, and the next tick sends it; the purchase flow and the link entering `refund_pending` send nothing. |
| C96 | **Rev 7.1 (R71-1).** The link threw after `subscriptions.update` and before the mark: X is live and linked in Stripe, the org's row names X, `linked_at` is null, and nothing ever marks it. | #5511 review 7; `billing.ts:1907`, `:1930`, `:2079`, `:2193` | §5.7, the closer's adopt branch. | A: X `active`, `metadata.organization_id = O`, `metadata.created_by = U`, O's row names X, `linked_at` null: ~~`createCheckoutSession` for O is not refused~~, and `linked_at` is set by that call (**Note (2026-10-14, #6017, ADR 0004 D5 / O2):** Checkout now refuses beside a live row, so the call is refused with the row predicate's copy when O's row names a live X. What is kept is the adoption: Checkout runs the open-setup guard, whose closer adopts and marks X linked, **before** the row check (§4.2 P1→P2; `createCheckoutSession`, `billing.ts`). `createSubscriptionIntent` and `startProTrial` check the row first and the open-setup guard second, so they refuse beside a live row before the closer runs; only the refusal text differs between the three flows); a concurrent resume lookup sets nothing twice. Variant: the row names nothing yet: the closer syncs X, then adopts. Variant: the row names a live Y: the S1 refusal (closed, `org_has_plan`, alert). Control: metadata names another user: not adopted, the guard refuses. |
| C97 | **Rev 7.1 (R71-2).** An open setup whose X Stripe cannot find (`resource_missing`) refuses the org's purchases for good. | #5511 review 7; `billing.ts:2175-2178` | §5.4 "The setup command"; §5.7. | A: the guard on a `resource_missing` X refuses and closes nothing (no automatic close). `tests/scripts/pending-org-setups.test.ts`: `close-setup --reason` on it closes the row; `createSubscriptionIntent` for the org is not refused afterwards. |
| C98 | **Amendment 2026-10-14 (#5974).** Support moved a `link_refused` X to the right team T. `release` re-links to the setup's team, gets `not_linked` and refuses, so the hold sits at T15 for good, U cannot create a team, and §5.7's guard stays on. | S9 money review (#5506, 2026-10-13); `scripts/payment-holds.ts:264-274`, `sweeper.ts:537` | §5.8; E2m, T16m. | `tests/scripts/payment-holds.test.ts`: the hold is `needs_operator` with `open_note = link_refused`; an open setup has `created_org_id = O`; X reads `active` with `metadata.organization_id = T`, its customer's is T, and T's row names X, written 20 minutes ago. U is an active owner of T and `holdsManageBilling(U, T)` is true. The listings of T's customers and Stripe's search for T return only X. `withPurchaseLock('org-plan:T')` is acquired. `release X --moved-to T --reason r --operator op` returns `{ kind: "released" }` and exits 0. `store.releaseHold` is called once with the lease, `{ id, version }` and `{ reason: "operator", releasedBy: "op", note: "moved to T: r" }`. Exactly one `billing.payment_hold.released` line carries `moved_to: "T"` and `setup_closed`. `relinkAdoptedSetup`, the alert and every Stripe write (`customers.update`, `subscriptions.update`, `subscriptions.cancel`, `refunds.create`) are not called. The lease is given back. The event also carries `payer`, `customer_id`, `row_subscription_id: X` and `row_status`, and `releaseHold` receives `expectOrgRow: { orgId: T, subscriptionId: X }`. A second run returns `not_open` and emits nothing. **Control (review advisory 6):** the existing T16 release tests pass unchanged, and a plain release emits a `billing.payment_hold.released` line with no `moved_to`, `payer`, `row_*` or `setup_closed` key, and passes no `expectOrgRow`. (The same-transaction setup close is the store's, already proven by C92.) |
| C99 | **Amendment 2026-10-14.** The moved path releases on partial or wrong evidence. | #5974; review of #5980 | §5.8, the checks table. | `tests/lib/billing/payment-holds.test.ts`: `decideMovedRelease` returns each code of rows 1–4, L and 5–14 from a fact set that fails only that row. There are separate fact sets for X `incomplete`, `unpaid` and `paused`, each giving `x_not_movable`, and X `past_due` passes row 8. With rows 1–4 passing and the Stripe facts unread, it returns `read_stripe`. Order is pinned: a fact set that fails rows 3 and 9 returns `same_team`, one that fails rows 4 and 11 returns `payer_not_in_team`, and one that fails rows 7 and 9 returns `x_ended`. A fact set that passes every row returns `release`. `tests/scripts/payment-holds.test.ts`: for each code, the result is `{ kind: "refused", code }` and the exit is 1. `store.releaseHold`, the alert and every Stripe write are not called, no event is emitted, the lease is given back and T's lock is released. `syncSubscriptionToBilling` is called only on the way to `row_not_x` or `row_changed`, once. A `--moved-to` with no value is refused before any read. A `team_not_found` or `payer_not_in_team` makes **no** Stripe call: no retrieve, list or search (delta advisory 1). A `withPurchaseLock` that returns `{ acquired: false }` gives `team_purchase_in_progress`, with no Stripe call. A listing or search mock that reaches its cap (1000 per customer, 50 customers, 10 search pages) gives `stripe_unreadable`, not `release`. |
| C100 | **Amendment 2026-10-14; review of #5980, blocker 1, delta blockers N1 and N2.** The command syncs X more than once, syncs before X's move is proven, frees the hold while T is billed by (or is buying) another plan, or refuses beside an AI add-on. | #5974; #5715; review of #5980 | §5.8 steps 6–9; rows 11–13. | H and scripts. Every fixture runs inside a `withPurchaseLock` mock that records it was entered before the first Stripe read and left after `releaseHold`.<br>**Sync once:** T's row names nothing with `syncedOnce = false` gives `sync_first`. The same facts with `syncedOnce = true` give `row_not_x`. Scripts: the row names nothing at first, the sync applies, and the re-read names X, so the result is `released`, with `syncSubscriptionToBilling` called exactly once on the X object this run read.<br>**Pre-sync row:** T's row names Z `past_due`, then `active`, then `trialing`, then **`none` (an in-flight `incomplete` Z)**. Each gives `team_has_other_plan` naming Z, with no sync and no `releaseHold`. A row naming Z `canceled` does not refuse on row 11.<br>**Just minted, not indexed (N1):** T's row names nothing, and the customer on it, C_T, lists Z `incomplete` with `organization_id = T`, a plan price. The search returns **nothing**. The result is `team_has_other_plan`, from the listing.<br>**Webhook-first:** T's row already names X with `updatedAt` 20 minutes ago, and the search returns Z `past_due` with `organization_id = T`. The result is `team_has_other_plan`, with no sync. The same row with `updatedAt` 5 minutes ago and an empty search gives `too_soon`, with the time to retry. With `updatedAt` 20 minutes ago and an empty search and listings, the result is `release`.<br>**AI controls (N2):** an `active` AI subscription on T (an `ai_plus` price, `product_type: "ai_subscription"`), from the listing and from the search, does **not** refuse, and the result is `release`. An AI subscription plus a `past_due` plan Z gives `team_has_other_plan`, naming **Z**, not the AI subscription. A Z with no licensed line counts as a plan, as F3 counts it.<br>**Other:** a search hit that is `canceled` does not refuse. A failing listing or search gives `stripe_unreadable`. X's metadata naming O gives `subscription_not_moved`, and neither the sync nor the listings' verdict is reached. |
| C101 | **Amendment 2026-10-14.** The move is judged on a stale read, or outside the lease. | #5974 | §5.8 steps 2–5, 8; T16's fence. | Scripts: `acquirePurchaseLease` is called before `subscriptions.retrieve(X)` and `customers.retrieve` (call order). A busy lease returns `lease_busy` and X is never retrieved. A hold that is released between the first read and the re-read under the lease gives `not_open` and no event. A hold that the re-read finds with another `open_note` gives `not_link_refused`. `store.releaseHold` returning null with T's row still naming X (a T15 observe bumped `version` in between, or the lease was lost) gives "Nothing was written", no event and `not_open`. Null with T's row now naming Z gives `row_changed` and no event. **Lease renewal (final review, advisory 2):** `renewPurchaseLease` returning false at the end of step 7 gives `lease_lost`. `syncSubscriptionToBilling` and `store.releaseHold` are not called, and no event is emitted. With the renewal returning true after a mocked 150s of reads, the release goes ahead. **Display read (advisory 1):** for `team_not_found` and `payer_not_in_team`, the live observation is not printed and `subscriptions.retrieve` is never called. |
| C102 | **Amendment 2026-10-14.** The plain release on a moved X does not say what to do. | #5974 | §5.8 "The plain release points at the moved path". | Scripts: the C98 fixture without `--moved-to` is still refused, and nothing is written. The refusal contains `--moved-to` and T's id. Control: a `needs_operator` hold with `open_note` null, X `unpaid` and an open setup whose re-link returns `not_linked` is refused without `--moved-to` in the text. |
| C103 | **Amendment 2026-10-14 (S10b).** The sheet cannot stop for an ended X with no hold, because the lookup does not report it. Using `planState` instead would stop a `paused` X, which the link links. | S10 lane (#5970); `billing.ts:1261`, `:2979-2987`; `new-org-plan-state.ts:84` | §5.6 "The lookup reports an ended setup". | A (`tests/actions/billing-new-org-link.test.ts`): the setup is already closed, so the closer writes nothing. `resolveNewOrgSetup` for X `canceled` with no hold and payments read `none` returns `ended.clause` equal to the "not charged" clause, `hold: null`, and calls `alertPaymentNeedsSupport` zero times. X `incomplete_expired` gives the same result. X `paused` returns `ended: null`. X `incomplete` and X `active` return `ended: null`. With an open `refund_due` hold on a `canceled` X, the result is `ended: null` and `hold` set. |
| C104 | **Amendment 2026-10-14.** Copied sentences show "could not confirm" for an X that a hold refunded in full and released. | S10 lane (#5970); `refuseEndedLink`, `billing.ts:2753-2782` | `endedSetupRead`'s first branch. | A: X `canceled`, the newest released hold on X is `refunded`, the PaymentIntent `succeeded` (`planState` `not_active`), and no hold is open. `ended.clause` contains "refunded in full" and does not match `/could not confirm/`. The same holds for `already_refunded`. **Drift check:** for the same fixture with an org, the lookup's `ended.clause` is the exact string the link's `{ kind: "refused" }` returns. |
| C105 | **Amendment 2026-10-14; review of #5980, blocker 3 and advisory 4.** Stopping the sheet at the lookup drops the alert the link raises on `dev` for an ended X whose money is not proven unmoved, or the lookup claims an alert it did not deliver. | I8; S10 lane; `billing.ts:2743-2747`, `:2768-2777`, `:3015` | §5.6 "The alert: the link's, under the link's rule". | A (`billing-new-org-link.test.ts`). Fixture: X `canceled`, no hold of any kind, and a setup **already closed earlier** (`closed_reason = 'hold_released'`, and separately `'ended'` with the closer's read `never_paid`), so the closer writes nothing and alerts nothing. Payments now read `succeeded`, which is money moved later. Exact strings are pinned as literals (C106's rule), with `S` = the support address:<br>(a) **No delivery row** for X since `closed_at`: the lookup calls `alertPaymentNeedsSupport` **exactly once**, with X as the subject, `context: "setup_closed"` and a detail starting "a resume lookup of the setup reported it ended" (note of 2026-10-14). With the alert returning true and `org` set, `ended.clause` is exactly `"This checkout was closed, and we could not confirm whether its payment went through, so it was not linked to a team. Contact support at S with the time of the payment. We have raised an alert. A team already created for it stays on the free plan."`. With `org: null`, it is the same string without the last sentence.<br>(b) The alert returning **false** (no channel): the clause is exactly `"This checkout was closed, and we could not confirm whether its payment went through, so it was not linked to a team. Contact support at S with the time of the payment."`, plus the free-plan sentence only with an org.<br>(c) A **delivered** (non-`dead`) delivery row for X after `closed_at`: **zero** `alertPaymentNeedsSupport` calls, and the clause of (a).<br>(d) Only a `dead` row: as (a), one call.<br>**Drift check:** for (a) and (c) with an org, the lookup's `ended.clause` equals the link's refusal clause for the same fixture, and the link's alert count matches the lookup's. |
| C106 | **Amendment 2026-10-14.** The two copies of the sentences drift. | S10 lane | One helper (§5.6). | `tests/lib/billing/new-org-setup.test.ts` (new). `endedSetupRead` covers every `NewOrgPlanState` × {`refunded`, `already_refunded`, another reason, null}: the two refund reasons always give `refunded`; otherwise `not_charged` gives `not_charged`; everything else gives `unconfirmed`. `endedSetupClause` with `teamExists: true` returns the §5.5 sentences of this ADR **as literals in the test**, not imported from the module under test. The alert sentence appears only for `unconfirmed` with `alerted`. The free-plan sentence appears only with `teamExists`. |
| C107 | **Amendment 2026-10-14.** The sheet creates a team, or calls the link, for an ended X with no hold. | S10 lane (#5970); `pending-paid-setup.ts:476`, `:495`, `:539` | §5.6 sheet rule 1. | S (`tests/components/org/pending-paid-setup.test.ts`): `resolveNewOrgSetup` returns `ended: { clause }` with `org: null`. `authClient.organization.create` and `linkSubscriptionToNewOrg` are not called, the outcome is `failed`, `retryable: false`, its message is the clause, and the browser record is cleared. The same with `org` set (a resume): no link call. Control: `ended: null`, `hold: null`, X paid: the run creates the org and links. |
| C108 | **Amendment 2026-10-14; review of #5980, blocker 2.** The moved release frees X onto a team where U, whose payment method still pays for X, cannot see or cancel it, and U's resume then says "you won't be charged again". | review of #5980; `sync.ts:161-162`; `billing.ts:2935-2948`; `pending-paid-setup.ts:477-480` | §5.8 row 4. | H: U not a member of T gives `payer_not_in_team`. The same for U an `admin` but not an `owner`, for U an owner with `status` not `active`, and for U an active owner whose `holdsManageBilling` is false. Scripts: each of those writes nothing, emits no event and never reaches the sync. The C98 fixture (U an active owner with `manage_billing`) releases. `stripe-prod-runbook.md` names the payment-method check and the refund alternative (reviewed in the PR, not tested). |
| C109 | **Amendment 2026-10-14; review of #5980, advisory 3 and delta advisory 4.** A webhook rewrites T's row between the decision and the release, and the hold is freed over a row that no longer names X. | review of #5980 | §5.8 step 9, `expectOrgRow`. | `tests/integration/payment-holds.test.ts` (real Postgres): an open `link_refused` hold and an open setup.<br>`releaseHold(lease, ref, { …, expectOrgRow: { orgId: T, subscriptionId: X } })` with T's row naming Z writes nothing: the hold stays open with `version` unchanged, and the setup stays open. With the row naming X, it releases and closes the setup.<br>**The lock is proven with two connections, not inferred from final rows.** Connection A opens a transaction and takes the `FOR SHARE` lock (the store's statement, run up to the point before its commit; or `releaseHold` with a hook that pauses before commit). Connection B, with `SET lock_timeout = '500ms'`, runs `UPDATE organization_billing SET stripe_subscription_id = 'Z' WHERE organization_id = T`. It must fail with SQLSTATE `55P03` (`lock_not_available`) while A is open, and succeed after A commits. A control **without** `expectOrgRow` lets B's update succeed at once. That control fails if the store took the lock unconditionally, and the main case fails if `FOR SHARE` was never issued.<br>Without `expectOrgRow`, the store's behaviour is as in C92. |
| C110 | **Note 2026-10-14 (#6059, closing #6052; S8 follow-up 4).** The closer runs without the payer's lease; E0 inserts a hold on the same ended X and commits after the closer's `NOT EXISTS` read its snapshot, so the setup is closed while a hold names X. | #6052; review of #6059 A1–A3 | §5.7 "Who alerts" (note 2026-10-14); I14; I16 (a). | `tests/integration/pending-org-setups.test.ts` (real Postgres, "#6052" block, two connections).<br>**The race.** Connection E inserts an open hold on a `canceled` X and does not commit; `settleOpenSetup` runs; E commits only once the closer has finished or shows in `pg_stat_activity` waiting on a lock on `payment_holds`. The verdict is `open`, the setup and the hold stay open, and the closer was seen waiting. With the pre-#6059 closer it fails: `closed_at` is set while the hold is open.<br>**The lock timeout.** Another uncommitted hold write keeps ROW EXCLUSIVE: `closePendingOrgSetup`, `settleOpenSetup` and `close-setup` each get `55P03` or the refusal, with nothing written; after that write rolls back, the same close lands.<br>**The fast path.** With a committed open hold on X and the same blocking write open, the close returns null at once, and `close-setup` refuses with the open-hold message.<br>`tests/scripts/pending-org-setups.test.ts`: the statement order (timeout, probe, `LOCK`, then the write), the fast path (no `LOCK`, no write), and the `55P03` refusal with nothing written. |
| C111 | **Amendment 2026-10-14 (#6078).** The `adopted` release schedules the relink check, and the relink write is fenced to a released `adopted` `new_org` hold. | #6078 | §4.1 "The relink retry"; I14. | `tests/integration/payment-holds.test.ts` ("#6078" block). An `adopted` `new_org` release sets `next_check_at` at or before the database's `now()` and restarts `attempts` and `last_error`. A `voided_unpaid` release and an `org_plan` adoption leave `next_check_at` null. `writeAdoptedRelinkState` lands at the hold's `version` and bumps it, changing only its four columns. A write on the old version, on an open hold, on another release reason, on an `org_plan` hold, or under a lapsed lease writes nothing. |
| C112 | A re-link after an adoption throws once (Stripe is down), then succeeds. | #6078 | §4.1 "The relink retry"; §5.4 the relink pass. | `tests/integration/payment-hold-sweeper.test.ts` ("#6078" block). The visit's re-link throws: `attempts = 1`, `last_error` set, and `next_check_at` 5 minutes out. The setup stays open and no alert is raised. A tick before the check is due makes no Stripe read. Once it is due, the pass links X: `linked_at` set, X names O, `next_check_at` null, no alert. `tests/actions/billing-new-org-holds.test.ts`: the purchase's re-link throws, so the hold records attempt 1 and the 5-minute check, the purchase still resumes, and no alert is raised. `tests/lib/billing/sweeper.test.ts`: the record is written on the hold's `version`, with the next delay. |
| C113 | A re-link keeps throwing. | #6078 | §4.1 "The relink retry" (the bounds, one alert). | `tests/integration/payment-hold-sweeper.test.ts`. After attempts 1–5, `next_check_at` is 5m, 15m, 1h, 4h and 12h out, with no alert. Attempt 6 runs from two overlapping ticks and gives up, with an alert that reaches a channel: `attempts = 6`, `next_check_at` null, `alerted_at` set, exactly one alert ("failed 6 times"), and six Stripe reads in all. Two more ticks read nothing and alert nothing. `tests/lib/billing/sweeper.test.ts`: the schedule; the order claim, alert, stamp; an undelivered alert stamps nothing; a claim that matched nothing, or that failed, alerts nothing; a lease taken over before the record is thrown with nothing written. |
| C114 | The setup of a scheduled hold was linked by another path (the creator's own link). | #6078 | §5.4 the relink pass (its setup predicate). | `tests/integration/payment-hold-sweeper.test.ts`. Of two holds whose checks are due, the one whose setup is linked gets no Stripe read and no write: its `version` and `next_check_at` are unchanged. The open one beside it is linked. Without the open-setup predicate it fails. |
| C115 | A re-link check fails for good: the creator no longer holds `manage_billing`. | #6078 | §4.1 "The relink retry" (`not_linked`, the alert decision). | `tests/integration/payment-hold-sweeper.test.ts`. One delivered alert naming `manage_billing` across three ticks, with `alerted_at` set and `last_error` naming it. No Stripe write. The setup stays open. `tests/lib/billing/sweeper.test.ts`: when the claim's compare-and-set loses, the held alert is **not** raised. When it lands, the alert is raised and then stamped. |
| C116 | The process stopped between an `adopted` release and its re-link. | #6078 | §4.1 "The relink retry" (the schedule). | `tests/integration/payment-hold-sweeper.test.ts`. A hold released `adopted` through the store, with no re-link run, is linked by the next tick's pass, and its check is cleared. |
| C117 | An adopted hold's check falls due while an open hold names X (a refusal's `link_refused` hold). | #6079 money review, advisory 3 | §5.4 the relink pass (its open-hold predicate). | `tests/integration/payment-hold-sweeper.test.ts`. No Stripe read. The adopted hold's `version`, `next_check_at` and `attempts` are unchanged. Without the predicate it fails. |
| C118 | The decision's alert reaches no channel. | #6079 money review, advisory 1 | §4.1 "The relink retry" (the alert decision). | `tests/integration/payment-hold-sweeper.test.ts`. `alerted_at` stays null and the check is about a day out. A tick before then raises nothing. Once it is due, the relink is decided and alerted again, then stamped when that alert is delivered, and nothing follows. |
| C119 | Every relink outlives its lease (another holder takes it over mid-read). | #6079 money review, advisory 2 | §4.1 "The relink retry" (the lost lease, the bounds). | `tests/integration/payment-hold-sweeper.test.ts`. Each loss is recorded as an attempt under a lease taken afresh (`last_error` names the lease), on the backoff. The sixth gives up with exactly one alert and no Stripe write, and later ticks raise nothing. |

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

That is 87 cases in scope: 73 at rev 5.1 (whose text said 67, a miscount), C84–C86 from rev 6, C87–C95 from rev 7, and C96–C97 from rev 7.1. The 2026-10-14 amendment (#5974) adds C98–C102, which makes 92. The second 2026-10-14 amendment adds C103–C107, which makes 97. The money review of #5980 adds C108–C109, which makes 99. The note of 2026-10-14 on #6059 adds C110, which makes 100.

---

## 7. Not covered, and why

The maintainer narrowed this design to the first payment of the paid org-setup path (2026-10-04).
Each item below is outside it. The behaviour named is what handles it **today**, at `origin/dev`
`e02417059`, and stays unchanged by this design. #5506's acceptance criteria 8, 11 and 12 fall here,
for every flow except create-a-team. §10.2 proposes their follow-up issues.

| Not covered | Why | What handles it today |
|---|---|---|
| **Renewals** (`billing_reason = subscription_cycle`) | Not a first payment. A renewal is charged by Stripe on a live subscription, and no purchase flow cancels or voids it. | Stripe collects automatically. `invoice.payment_succeeded` re-syncs the row and sends a receipt (`webhook-handler.ts:168-181`). I2 keeps every hold off a renewal invoice. |
| **Dunning** (a failed renewal) | Not a first payment. Stripe's retry schedule owns it. | `invoice.payment_failed` re-syncs (`past_due` keeps the org on `community`, `sync.ts:150-156`), tries the backup cards (`attemptBackupPayment`, `webhook-handler.ts:183-212`, unchanged for a live subscription) and emails "payment failed". When dunning ends in `canceled`, `customer.subscription.deleted` writes `canceled` / `community` and emails (`:122-132`). |
| **Plan changes, cancels and resumes** on a live subscription | Not a first payment. Nothing is minted beside a live subscription. | `changeSubscriptionPlan` (`billing.ts:2568-…`) updates the live subscription with Stripe's proration. `cancelSubscription` sets `cancel_at_period_end` (`:2550-2555`) and `resumeSubscription` clears it (`:2559-2564`). |
| ~~**The org-plan purchase** (`createSubscriptionIntent`), for an org that already exists~~ **Superseded by ADR 0004 (2026-10-14), D2** (the org-plan purchase on holds; its lease is D3, its off-Stripe-grant guard D5, its `past_due` refusal D7). The struck cells are the rev 5 scope decision, kept for history. | ~~Outside the paid org-setup path the maintainer named. The one change is §5.7's refusal for an org whose paid setup is unlinked. Its holds also need rules this design no longer carries: a superseder rule when two subscriptions name one org (rev 4's W2, K2), the off-Stripe-grant guard, and a live set wider than `PAID_SUBSCRIPTION_STATUSES`.~~ | ~~#5489's memory-less fail-closed path: `withPurchaseLock('org-plan:<org>')`, the `incomplete`-only sweep with `readFirstPayment`, `cancelNeverPaid` / `settleCancelledSubscription` (void, refund, or alert and refuse), and the row check on `active` / `trialing` (`billing.ts:1178-1257`). Its known gaps stay as #5506 lists them, pinned by `billing-subscription.test.ts:575-606`. They include a `past_due` org minting a second plan, a straight-to-`active` ACH subscription unseen until its webhook, and `PAYMENT_MAY_BE_UNDER_WAY`'s "you won't be charged twice". Widening is Q13. ~~ |
| **The AI subscription** (`createAiSubscriptionIntent`) | A separate product on an existing org. | No lock, no sweep, no holds (`billing.ts:1267-1321`). The create-a-team sweep no longer touches its `incomplete` subscriptions (I7, C18). |
| **Hosted Checkout** (`createCheckoutSession`) | An existing org's purchase. | No lock and no sweep (`billing.ts:1123-1161`). Stripe expires the session after 24h by default. **Rev 5.1:** it refuses for an org with an unlinked paid setup (§5.7). |
| **The card-less trial** (`startProTrial`), including the create-a-team sheet's trial path | Takes no payment, so there is nothing to hold. | It mints on the org's customer and syncs at once (`billing.ts:1335-1404`). The sheet creates the org, then starts the trial, and rolls the org back if the trial fails (`create-org-sheet.tsx:783-824`). Rev 4's gate and gate marker are withdrawn (K1). **Rev 5.1:** it refuses for an org with an unlinked paid setup (§5.7). |
| **AI credit packs** (`createCreditPackIntent`) | One-off invoices with no subscription. | `billing.ts:2309-2383`. `invoice.payment_succeeded` grants the credits idempotently. |
| **Disputes and chargebacks** | Not a first-payment settlement. | Stripe's dispute flow. No handler in this repo. |
| ~~**Two live subscriptions on one org** (adopted beside a live plan; a Checkout completed beside an embedded purchase)~~ **Superseded by ADR 0004 (2026-10-14), D6** (the two-live detector; the superseder rule that names the surviving subscription is D4). The struck cells are the rev 5 scope decision, kept for history. | ~~Produced by flows not covered. A new org's setup cannot produce one: §5.7 keeps the org's own flows off its row until the link, and the link refuses beside a live, paid Y under a `needs_operator` hold (C80).~~ | ~~#5514 (PR #5518) keeps the row on the live one. #5518 names the residual itself: when the row's subscription is cancelled, the other one takes the row only at its next event. No detector exists. Rev 4's §7 detector is withdrawn with the rest of the org-plan scope. ~~ |
| **Self-hosted or community deployments with no Stripe** | No payment. | `requireHostedBilling` (`billing.ts:591-597`) refuses first. |
| **Emailing the customer when a hold settles asynchronously** | Decided in Q3 (rev 7: covered). | The sweeper sends it under the notice claim (§4.1, §5.4), alongside the next create-a-team response's `notice` (§5.5). |

---

## 8. Migration and rollout

This section gives the rollout order, the backfill and the rollback. §10 cuts the same steps into
PR-sized slices with their scopes. Where the two differ on a PR boundary, §10 wins. A slice that adds
a migration rebases first (CLAUDE.md §5).

1. **The lease (§4.4).** Add `purchase_leases` and a lease helper. The create-a-team flow and the link
   move from `withPurchaseLock('new-org:<user>')` to the `user:<user>` lease, with the fenced renewal,
   the artifact gate and the close-out (§4.4 rules 1–4), and a timeout on the Stripe client of the
   purchase path. `withPurchaseLock` stays for the org-plan flow. **Rolling deploy:** for one release
   the create-a-team flow takes both the lease and the old advisory key, so old and new pods exclude
   each other. **S3 removes the advisory half (rev 7)**, and S3 deploys only after S2's rollout has
   completed on every pod. Tests: L, C25, C28, C52.
2. **The table, the machine and the sweeper, behind no caller.** Add the `payment_holds` migration
   (with the partial unique index), RLS in `programmables.sql`, the store, `advanceHold` as a pure
   transition function over an injected Stripe reader and writer, and `startPaymentHoldSweeper`. With
   no holds written, the sweeper selects nothing. Also settle S7 once in Stripe test mode and record
   the answer in §1.3. Tests: H, I, and the sweeper half of C53.
3. **The webhook (§5.3), before the flow.** **Precondition, met on 2026-10-04: #5514 merged (#5518,
   `f586e91e5`), and N2 merged (#5549, `835c01937`). C69 and C76 are on `dev`.** This step does not
   re-implement them. Then add the backup-retry guard, the receipt
   rule and the stamped-cancel silence. The nudges are inert until holds exist. Tests: W. **Rev 7:**
   stamping today's two create-a-team cancels (`billing.ts:1034` as the create-a-team sweep calls it,
   and `:1744`) is **not** in this step: it is in step 4's flow change (S8 in §10), which owns
   `billing.ts`. Until S8, an unstamped machine cancel keeps today's email, as on `dev`.
4. **The create-a-team flow, the link and the sheet.** In order:
   - Replace the create-a-team flow's calls to `cancelNeverPaid` and `settleCancelledSubscription`,
     and its `canceled`-prior arm (`billing.ts:1611-1650`), with open → advance. The org-plan flow
     keeps calling the old functions.
   - Classification-filter and fully page the create-a-team sweep. Stop reusing a customer that has
     `organization_id` (`:1657-1663`, `:1757-1767`).
   - Add the live check (§4.3).
   - Make the link typed and hold-aware, refusing only beside a live, paid subscription and under a
     `needs_operator` hold (§5.6). Add `hold` to the resume lookups.
   - **Rev 5.1:** add §5.7's refusal to `createSubscriptionIntent`, `createCheckoutSession` and
     `startProTrial` for an org with an open paid setup. **Rev 6:** with `closed_at` and its partial
     index, and with every link refusal closing the setup. **Rev 7:** that part ships first, in S1,
     with the refused-sync refusal and every exit (§5.7). This step adds only the hold-aware half: a
     refusal under an open hold leaves the setup open (I16).
   - Add the §5.5 composer for create-a-team and `notice` on `{ kind: "intent" }`.
   - **Rev 5:** change `components/org/pending-paid-setup.ts` and `components/org/create-org-sheet.tsx`
     as §5.6 "The sheet" says. This builds on #5539 (#5522), which has landed and already carries
     `planState` to the final view.
   - Flip the create-a-team gap test (`billing-subscription.test.ts:1524-1550`).

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
backfill is needed, **once the rollout has completed (rev 7)**. During a rolling deploy of S8, old
pods keep cancelling without holds after the operator's first `--backfill`. So the operator runs
`payment-holds reconcile --backfill` again after the last old pod has stopped. B1–B6 make a second
run safe: a subscription already held conflicts on the partial unique index (T0h) and is skipped.

**S1-era closures (rev 7).** Before holds exist, S1's refused sync closes a setup whose X may still
be live (§5.7 exits, last row). When S9 deploys, the backfill's listing also prints every setup with
`closed_reason = org_has_plan` whose X reads live, for the operator. It holds none of them: X is
paid and live, and only an operator may decide its money (Q12).
**Note (2026-10-14, #6068; as shipped in #5938, S9):** the listing is `listLiveOrgHasPlanClosures`
(`scripts/payment-holds.ts`), run by `payment-holds reconcile --backfill` after the backfill. It reads
**every** setup with `closed_reason = org_has_plan`, not only S1-era ones, because the guard's and the
resume lookups' closer still writes that reason beside a live Y after S9 (§5.7, I14 note). It prints
one whose X reads `active`, `trialing`, `past_due`, `unpaid` or `paused`, and a failed read as such.
It does **not** print one whose X reads `incomplete`: such an X is not live yet, but it can still be
paid and become live, and then it is printed only by a later run. Until then the closer's one alert
is its only watch.

**`forgetPendingOrgSetup` (rev 7, advisory 5).** It stays, with today's guard
(`pending-org-setup.ts:128-147`): it deletes a record only when X's `created_by` is U, its status is
`incomplete` or `incomplete_expired`, `readFirstPayment` reads `never_paid`, and the record has no
`created_org_id` and no `linked_at`. From S8 it adds one condition: no hold names X, open or
released with any reason but `voided_unpaid`, `deleted_draft` or `expired_unpaid`. A record it
deletes therefore had no org (so §5.7 never needed it) and a subscription that cannot become payable
again (so §4.3 never needs it). The resume lookups and `closed_at` work on every record it keeps.
Within S8 the create-a-team flow calls it only after such a release, never after a bare cancel as
`billing.ts:1632` and `:1695` do today.

**Rollback.** Steps 1 to 5 are code plus two additive tables. A hold left open by a reverted build
blocks nothing, because nothing reads it, and the sweeper advances it after a redeploy.

---

## 9. Decisions (maintainer delegation, 2026-10-08)

The maintainer delegated these answers on 2026-10-08. Each one keeps its question, so a veto can name
it by number. The rule for choosing: the answer friendliest to the person paying (an SRE setting up a
team) that is also safe. Money correctness, security and tenant isolation win every tie. Rev 5
removed Q8 (adopted beside a live plan), Q9 (the AI lock key) and Q11 (expiring an earlier Checkout
Session), because each asked about a flow §7 no longer covers. Q1 and Q5 were settled in earlier
revisions.

- **Q2.** *The lease row, or the transaction advisory lock with the stated
  `idle_in_transaction_session_timeout` and `poolMax` floor? What is the managed Postgres's current
  `idle_in_transaction_session_timeout` for the service role?*
  **Decision: the lease row (`purchase_leases`), for the `user:` key only (§4.4).** Reason: it holds
  no pooled connection while Stripe is called, and its holder token fences every hold write. That
  makes the database setting irrelevant, so nobody has to read it. The org-plan flow keeps
  `withPurchaseLock`.
- **Q3.** *When a hold settles from the webhook or the sweeper, should the customer get an email now,
  or only the `notice` at their next create-a-team purchase?*
  **Decision: an email on `released(refunded)` and on the first entry to `refund_pending`, as well as
  the `notice`.** Reason: a customer who never tries again would otherwise hear about their money only
  from their bank. The email says only what was read. "Refunded" is sent only for a refund that reads
  `succeeded`, and `refund_pending` says "issued" (I8). **Rev 7:** the sweeper is the only sender
  (§5.4). It claims each email with a compare-and-set on `notified_state` before sending (§4.1), so
  each hold and state is mailed at most once, whichever caller moved the hold. The same mechanism
  sends one "your payment went through; finish creating your team" email when a hold on a setup
  with no org is adopted (§5.6 "When a hold ends").
- **Q4.** *The refund budget and the §5.4 age bounds.*
  **Decision: as written, with T14's timing (amended 2026-10-09).** 5 attempts, waiting 5m, 30m, 2h and
  6h after the first four failures, so about 8h35m; the fifth failure goes to `needs_operator` at once
  (T14). The 24h step applies only when the fifth attempt did not fail but its refund does not read
  back yet. The §5.4 age table is unchanged. Reason: every open state reaches a person within a stated
  bound (I11). A longer budget would keep a customer's money away from them for longer.
- **Q6.** *The webhook event set: subscribe `charge.refund.updated` and `invoice.voided`, and drop the
  runbook's `payment_intent.succeeded` (`docs/stripe-prod-runbook.md:33`)?*
  **Decision: yes, all three.** Reason: `charge.refund.updated` is how a failed refund reaches T10f
  within minutes rather than at the hourly observe. `invoice.voided` already has a handler
  (`webhook-handler.ts:213-216`) but is not in `WEBHOOK_EVENTS` (`scripts/stripe-setup.ts:67-75`).
  No handler reads `payment_intent.succeeded`, so subscribing to it only adds deliveries.
- **Q7.** *Scope: #5506's `scope:` does not cover the migration and schema, `programmables.sql`,
  `instrumentation.ts` and the sweeper, `scripts/payment-holds.ts`, `scripts/stripe-setup.ts`,
  `docs/stripe-prod-runbook.md`, the sheet's two files and `tests/components/org/**`.*
  **Decision: one issue per §10 slice, chained by `blocked-by`, each with exactly the `scope:` §10
  gives it.** #5506 then closes with the last slice. Reason: each slice is reviewable on its own,
  and the scope guard checks what each PR touches.
- **Q10.** *Should `refund_pending` block?*
  **Decision: no (§3.1).** Reason: the earlier payment has landed and is on its way back, so a new
  purchase is not a second charge for the same thing. A refund that later fails returns the hold to
  `refund_due`, which blocks again (T10f). Blocking would make the customer wait days for a bank to
  finish a refund that is already issued. **Rev 7:** the cost is stated, not hidden. If the refund
  fails after the customer bought again, they carry two charges until the refund is re-issued (§3.1),
  and the `refund_pending` clause tells them so before they buy (§5.5).
- **Q12.** *Who works the backfill's review list, and is a refund for one of them a support decision
  per case?*
  **Decision: the platform operator works it, and each refund is a support decision per case, with
  `payment-holds show` as the evidence.** Reason: the backfill holds only what it can prove (B1–B6).
  Everything else may be legitimate revenue, and refunding it without a person's review could refund
  a purchase the customer meant to keep.
- **Q13.** *When should the org-plan purchase get holds?*
  **Superseded by ADR 0004 (2026-10-14), D2** (the org-plan purchase gets holds). ADR 0004 also carries what this
  decision said it needs: the scope column (D1), the superseder rule with a fresh read (D4), the off-Stripe-grant
  guard (D5) and the two-live detector (D6). Its `past_due` gap, which this decision left as #5506 lists it, is D7.
  The original decision follows, kept for history.
  ~~**Decision: in a separate ADR, ADR 0004, after this one ships (follow-up F1, §10.2).** Reason: it needs the
  parts rev 4 had and rev 5 removed: the scope column, a superseder rule with a fresh read (W1, W2),
  the off-Stripe-grant guard, and the two-live detector. Its gaps stay as #5506 lists them until
  then. Two of them have small fixes that need no holds, filed separately as F2 and F3.~~

## 10. Implementation slices

### 10.1 The slices

Each slice is one PR into `dev`, about 800 changed lines or fewer. Paths are relative to the repo
root, as `scope:` lines are. Slices that touch `apps/console/app/server/actions/billing.ts` are
chained, because one file cannot sit in two parallel scopes. Every migration slice is chained after
the previous one, because the snapshot chain is linear (CLAUDE.md §5). The slices that can run in
parallel are marked.

**Security review.** "Yes" means `alethia-security-review` before the PR leaves draft: the slice
touches tenant data, RLS, a service-role read across users, a webhook, or an operator or cron entry
point. Every slice that can move money also gets an adversarial money review against §3.3 and §6,
whatever this column says.

1. **S1: Close the live double-charge window: the refused link, the open-setup guard, and every exit
   from it (§1.1, §5.6 "The refused sync", §5.7, I15, I16).** It ships alone, first, and depends on
   nothing else in this ADR.
   Done when all seven hold, in one PR:
   1. The migration adds `closed_at`, `closed_reason`, `closed_by`, `closed_note` and
      `refused_reason` (all nullable) to `pending_org_setups`, and the partial index on
      `(created_org_id) WHERE linked_at IS NULL AND closed_at IS NULL`.
   2. **The link stops ignoring a refused sync.** It refuses with `org_has_plan` when the org's row
      names another subscription that is `active`, `trialing` or (amended 2026-10-08, #5715)
      `past_due`: before any Stripe write, and again
      after a sync that returned `"ignored"`. A refused link never calls
      `markPendingOrgSetupLinked`, never writes the payer facts, never returns a plan state, logs
      `billing.new_org_link.refused`, calls `alertPaymentNeedsSupport` with X as the subject, writes
      `refused_reason` and closes the setup, and returns `{ kind: "refused"; clause }` with the
      contact-support clause (§5.5). The linked arm is `{ kind: "linked" } & NewOrgPlanReport`. An
      `"ignored"` sync whose row names X itself is still linked (C76).
   3. The sheet turns `{ kind: "refused" }` into `SetupStopped(clause)`, which is non-retryable.
      Nothing else in the sheet changes (the rest is S10). The link mock in
      `paid-setup-plan-state.test.tsx` returns `{ kind: "linked", planState, paymentUrl }`.
   4. **The guard.** `createSubscriptionIntent`, `createCheckoutSession` and `startProTrial` refuse for
      an org that an open row names, by `created_org_id` or by the org's `newOrgSubscriptionId`
      marker, read with the service role. In `createSubscriptionIntent` it runs after the existing
      live-plan check (`billing.ts:1187-1194`). The creator and everyone else get their own messages
      (§5.5). The message to anyone else names the creator and support, and never says "finish".
      A Stripe read failure inside the guard **refuses** the purchase with the try-again clause and
      never passes it (fail closed).
   5. **The exits.** The setup closer (§5.7) has two branches. **Close:** an open setup whose X reads
      ended is closed, with the alert when the first payment is not `never_paid`. **Adopt:** an open
      setup whose X is not ended, whose `metadata.organization_id` is the org, whose
      `metadata.created_by` is the setup's user, and whose org's billing row names X (after one
      `syncSubscriptionToBilling(X)` when it does not yet) gets `linked_at` written. The guard,
      `resolveNewOrgSetup`, `findUnfinishedNewOrgSetup` and the link run it before they answer, so
      neither an ended X nor an X already linked in Stripe blocks the org. Each write is a
      compare-and-set (`… WHERE closed_at IS NULL AND linked_at IS NULL RETURNING`), and only the
      caller it returned the row to raises the alert or logs the event. Nothing closes a
      `resource_missing` X automatically.
   6. `scripts/pending-org-setups.ts close-setup <subscription_id> --reason --operator` exists as
      §5.4 says: it refuses with no reason, refuses a live or `incomplete` X and any read failure,
      and accepts an ended X or one Stripe reports `resource_missing`. Its audit event
      `billing.pending_org_setup.closed` is a structured log line with that stable name (there is
      no audit table). `apps/console/package.json` gains the `billing:pending-org-setups` alias, and
      the runbook gains a section that uses it.
   7. `alertPaymentNeedsSupport` takes a `context` (`purchase_flow`, the default and today's text;
      `link_refused`; `setup_closed`) that selects the summary's clause, so the alerts S1 adds no
      longer say "which the purchase flow cancelled or was replacing" (`payment-alert.ts:40`).

   C81 (A for the three flows, I for the co-owner), the C85 half that needs no hold, C87, C88, C89,
   C90, C93, C96 and C97 each fail on `dev` first. This slice may run past ~800 lines. I16 forbids
   shipping the guard without the writers that release it, so it is not split.
   - scope: `apps/console/lib/db/schema/pending-org-setups.ts apps/console/lib/db/migrations/** apps/console/lib/billing/pending-org-setup.ts apps/console/lib/billing/new-org-setup.ts apps/console/lib/billing/payment-alert.ts apps/console/app/server/actions/billing.ts apps/console/components/org/pending-paid-setup.ts apps/console/scripts/pending-org-setups.ts apps/console/package.json apps/console/docs/stripe-prod-runbook.md apps/console/tests/actions/billing-subscription.test.ts apps/console/tests/integration/pending-org-setups.test.ts apps/console/tests/components/org/pending-paid-setup.test.ts apps/console/tests/components/org/paid-setup-plan-state.test.tsx apps/console/tests/scripts/pending-org-setups.test.ts`
   - Blocked by: none. Migration: **yes**. Security review: **yes** (a service-role read across
     users' rows, the creator's name shown to a co-owner, and an operator command that writes them).
2. **S2: The `user:` lease (§4.4, Q2).**
   Done when the create-a-team flow and the link take `purchase_leases` with fenced renewal, the
   artifact gate and the close-out (rules 1–4). For one release they also take the old advisory
   key. The purchase path's Stripe client has a timeout, and the close-out cancel is stamped
   `alethia:closeout`. C25, C28 and C52 pass.
   - scope: `apps/console/lib/db/schema/purchase-leases.ts apps/console/lib/db/schema/index.ts apps/console/lib/db/migrations/** apps/console/lib/db/programmables.sql apps/console/lib/billing/purchase-lease.ts apps/console/lib/billing/stripe.ts apps/console/app/server/actions/billing.ts apps/console/tests/integration/payment-hold-lease.test.ts apps/console/tests/actions/billing-subscription.test.ts`
   - Blocked by: S1 (migration chain, `billing.ts`). Migration: **yes**. Security review: **yes**
     (a new service-role table with RLS).
3. **S3: Sweep classification, paging and customer reuse (§4.2, §4.5). No holds yet.**
   Done when the create-a-team sweep lists only subscriptions classified to the user, paged to the
   end (with a cap of 1000 that refuses). Another payer's subscription is alerted on and left
   alone. A customer that has `organization_id` is never reused. `unlinkedPendingOrgSetupCustomers`
   pages over every record (with a cap of 50 that refuses). **Rev 7:** the create-a-team flow and
   the link stop taking S2's old `new-org:<user>` advisory key, and the PR says it must deploy only
   after S2's rollout has completed. C18, C20, C21 and C55 fail on `dev` first. These are live
   defects, so the slice ships ahead of the holds.
   - scope: `apps/console/app/server/actions/billing.ts apps/console/lib/billing/pending-org-setup.ts apps/console/tests/actions/billing-subscription.test.ts apps/console/tests/integration/pending-org-setups.test.ts`
   - Blocked by: S2 (`billing.ts`). Migration: no. Security review: **yes** (which payer's
     subscriptions a flow may cancel).
4. **S4: The `payment_holds` table and store (§4.1).**
   Done when the migration adds `payment_holds` with the partial unique index on `subscription_id`
   and the open-row index on `payer_key`, with RLS enabled and no app policy, and the rev 7
   `notified_state` and `notified_at` columns. The store does the state-write, hint-write and
   notice-claim kinds with their fences (§4.1 table). A release to any reason but `adopted` closes
   the hold's open setup in the same transaction (§4.1, "A release decides the setup"). The
   integration tests for C51, C65, C74 and the release half of C92 pass. No caller exists.
   - scope: `apps/console/lib/db/schema/payment-holds.ts apps/console/lib/db/schema/index.ts apps/console/lib/db/migrations/** apps/console/lib/db/programmables.sql apps/console/lib/billing/payment-holds/store.ts apps/console/tests/integration/payment-holds.test.ts`
   - Blocked by: S2 (migration chain; the fence reads `purchase_leases`). **Parallel with S3.**
     Migration: **yes**. Security review: **yes** (RLS on a new table).
5. **S5: `advanceHold`, the pure machine (§3).**
   Done when `advanceHold` implements T0–T18 over an injected Stripe reader and writer, with
   positive evidence (§3.3), the refund attempt reserved before the call (§3.5), and the
   `readFirstPayment` void rule (C47). The H cases pass: C2–C5, C8, C10, C12, C14, C17, C19, C27,
   C29, C30, C33, C48–C50, C54, C71–C73, C75, C82. If the slice runs past ~800 lines, split it at
   T5: the closing path first, then refunds and release.
   - scope: `apps/console/lib/billing/payment-holds/machine.ts apps/console/lib/billing/payment-holds/observe.ts apps/console/lib/billing/first-payment.ts apps/console/tests/lib/billing/payment-holds.test.ts apps/console/tests/lib/billing/first-payment.test.ts`
   - Blocked by: S4 (the row type). **Parallel with S3.** Migration: no. Security review: no (pure
     code with no auth surface), but a money review is mandatory.
6. **S6: The sweeper, the operator script, the runbook and the backfill (§5.4, §8 step 5, Q3, Q12).**
   Done when `startPaymentHoldSweeper` boots from `instrumentation.ts` in the `registerLoop` shape,
   with a twin route behind `ALETHIA_CRON_SECRET` and `wakePaymentHoldSweeper`. The age alerts
   follow §5.4. The Q3 emails are sent by the sweeper alone, under the notice claim (C95), for
   `refund_pending`, `released(refunded)` and an adoption with no org. `scripts/payment-holds.ts` has `list`, `show`,
   `release` (T16, audited) and `reconcile [--backfill]` (B1–B6). The runbook documents them and
   the `system.platform.payment_needs_support` rule. C19 (release), C53 (sweeper half), C58, C59
   and C61 (age) pass.
   - scope: `apps/console/lib/billing/payment-holds/sweeper.ts apps/console/lib/billing/payment-holds/emails.ts apps/console/lib/email/billing-email.ts apps/console/instrumentation.ts apps/console/app/api/internal/payment-holds/** apps/console/scripts/payment-holds.ts apps/console/docs/stripe-prod-runbook.md apps/console/tests/integration/payment-hold-sweeper.test.ts apps/console/tests/scripts/payment-holds.test.ts`
   - Blocked by: S5. Migration: no. Security review: **yes** (a cron route and an operator
     command that releases holds).
7. **S7: The webhook (§5.3, Q6).**
   Done when there is no backup-card retry on a held or ended create-a-team invoice (C41, C83), the
   receipt rule covers held invoices (C9, C64, C83), and a stamped deletion is silent (C63, C67).
   Events nudge open holds with a hint write and wake the sweeper after the response (C53, C66).
   `WEBHOOK_EVENTS` gains `charge.refund.updated` and `invoice.voided`. C69 and C76 re-run green.
   - scope: `apps/console/lib/billing/webhook-handler.ts apps/console/app/api/webhooks/stripe/route.ts apps/console/scripts/stripe-setup.ts apps/console/tests/lib/billing/webhook-holds.test.ts`
   - Blocked by: S4 (reads holds) and S6 (`wakePaymentHoldSweeper`). **Parallel with S3.**
     Migration: no. Security review: **yes** (the webhook).
8. **S8: The create-a-team flow on holds (§4.3, §5.1, §5.2, §5.5).**
   Done when the flow opens a hold before every void or cancel (I4), advances every open hold of the
   user, and mints only through I1 (a)–(c), including the live check (C24). Its `canceled`-prior arm
   is replaced. Today's two cancels are stamped (`billing.ts:1034` as the create-a-team sweep calls
   it, and `:1744`). The §5.5 composer and `notice` on `{ kind: "intent" }` are in place. The gap
   test `billing-subscription.test.ts:1524-1550` is flipped. **Rev 7:** the setup closer and
   `close-setup` gain the open-hold `NOT EXISTS` (I16, C92); §4.3 reads its own record set (C94);
   `forgetPendingOrgSetup` gains its hold condition (§8); the guard's creator message carries an
   open hold's clause. The A cases pass: C1, C6, C7, C11, C13, C15, C16, C24, C26, C31, C32,
   C34–C39, C56, C94. **Deploy only after an operator has run `payment-holds reconcile --backfill`
   (S6), and run it again once the rollout has completed (§8).**
   - scope: `apps/console/app/server/actions/billing.ts apps/console/lib/billing/new-org-hold-copy.ts apps/console/lib/billing/pending-org-setup.ts apps/console/scripts/pending-org-setups.ts apps/console/tests/actions/billing-subscription.test.ts apps/console/tests/actions/billing-new-org-holds.test.ts apps/console/tests/integration/pending-org-setups.test.ts`
   - Blocked by: S3, S5, S6, S7. Migration: no. Security review: **yes** (the purchase path).
9. **S9: The link and the resume lookups (§5.6).**
   Done when the link takes the `user:` lease, consults holds before any Stripe write, and returns
   `{ kind: "linked" } & NewOrgPlanReport | { kind: "refused"; clause }` by the §5.6 table. A
   refusal closes the setup only when X is ended and unheld; otherwise it writes `refused_reason`
   and leaves it open (I16). The live-paid-plan refusal opens a `needs_operator` hold that alerts.
   No `paymentUrl` is returned while a hold is open. `NewOrgSetupState` gains `hold`. **Rev 7:** the
   link's core runs without a session, re-checking U's `manage_billing`, and the sweeper, the
   purchase flow and `payment-holds release` call it after an `adopted` release whose setup has an
   org (§5.6 "When a hold ends"). The backfill listing prints S1-era `org_has_plan` closures whose X
   is live (§8). C57, C60, C77, C80, C84, C85, C86 and C91 pass on the server side.
   **Follow-ups from the S1 review (amendment 2026-10-08, #5715), owned here:** (1) the refusal's
   clause can omit "We have raised this with support." when the in-link setup closer
   (`settleOpenSetup`, which runs before the refusal) already closed the setup with `org_has_plan`
   and alerted: the refusal then closes nothing, reads `org_has_plan`, and skips its own alert, so
   the copy under-claims; (2) a refused X with **no** setup record re-alerts on every retried link,
   limited only by the alert rule's throttle.
   - scope: `apps/console/app/server/actions/billing.ts apps/console/lib/billing/new-org-setup.ts apps/console/lib/billing/new-org-plan-state.ts apps/console/lib/billing/pending-org-setup.ts apps/console/lib/billing/payment-holds/sweeper.ts apps/console/scripts/payment-holds.ts apps/console/tests/actions/billing-subscription.test.ts apps/console/tests/actions/billing-new-org-link.test.ts apps/console/tests/integration/payment-hold-sweeper.test.ts`
   - Blocked by: S8. Migration: no (`closed_at` came with S1). Security review: **yes** (the link
     writes Stripe metadata and the org's billing row).
10. **S10: The sheet (§5.6 "The sheet").**
    Done when `runSteps` stops where the link would refuse, before creating the org and also on a
    resume where the org already exists, writing nothing (the lookup has already closed what is
    closable, §5.6) (C78), renders a
    typed refusal as non-retryable with its clause and clears the browser record (C57, S half), and
    keeps "Retry to complete setup" only for a thrown error, without "you won't be charged again"
    (C79, C32 S half). #5539's re-read loop stops on a reported hold. **Amendment (2026-10-14,
    #5974):** the ended half of rule 1 is not S10's. The lookup does not report an ended X, so S10
    cannot build it. It moves to S10b. S10 stops on a reported hold only. Its PR references #5970
    without closing it. **Follow-up from the S1
    review (amendment 2026-10-08, #5715), owned here:** a stale client can still call the link for
    an X whose setup is already closed: the link runs the closer, which answers `closed`, and does
    not refuse on it. If the board labels it
    `class:ui`, it opens as a draft and stays one (CLAUDE.md §4).
    - scope: `apps/console/components/org/pending-paid-setup.ts apps/console/components/org/create-org-sheet.tsx apps/console/tests/components/org/**`
    - Blocked by: S9. Migration: no. Security review: no.
10b. **S10b: The lookup reports an ended setup, and the sheet stops on it (§5.6 "The lookup reports
    an ended setup", rule 1; amendment 2026-10-14, #5974).** File it only after this amendment
    merges. Its PR closes #5970.
    Done when:
    - `NewOrgSetupState` has `ended: { clause: string } | null`.
    - `endedSetupRead` and `endedSetupClause` live in `lib/billing/new-org-setup.ts`, with the five
      sentences moved there from `billing.ts:922-929`.
    - `refuseEndedLink` uses them, and its strings and alert behaviour are unchanged (the existing
      C86 and C57 assertions stay green).
    - `newOrgSetupStateFor` fills `ended`. For an `unconfirmed` read it raises the alert through
      `alertEndedUnconfirmed`, the one function `refuseEndedLink` also uses, under the link's dedupe.
      It makes no other write.
    - `runSteps` throws `SetupStopped(ended.clause)` before `authClient.organization.create` and
      before the link, both when no org exists and on a resume where one does.
    - **`billing.ts` has no private `isOrgPlanSubscription`** (final review, advisory 5). If F3
      (#5979) has put its private copy on `dev`, S10b deletes it and imports S11's export from
      `lib/billing/sync.ts`, so exactly one definition exists. If F3 is still open, its PR is told to
      import the export on rebase instead of defining its own. C100's AI controls and F3's tests both
      run against the one definition.

    C103–C107 pass, and each fails on `dev` first.
    - scope: `apps/console/app/server/actions/billing.ts apps/console/lib/billing/new-org-setup.ts apps/console/components/org/pending-paid-setup.ts apps/console/tests/actions/billing-new-org-link.test.ts apps/console/tests/lib/billing/new-org-setup.test.ts apps/console/tests/components/org/**`
    - Blocked by: S10, which shares `pending-paid-setup.ts` and `tests/components/org/**`, and S11,
      whose `sync.ts` export it imports. Migration:
      no. Security review: no. It reads only the caller's own setup and holds, through the lookup's
      existing ownership checks (`billing.ts:3049-3051`). Its one new side effect is the link's existing alert, raised through the same function.
11. **S11: The moved release of a `link_refused` hold (§5.8; amendment 2026-10-14, #5974).** File
    it only after this amendment merges.
    Done when `payment-holds release <X> --moved-to <T> --reason --operator` exists as §5.8 says:
    - It runs under the payer's lease.
    - Its database reads come first: T, U's membership of T and the setup. Stripe is read only after
      rows 1–4 pass.
    - Steps 7–9 run inside `withPurchaseLock('org-plan:<T>')`. A busy lock gives
      `team_purchase_in_progress`.
    - The Stripe reads are X, X's customer, T's row (before any sync), the direct listings of T's
      customers, and the search. Each is capped, and a reached cap gives `stripe_unreadable`.
    - `decideMovedRelease` in `machine.ts` is pure. It returns the typed refusals in the table's
      order (rows 1–4, L, 5–14), `read_stripe`, `sync_first` or `release`.
    - `holdsManageBilling` is exported from `sweeper.ts` and reused, not restated.
      `isOrgPlanSubscription` is defined once, exported, in `lib/billing/sync.ts`, with F3's body
      (#5979).
    - `releaseHold` takes an optional `expectOrgRow`, checked with `FOR SHARE` in its transaction. On
      a mismatch it writes nothing, and the command refuses with `row_changed`.
    - It syncs X at most once.
    - The release goes through `operatorRelease` with `release_note = "moved to <T>: <reason>"`.
      `operatorRelease` now passes `closedSetupId` through.
    - The audit event carries `moved_to`, `payer`, `customer_id`, `row_subscription_id`,
      `row_status`, `listed_customers`, `listed_subscription_count` and `setup_closed`, and only the
      caller whose compare-and-set landed writes it.
      The plain T16 event is unchanged.
    - The plain release's re-link refusal names `--moved-to` for a `link_refused` hold.
    - The runbook's payment-holds section (`docs/stripe-prod-runbook.md` §7) gains the moved path:
      1. Support confirms with U, in writing, that **U's own payment method keeps paying for X,
         and for every later purchase T makes** (plan and seat changes, new plans, Checkout),
         because T's billing row then names U's customer. Stripe cannot move a subscription to another customer, so X's customer, and that
         customer's default payment method, are still U's.
      2. Support asks T's owners whether a hosted Checkout for T is open and unpaid (§5.8, "Shape
         2"). If one is, that Checkout is settled or expired first.
      3. Support checks that U is an owner of T. If U is not, U may be made one only with the
         agreement of T's existing owner, because that changes who governs T, not only who pays.
      4. If T's payer, not U, is meant to pay, support does **not** move X. It cancels and refunds
         X (the plain `release` then settles the hold), and T buys its own plan.
      5. Otherwise support sets `organization_id` to T on X **and** on X's customer, then runs the
         command. If it answers `too_soon`, support waits for the time it prints.
      6. The 15-minute index-lag assumption (§5.8, "The windows that are left") is recorded as
         unmeasured until S11 measures it in Stripe test mode.

    C98–C102, C108 and C109 pass, with C100's N1 and N2 fixtures, and each fails on `dev` first. No migration: the release reason
    stays `operator`, and the team is recorded in `release_note`.
    - scope: `apps/console/scripts/payment-holds.ts apps/console/lib/billing/payment-holds/machine.ts apps/console/lib/billing/payment-holds/store.ts apps/console/lib/billing/payment-holds/sweeper.ts apps/console/lib/billing/sync.ts apps/console/docs/stripe-prod-runbook.md apps/console/tests/scripts/payment-holds.test.ts apps/console/tests/lib/billing/payment-holds.test.ts apps/console/tests/integration/payment-holds.test.ts`
    - Blocked by: this amendment (S9, whose `scripts/payment-holds.ts` it extends, has merged:
      `74a6dcdc1`). **Parallel with S10**, whose scope it does not share. When S11 is filed, re-check `sweeper.ts` and `sync.ts` against every open issue's `scope:`.
      Neither is in S10's or S10b's scope. Any open lane that holds either one chains S11 behind
      it. Migration: no. Security
      review: **yes** (an operator command that releases a hold over a live, paid subscription, and
      closes a setup while that subscription is live). It also gets the money review.

Order: S1 → S2, then two lanes. Lane (a) is S3. Lane (b) is S4 → S5 → S6 → S7. The lanes join at
S8, then S9 → S10. The two lanes' scopes are disjoint (rev 7 re-checked: S4's release-closes-setup
write lives in `payment-holds/store.ts`, not in S3's `pending-org-setup.ts`). S8's and S9's scopes
reach S1's and S6's files, which is sound because they run after both. Amendment (2026-10-14,
#5974): S11 follows S9 and runs in parallel with S10. S10b follows S10.

### 10.2 Follow-up issues for the descoped flows (proposed, not filed)

#5506's acceptance criteria 8, 11 and 12 are met for create-a-team by S3 and S8. For the other
flows they are not covered (§7). These three issues are proposed for them. File each one only after
S9 has merged. Until then `billing.ts` is in every in-flight slice's scope, and an open issue naming
it would fail those PRs' scope check.

- **F1. billing: payment holds for the org-plan purchase, design first (ADR 0004). AC 8 and Q13.**
  **Shipped as ADR 0004 (2026-10-14, PR #5982), accepted.** The text below is the issue as proposed.
  Rev 7: 0003 is taken by #5548 (`docs/adr/0003-chat-turn-answered-and-billed-once.md`) and 0001 by
  #5512. If 0004 is taken when F1 is filed, it takes the next number free at `origin/dev` and in
  open PRs; it never reuses a number.
  Done when an accepted ADR covers holds for `createSubscriptionIntent`. It must cover a hold scope
  per flow, so an org-plan hold never blocks or reroutes a create-a-team purchase (AC 8). It must
  also cover the superseder rule with a fresh read (rev 4's W1 and W2), the off-Stripe-grant guard,
  the two-live detector, and a `past_due` org minting a second plan. Scope: `docs/adr/**`.
- **F2. billing: the AI subscription and hosted Checkout share the org's customer with no lock and
  no sweep boundary. AC 11.**
  **Still owed, and now a prerequisite of ADR 0004** ("Order: F2 and F3 first", §11; the AI flow keeps F2's `ai:<org>` key, D3). ADR 0004 O4 later moves the org-plan half from this advisory lock to the `org-plan:` lease. The text below is the issue as proposed.
  Done when the org-plan sweep cancels or keeps only org-plan subscriptions, never an AI one.
  `createAiSubscriptionIntent` takes its own `ai:<org>` purchase lock, and `createCheckoutSession`
  takes `org-plan:<org>`. Each change has a test that fails on `dev` first. Scope:
  `apps/console/app/server/actions/billing.ts apps/console/lib/billing/purchase-lock.ts apps/console/tests/actions/billing*.test.ts`.
- **F3. billing: the org-plan purchase can mint a second plan beside an `active` subscription its
  webhook has not written yet. AC 12.**
  **Shipped in #5979 (2026-10-14).** The text below is the issue as proposed.
  Done when `createSubscriptionIntent` and `createCheckoutSession` list the org customer's
  subscriptions, fully paged, before minting. A live org-plan subscription (`active`, `trialing` or
  `past_due`) refuses with "change the plan instead". There is a test where Stripe lists an `active`
  subscription while the row still reads `none`, and it fails on `dev` first. Scope:
  `apps/console/app/server/actions/billing.ts apps/console/tests/actions/billing-subscription.test.ts`.
