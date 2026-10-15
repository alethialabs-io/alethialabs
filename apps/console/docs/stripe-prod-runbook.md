# Stripe production activation runbook (inactive)

> **Do not run this procedure.** No paid consumer market is active. Activation requires an approved
> commerce launch covering terms, withdrawal/cancellation rights, pricing disclosures, tax/VAT,
> invoicing, refund handling, and a production verification pass. This document only preserves the
> technical seam for that later project.

How to take the Stripe integration live and keep it "set-and-forget". Test and live are
**separate datasets** in Stripe — the catalog, webhook endpoint, and env below must all be
created again against the **live** secret key. Everything here is idempotent/re-runnable.

Prereqs: the live secret key (`sk_live_…`) and publishable key (`pk_live_…`) from the
**ALETHIA LABS (EIK 208913663)** account, and write access to the prod env vault
(AWS Secrets Manager `alethia/prod/env`).

---

## 1. Create the live catalog + webhook endpoint

```bash
STRIPE_SECRET_KEY=sk_live_… \
  node apps/console/scripts/stripe-setup.mjs \
  --webhook-url=https://alethialabs.io/api/webhooks/stripe
```

This ensures (idempotently): the **Alethia Pro** product + per-seat price, the
`alethia_runner_minutes` billing meter, the graduated runner-minutes overage price, and a
**webhook endpoint** subscribed to the full event set the handler processes:

- `customer.subscription.created | updated | deleted | trial_will_end`
- `checkout.session.completed`
- `invoice.payment_succeeded | payment_failed`
- `payment_intent.succeeded`

It prints the live `STRIPE_PRICE_TEAM`, `STRIPE_PRICE_METER_TEAM`, and (on first creation)
`STRIPE_WEBHOOK_SECRET`. If the endpoint already exists it **re-syncs `enabled_events`** but
can't re-read the secret — roll it in the dashboard if you need a fresh one.

> The event set is defined once in `scripts/stripe-setup.mjs` (`WEBHOOK_EVENTS`) and mirrored
> by the handler in `app/api/webhooks/stripe/route.ts`. Keep them in step when adding events.

## 2. Push env into the prod vault (`alethia/prod/env`)

Set (live values):

