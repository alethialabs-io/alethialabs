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

## Rollback

- Set `STRIPE_TAX_ENABLED=false` to drop automatic tax if registrations aren't ready.
- Re-enable Stripe's automatic emails in the dashboard (instant) if our email path has an issue.
- The webhook is fail-safe: an email error never fails the webhook (state still syncs); a handler
  error returns 500 so Stripe retries, and the event-log makes retries exactly-once.
