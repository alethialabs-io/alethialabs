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

A **payment hold** (`payment_holds`, ADR 0002) is a row saying that one create-a-team subscription is
not yet proven settled: its first invoice may still be paid, a payment on it may still land, or money
taken after its cancel must be refunded. Each hold moves through one state machine until a Stripe read
proves it settled, and is then `released` with a reason. Rows are never deleted.

### The sweeper

The console advances every open hold that is due, every 5 minutes, on every instance. A hold is due
when its `next_check_at` has passed, or when it was nudged since its last observation (the Stripe
webhook nudges holds from ADR 0002 slice 7 on). Each hold is advanced under its payer's purchase lease
(`user:<payer>`), so two instances never advance the same hold at once, and neither will the purchase
flow once it opens holds (slice 8). A hold whose lease is busy waits for the next tick.

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

### The command

Run it with the service connection (`ALETHIA_DATABASE_URL`) and the Stripe key, on Node 22.15 or later:

```sh
pnpm -C apps/console billing:payment-holds list --open [--payer <user id>]
pnpm -C apps/console billing:payment-holds show sub_…
pnpm -C apps/console billing:payment-holds release sub_… \
  --reason "<why>" --operator <your user id>
pnpm -C apps/console billing:payment-holds reconcile [--backfill] [--payer <user id>]
```

- `list` and `show` change nothing. `show` prints every hold of the subscription, its setup, and what
  Stripe says about it now: the subscription, the held invoice, and its payments and refunds.
- `release` is the way out of `needs_operator`, and of a subscription stuck `unpaid` or `paused`. It
  refuses with no `--reason`. It waits up to 30s for the payer's lease and refuses while it is still
  busy. It prints the live read, then releases the hold with `released_by` and `release_note` and logs
  one `billing.payment_hold.released` line. A second run finds no open hold and changes nothing.
  `--operator` is free text: the command does not check that it names a real user. It is recorded as
  `released_by` and in the log line, so type your own user id exactly.
  A release also closes the subscription's unfinished setup. So while a setup is open, `release`
  refuses unless Stripe reads the subscription ended or not found: cancel it in the Stripe dashboard
  first, and refund it if it was paid.
- `reconcile` runs one sweeper tick now, so it can also send the customer emails above. With
  `--backfill` it first runs the backfill below.

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

1. **B1:** it is a create-a-team subscription (`created_by` set, no `organization_id`).
2. **B2:** it was cancelled on request, or expired.
3. **B3:** it has exactly one invoice, the first one.
4. **B4:** that invoice was unpaid when the subscription ended, or was paid after it ended.
5. **B5:** every payment on it used a card.
6. **B6:** no order names it as withdrawn or refunded.

Each hold is advanced at once: an unpaid invoice is voided, and a payment that landed after the end is
refunded. One case is held but not advanced: an invoice with **no** PaymentIntent proves nothing about how
it would be paid (B5). That hold opens in `needs_operator`, the alert names the subscription, and you
decide it with `show` and `release`. Every other create-a-team subscription is printed as `LISTED <sub>: <the failed test>`, and
nothing is written for it. Each one is a support decision: use `show` as the evidence, and refund in the
Stripe dashboard only when the customer did not mean to keep it. A second run skips every subscription a
hold has named, so it writes nothing new.

## Rollback

- Set `STRIPE_TAX_ENABLED=false` to drop automatic tax if registrations aren't ready.
- Re-enable Stripe's automatic emails in the dashboard (instant) if our email path has an issue.
- The webhook is fail-safe: an email error never fails the webhook (state still syncs); a handler
  error returns 500 so Stripe retries, and the event-log makes retries exactly-once.