| Key | Value |
|-----|-------|
| `ALETHIA_DEPLOYMENT_MODE` | `hosted` |
| `STRIPE_SECRET_KEY` | `sk_live_…` |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `pk_live_…` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` (from step 1 or the dashboard) |
| `STRIPE_PRICE_TEAM` | from step 1 |
| `STRIPE_PRICE_METER_TEAM` | from step 1 |
| `STRIPE_TAX_ENABLED` | `true` only once Stripe Tax origin + registrations are set up |

The approved transactional email provider must also be live. Hosted production currently uses
Resend (`EMAIL_PROVIDER=resend`, `RESEND_API_KEY`); re-verify this at commerce activation time.

Redeploy the console so it picks up the new env.

## 3. Configure the live dashboard

These feed Stripe's compliant invoice **PDF** (which we attach to our branded receipt) and the
Customer Portal:

- **Branding** (Settings → Branding): logo, icon, brand color — appears on the invoice PDF + portal.
- **Invoicing** (Settings → Invoicing): invoice number prefix/sequence, default memo + footer,
  default payment terms. Sequential numbering is what makes the PDF a compliant invoice.
- **Customer emails** (Settings → Emails): see the staged flip in step 5.
- **Tax** (only if `STRIPE_TAX_ENABLED=true`): set the origin address + registrations first, or
  checkout errors.

## 4. Smoke-test on live

- Subscribe a real org (or run a $1 test), then confirm:
  - The webhook shows **200** in the dashboard (Developers → Webhooks → your endpoint).
  - A branded **receipt** email arrives with the **invoice PDF attached**.
  - `organization_billing` flipped to `active`, and a `stripe_webhook_event` row is `done`.
- Trigger a failed payment (a test card that declines on renewal) → confirm the **dunning** email.

## 5. Staged email flip (own the customer experience)

We own the billing emails through the configured transactional provider, but roll it out safely:

1. **Initially, leave Stripe's automatic customer emails ON** (Settings → Emails → "Successful
   payments", "Failed payments", etc.). Customers may briefly get both.
2. Watch ~1 week of live events: verify our receipt/dunning/trial/cancel emails match reality
   (right recipient, amounts, PDF attached, exactly one per event — the `stripe_webhook_event`
   ledger guarantees no duplicates on Stripe retries).
3. **Then disable Stripe's customer emails** so customers get one consistent Alethia-branded
   experience. Our emails remain the source of truth for customer comms; Stripe stays the source
   of truth for the invoice data + PDF.

## 6. Close a paid team setup that blocks its organization

A paid create-a-team setup is **open** from the payment until its subscription is linked to the new
team (`pending_org_setups`, `linked_at IS NULL AND closed_at IS NULL`). While it is open, that team
cannot start a plan, a Checkout or a trial: the purchase is refused with "… started a paid setup for
this team that has not finished …" (ADR 0002 §5.7). This stops a second subscription renewing beside
the first.

Most setups end on their own. The console closes a setup whose subscription is ended, and marks
linked a setup whose subscription already names the team. Two cases need you:

- The subscription is **live** and its creator will not come back to finish it.
- Stripe **cannot find** the subscription (`resource_missing`). The console never closes this case
  itself, because a wrong API key also makes every subscription read as missing.

Do these steps:

1. Find the subscription id in the alert, or in the customer's message.
2. For a live subscription, cancel it in the Stripe dashboard first. Refund it if it was paid. The
   command refuses a live or `incomplete` subscription.
3. For a missing subscription, check that `STRIPE_SECRET_KEY` is the right account's key.
4. Run the command with the service connection (`ALETHIA_DATABASE_URL`) and the Stripe key:

   ```sh
   pnpm -C apps/console billing:pending-org-setups close-setup sub_… \
     --reason "creator unreachable; cancelled and refunded in Stripe" --operator <your user id>
   ```

The command prints the setup row and what Stripe says about the subscription. It closes the setup
only when the subscription is ended or not found, and refuses with no `--reason`. Each close writes
`closed_by` and `closed_note` on the row and logs one `billing.pending_org_setup.closed` line. A second
run changes nothing.

Two other log lines are worth a search when a customer asks about a paid team:

- `billing.new_org_link.refused`: the link refused a payment because the team already had another
  live plan. The payment is unlinked and keeps renewing until you refund it or move it. An operator
  alert names the subscription.
- `billing.pending_org_setup.adopted`: a setup that Stripe had already linked was marked linked.

## 7. Payment holds: the sweeper, its alert, and the operator command

A **payment hold** (`payment_holds`, ADR 0002) is a row saying that one subscription is not yet proven
settled: its first invoice may still be paid, a payment on it may still land, or money taken after its
cancel must be refunded. Each hold moves through one state machine until a Stripe read proves it
settled, and is then `released` with a reason. Rows are never deleted.

Every hold has a **scope** (ADR 0004 D1), shown as `scope` on every line the command prints:

| Scope | What it holds | Payer (`payer_key`) | Lease |
|---|---|---|---|
| `new_org` | a create-a-team subscription (ADR 0002) | the user who created it | `user:<user id>` |
| `org_plan` | an org-plan subscription: one whose own `organization_id` names the org, and that has no `product_type` (ADR 0004 §2) | the org | `org-plan:<org id>` |

A payer id alone never names a hold: always read it with its scope. An `org_plan` hold closes no team
setup when it is released, and its emails go to the org's Stripe customer's email.

### The sweeper

The console advances every open hold that is due, every 5 minutes, on every instance. A hold is due
when its `next_check_at` has passed, or when it was nudged since its last observation (the Stripe
webhook nudges holds from ADR 0002 slice 7 on). Each hold is advanced under its payer's purchase lease
(`user:<payer>` for `new_org`, `org-plan:<org>` for `org_plan`), so two instances never advance the
same hold at once, and neither will the purchase flow once it opens holds (slice 8). A hold whose lease
is busy waits for the next tick.

The same tick has a twin route for an external cron or a manual run. It needs the bearer secret
`ALETHIA_CRON_SECRET`, answers 503 when the secret is unset, and returns counts only:

```sh
curl -fsS -X POST -H "Authorization: Bearer $ALETHIA_CRON_SECRET" \
  https://<console host>/api/internal/payment-holds/sweep
