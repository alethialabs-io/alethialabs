# Stripe production runbook (Alethia Labs DPK — live mode)

How to take the Stripe integration live and keep it "set-and-forget". Test and live are
**separate datasets** in Stripe — the catalog, webhook endpoint, and env below must all be
created again against the **live** secret key. Everything here is idempotent/re-runnable.

Prereqs: the live secret key (`sk_live_…`) and publishable key (`pk_live_…`) from the
**Alethia Labs DPK** account, and write access to the prod env vault
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

SES (branded billing emails) must also be live — these are already documented, confirm they're set:
`ALETHIA_SES_REGION`, `EMAIL_FROM` (general stream, e.g. `Alethia <hello@mail.alethialabs.io>`),
and optionally `ALETHIA_SES_GENERAL_CONFIG_SET`. Billing emails send on the **general** stream.

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

We own the billing emails via SES, but roll it out safely:

1. **Initially, leave Stripe's automatic customer emails ON** (Settings → Emails → "Successful
   payments", "Failed payments", etc.). Customers may briefly get both.
2. Watch ~1 week of live events: verify our SES receipt/dunning/trial/cancel emails match reality
   (right recipient, amounts, PDF attached, exactly one per event — the `stripe_webhook_event`
   ledger guarantees no duplicates on Stripe retries).
3. **Then disable Stripe's customer emails** so customers get one consistent Alethia-branded
   experience. Our emails remain the source of truth for customer comms; Stripe stays the source
   of truth for the invoice data + PDF.

## Rollback

- Set `STRIPE_TAX_ENABLED=false` to drop automatic tax if registrations aren't ready.
- Re-enable Stripe's automatic emails in the dashboard (instant) if our SES path has an issue.
- The webhook is fail-safe: an email error never fails the webhook (state still syncs); a handler
  error returns 500 so Stripe retries, and the event-log makes retries exactly-once.