```

The sweeper also sends the customer emails about a hold, at most once per hold and state:

- the refund was issued (`refund_pending`);
- the refund went through in full (`released`, reason `refunded`);
- the payment went through and the team can be finished from Create a team (`released`, reason
  `adopted`, when the setup has no team yet).

### The alert rule `system.platform.payment_needs_support`

Every hold that needs a person raises this alert on the platform operator's org. Set it up once, or the
alert is only a `[billing] payment needs support` line in the console log:

1. Set `ALETHIA_PLATFORM_ALERT_ORG_ID` to the operator org's id in the prod env.
2. In that org, open **Alerts** and create a rule for **Customer payment needs manual review**
   (`system.platform.payment_needs_support`, under Platform health). Bind it to the on-call channel.

The alert names the subscription. It is raised when a hold moves to `needs_operator`, and when a hold
has sat in one state longer than its bound:

| State | Alert after |
|---|---|
| `closing`, `cancel_unproven` | 1h if its payment succeeded, 8 days if authorised, 14 days if processing, else 24h |
| `payment_in_flight` | 8 days if authorised, else 14 days |
| `invoice_payable` | 24h |
| `refund_due` | 48h (the refund budget itself sends it to `needs_operator` after about 8h35m of failed attempts) |
| `refund_pending` | 24h after a refund went `requires_action`, and again at 14 days |
| `needs_operator` | 24h, then every 7 days, only when its first alert did not reach a channel |

Each age alert is raised once per state and bound, whether or not it reached a channel. Only
`needs_operator` re-alerts on its own.

**Production must set `ALETHIA_PLATFORM_ALERT_ORG_ID`.** The relink retry (ADR 0002 §4.1 "The relink
retry") records its give-up alert, and a failed relink check's alert, only once the alert reaches a
channel. Without the variable no alert ever reaches one. Each such adopted hold then re-runs its relink
once a day, for good, and the only signal is a `[billing] payment needs support` error line in the
console log.

### The command

Run it with the service connection (`ALETHIA_DATABASE_URL`) and the Stripe key, on Node 22.15 or later:

```sh
pnpm -C apps/console billing:payment-holds list --open [--scope new_org|org_plan] [--payer <user or org id>]
pnpm -C apps/console billing:payment-holds show sub_…
pnpm -C apps/console billing:payment-holds release sub_… \
  --reason "<why>" --operator <your user id>
pnpm -C apps/console billing:payment-holds reconcile [--backfill] [--scope new_org|org_plan] [--payer <user or org id>]
```

- `--scope` names one scope. With `--payer`, the pair is the filter: `--payer` is a user id for
  `new_org` and an org id for `org_plan`. A `--scope` with no value, or with any other value, is refused
  before anything is read. On `reconcile`, `--scope` and `--payer` narrow only the sweeper tick. The
  backfill always reads the whole account, both scopes.
- `list` and `show` change nothing. `show` prints every hold of the subscription, its setup, and what
  Stripe says about it now: the subscription, the held invoice, and its payments and refunds.
- `release` is the way out of `needs_operator`, and of a subscription stuck `unpaid` or `paused`. It
  refuses with no `--reason`. It waits up to 30s for the payer's lease and refuses while it is still
  busy. It prints the live read, then releases the hold with `released_by` and `release_note` and logs
  one `billing.payment_hold.released` line. A second run finds no open hold and changes nothing.
  `--operator` is free text: the command does not check that it names a real user. It is recorded as
  `released_by` and in the log line, so type your own user id exactly.
  It takes the hold's own lease (`user:<payer>` or `org-plan:<org>`).
  A `new_org` release also closes the subscription's unfinished setup. So while a setup is open, that
  `release` refuses unless Stripe reads the subscription ended or not found: cancel it in the Stripe
  dashboard first, and refund it if it was paid. An `org_plan` release closes no setup, so this rule does
  not apply to it.
- `reconcile` runs one sweeper tick now, so it can also send the customer emails above. With
  `--backfill` it first runs the backfill below.

### Moving a refused payment to the right team (`release --moved-to`)

When a customer pays for a new team but the team already has an active plan, the payment is not
linked. Its hold waits for an operator with the note `link_refused`, and the customer is told that
support "will refund it or move it to the right team". Refunding is the plain `release` above, once the
subscription is cancelled. Moving it is this path (ADR 0002 §5.8):

```sh
pnpm -C apps/console billing:payment-holds release sub_… --moved-to <team id> \
  --reason "<why>" --operator <your user id>
```

Before you run it, in this order:

1. **Confirm with the payer, in writing, that their own payment method keeps paying.** Stripe cannot
   move a subscription to another customer, so the subscription's customer, and that customer's default
   payment method, stay the payer's. Once the team's billing row names the subscription, the row names
   the payer's customer, so the payer's payment method also pays for **every later purchase the team
   makes**: plan and seat changes, new plans, and Checkout.
2. **Ask the team's owners whether a hosted Checkout for the team is open and unpaid.** If one is, it
   is paid or expired first. The command cannot see an unpaid Checkout, and one paid after the move
   bills the team twice.
3. **Check that the payer is an owner of the team.** If they are not, they may be made one only with
   the agreement of the team's existing owner, because that changes who governs the team, not only who
   pays. The command refuses (`payer_not_in_team`) unless the payer is an active owner who can manage
   the team's billing.
4. **If the team's own payer, not this payer, is meant to pay, do not move the subscription.** Cancel
   and refund it in Stripe (the plain `release` then settles the hold), and the team buys its own plan.
5. **Otherwise, in the Stripe dashboard, set `organization_id` to the team's id on the subscription
   AND on its customer**, then run the command. If it answers `too_soon`, wait until the time it prints
   and run it again.

The command moves nothing and writes nothing to Stripe. It checks that the move has fully happened, then
releases the hold with `release_note = "moved to <team id>: <reason>"` and closes the setup. Each
refusal prints a code and what to do instead. It refuses while the team is billed by, or is buying,
another plan subscription (`team_has_other_plan`); an AI add-on does not count. The audit line
`billing.payment_hold.released` also carries `moved_to`, `payer`, `customer_id`, `row_subscription_id`,
`row_status`, `listed_customers`, `listed_subscription_count` and `setup_closed`.

**An unmeasured assumption.** When the team's billing row already names the subscription, `too_soon`
waits until 15 minutes after the row **last changed** (`organization_billing.updated_at`, which every
write to the row bumps: a sync, the usage cap, the AI spend caps, the payer facts), on the assumption that Stripe's search sees everything the team bought before the move by
then. That lag has **not** been measured yet; it is to be measured in Stripe test mode (ADR 0002 §5.8,
"The windows that are left").

The plain `release` of such a hold, after the subscription was moved, refuses and names `--moved-to`.

### The backfill

Until the create-a-team purchase opens holds (ADR 0002 slice 8), it cancels checkouts and keeps no
record of them. The backfill finds them in Stripe. Run it **before** slice 8 deploys, and **again**
once that release has rolled out to every instance, because old instances keep cancelling without holds
until then:

```sh
pnpm -C apps/console billing:payment-holds reconcile --backfill
```

It reads every `canceled` and `incomplete_expired` subscription in the account. It holds a subscription
only when all six tests pass:

1. **B1:** it is an org-plan subscription of some org (its own `organization_id` set, no
   `product_type`), or a create-a-team subscription (`created_by` set, no `organization_id`). An AI
   subscription is neither, and is skipped without being printed.
2. **B2:** it was cancelled on request, or expired.
3. **B3:** it has exactly one invoice, the first one.
4. **B4:** that invoice was unpaid when the subscription ended, or was paid after it ended.
5. **B5:** every payment on it used a card.
6. **B6:** no order names it as withdrawn or refunded.

Each hold is advanced at once: an unpaid invoice is voided, and a payment that landed after the end is
refunded. One case is held but not advanced: an invoice with **no** PaymentIntent proves nothing about how
it would be paid (B5). That hold opens in `needs_operator`, the alert names the subscription, and you
decide it with `show` and `release`. Every other subscription that passes B1 is printed as
`LISTED <sub>: <the failed test>`, and nothing is written for it. Each one is a support decision: use
`show` as the evidence, and refund in the Stripe dashboard only when the customer did not mean to keep
it. A second run skips every subscription a hold of either scope has named, so it writes nothing new.

Each held subscription is printed as `HELD <sub>: hold <id>, <scope> of <payer>, …`:

| B1 found | Held as | `payer_key` | Taken under |
|---|---|---|---|
| an org-plan subscription (`organization_id` set, no `product_type`), including a linked create-a-team one, which carries `organization_id` too | `org_plan` | its `organization_id` | `org-plan:<org id>` |
| a create-a-team subscription (`created_by` set, no `organization_id`) | `new_org` | its `created_by` | `user:<user id>` |

### The org-plan backfill and the deploy order (ADR 0004 §9)

Until the org-plan purchase opens holds (ADR 0004 slice O6), it cancels never-paid checkouts and keeps
no record of them. From ADR 0004 slice O5 on, the same `reconcile --backfill` also finds those in Stripe
and holds them as `org_plan` holds (the table above). B2–B6 are unchanged, and
everything they cannot prove is listed, never held.

What it cannot tell apart: the old org-plan path stamped none of its cancels, so B2's
`cancellation_requested` also matches a customer's own cancel. B3 (one `subscription_create` invoice)
and B4 (unpaid when it ended) keep a cancelled plan that was used out of the holds. A trial's first
invoice is paid at once, for nothing, before the trial ends, so B4 never holds a trial. Every cancel on the old
path that it could not settle raised an operator alert, so check the `LISTED` org-plan lines against
those alerts.

**Deploy O6 only when all three hold** (ADR 0004 §9 step 6):

1. O4's rollout has been complete for **more than 24h**. That is the advisory key's precondition, and
   the second guard against the keyless-Checkout finding (ADR 0004 rev 2's money-review blocker, case
   C44; not the backfill's test B1 above): every Checkout session without a session-level key has
   then reached Stripe's default expiry.
2. An operator has run the widened backfill (this section, ADR 0004 §9 step 5).
3. The backfill runs **again** once O6's rollout has completed, because old instances keep cancelling
   without holds until then.

**Before O6 deploys, also work the open `org_plan` holds.** Once O6 is live, every open `org_plan`
hold except `refund_pending` refuses its org's plan purchase, Checkout and trial (ADR 0004 §4.1),
and a `needs_operator` hold stays open until an operator releases it. So after the first backfill:

1. Run `list --open --scope org_plan`, and `show` each `needs_operator` hold.
2. Release each hold support has decided, with `release <sub> --reason "<why>" --operator <your user
   id>`. Cancel or refund the subscription in Stripe first where support decided that.
3. Leave open only the holds that are still undecided. Each one blocks its org's next purchase until it
   is released.

```sh
pnpm -C apps/console billing:payment-holds reconcile --backfill   # before O6 deploys
pnpm -C apps/console billing:payment-holds list --open --scope org_plan
pnpm -C apps/console billing:payment-holds show sub_…              # each needs_operator hold
pnpm -C apps/console billing:payment-holds release sub_… --reason "<why>" --operator <your user id>
pnpm -C apps/console billing:payment-holds reconcile --backfill   # again, once O6 has rolled out everywhere
```

## Rollback

- Set `STRIPE_TAX_ENABLED=false` to drop automatic tax if registrations aren't ready.
- Re-enable Stripe's automatic emails in the dashboard (instant) if our email path has an issue.
- The webhook is fail-safe: an email error never fails the webhook (state still syncs); a handler
  error returns 500 so Stripe retries, and the event-log makes retries exactly-once.
