# Stripe runbook: account setup as code, go-live, and billing operations

> **Live sales stay closed until EA-8 opens a cell** (`packages/legal/src/paid-markets.ts`). That
> switch is the maintainer's. Sections 1 to 4 set up an account so it is ready for it. Running them
> against the live account does not open a market.

Stripe test mode and live mode are **separate datasets**. Both are set up by the same script,
`apps/console/scripts/stripe-setup.ts`, and checked by the same read-only script,
`apps/console/scripts/stripe-check.ts`. Keys reach them only through the credential broker
(`pnpm creds`), never on a command line or in a file you can read.

| Profile | Holds | Store it with |
|---|---|---|
| `stripe-test` | the test-mode secret key, as `STRIPE_API_KEY` | `! pnpm creds --set stripe-test` |
| `stripe-live` | the live-mode secret key, as `STRIPE_API_KEY` | `! pnpm creds --set stripe-live` |

The maintainer types the key; the broker does not echo it. A restricted key (`rk_…`) works if it can
read and write products, prices, meters, tax settings, portal configurations, payment method
configurations and webhook endpoints, and read the account.

---

## 1. Plan, apply, check

Every run prints the account it targets first, as `→ Stripe TEST mode · account acct_… · <name> ·
country BG`. Read that line before anything else.

```sh
# Test mode
pnpm creds stripe-test -- pnpm -C apps/console run stripe:setup -- --plan
pnpm creds stripe-test -- pnpm -C apps/console run stripe:setup -- --apply
pnpm creds stripe-test -- pnpm -C apps/console run stripe:check

# Live mode: every command needs --live, and a live key without it is refused
pnpm creds stripe-live -- pnpm -C apps/console run stripe:setup -- --live --plan \
  --webhook-url=https://alethialabs.io/api/webhooks/stripe
pnpm creds stripe-live -- pnpm -C apps/console run stripe:setup -- --live --apply \
  --webhook-url=https://alethialabs.io/api/webhooks/stripe
pnpm creds stripe-live -- pnpm -C apps/console run stripe:check -- --live \
  --webhook-url=https://alethialabs.io/api/webhooks/stripe
```

- **`--plan` only reads.** It prints one line per change: `+` create, `~` update in place, `±`
  replace, `✓` already right, `✗` blocking. A blocking line makes the run exit 1 and `--apply`
  refuse to change anything.
- **`--apply` makes exactly the plan's changes**, then reads the account again and fails unless a
  second plan is empty. Running it twice in a row changes nothing.
- **`stripe:check` only reads.** It exits 0 only when the setup plan would be empty. Its `key: value`
  lines (`--json` for one JSON object) are what EA-8's evidence strings cite: mode, account id and
  country, `charges_enabled`, `payouts_enabled`, the tax settings status and head office, each
  product's tax code, each price's tax behaviour, the portal settings and headline, the payment
  methods the default configuration turns on (`payment_methods.on`) and those Stripe can offer at
  checkout now (`payment_methods.available`), and every webhook endpoint with whether its events
  match the handler's.
- **Without `--webhook-url`** the endpoint is not planned. `stripe:check` still lists every endpoint.

### What the script manages

| Object | Desired state | How a difference is fixed |
|---|---|---|
| Products Alethia Pro, runner minutes, AI Plus, AI Max (found by `metadata.alethia`) | name, and tax code `txcd_10103001` (SaaS, business use) | updated in place |
| Prices `alethia_pro_monthly`, `alethia_runner_minutes_pro`, `alethia_ai_plus_monthly`, `alethia_ai_max_monthly` (found by lookup key) | the planned amounts in `@repo/plan-catalog`, USD with an EUR option, no discount, `tax_behavior: exclusive` | **replaced**: a price cannot change, so a new price takes the lookup key and the old one is archived. Existing subscriptions keep the old price |
| Billing meter `alethia_runner_minutes` | sum, by `stripe_customer_id` | created if missing; a meter with other settings is blocking (meters cannot change) |
| Tax settings | head office from `LEGAL_ENTITY` (Sofia, BG), default tax code `txcd_10103001`, default behaviour `exclusive` | updated. This does **not** turn on Stripe Tax; that is `STRIPE_TAX_ENABLED` and a dashboard decision (§3) |
| The **default** Customer Portal configuration | customers can change their email only: **no tax-ID edit, no address and so no country change**; no plan change (it would skip the console's purchase gate); cancel at period end; payment method update on; Stripe invoice history **off**; business profile: headline "Alethia: manage your subscription and payment method", privacy link `https://alethialabs.io/privacy`, terms link `https://alethialabs.io/terms` | updated. If the account has no default configuration yet, the plan is blocking: open Settings → Billing → Customer portal in that mode, press Save once, and run again |
| The **default** payment method configuration (`DESIRED_PAYMENT_METHODS`) | **card, Apple Pay, Google Pay and Link on; every other method the account offers off** (SEPA Direct Debit, Bancontact, iDEAL, Klarna, and the rest). Every offered method gets an explicit preference, so none follows Stripe's default | the drifted methods' display preferences are updated, and only those. A desired method the account does not offer at all is blocking: activate it under Settings → Payments → Payment methods. `payment_methods.available` can still lack Apple Pay until the payment domain is registered; that is not a preference and the script does not report it as drift |
| Webhook endpoint at `--webhook-url` | exactly the events `lib/billing/webhook-handler.ts` handles, enabled | created, or its events set to exactly that list (a stray event such as `payment_intent.succeeded` is dropped). Two endpoints at one URL is blocking |

The event list is `WEBHOOK_EVENTS` in `stripe-setup.ts`. A unit test fails when it differs from the
handler's `case` labels, so adding an event to the handler means adding it there too.

### The webhook signing secret is never printed

Stripe returns an endpoint's signing secret only when the endpoint is created. `--apply` writes it to
`~/.alethia/stripe/webhook-secret.<mode>.<account id>` with mode 0600 and prints only that path.

- Put it where it belongs **without printing it**: `STRIPE_WEBHOOK_SECRET` in `alethia/prod/env` for
  live, or the GitHub secret for test (`gh secret set STRIPE_TEST_WEBHOOK_SECRET < <path>`).
- Then delete the file.
- An endpoint that already exists keeps its secret, and the script cannot read it. To get a new one,
  roll it in the dashboard (Developers → Webhooks → the endpoint → Roll secret) and store it the same
  way.

### After a test-mode apply that replaced a price

The release gate reads the test price ids from repository variables (`STRIPE_TEST_PRICE_TEAM`,
`STRIPE_TEST_PRICE_METER_TEAM`, `STRIPE_TEST_PRICE_AI_PLUS`, `STRIPE_TEST_PRICE_AI_MAX`;
`.github/workflows/release-gate.yml`). An archived price cannot start a new subscription, so after a
`±` line set each replaced id from the printed block:

```sh
gh variable set STRIPE_TEST_PRICE_TEAM --body price_…
```

Price ids are not secrets.

## 2. Values for the production env (`alethia/prod/env`)

After the live apply, these are written into the vault and the console is redeployed (an ops step,
done when instructed):

| Key | Value |
|-----|-------|
| `ALETHIA_DEPLOYMENT_MODE` | `hosted` |
| `STRIPE_SECRET_KEY` | the live key, from the `stripe-live` profile |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `pk_live_…` (not a secret) |
| `STRIPE_WEBHOOK_SECRET` | from the 0600 file (§1) |
| `STRIPE_PRICE_TEAM`, `STRIPE_PRICE_METER_TEAM`, `STRIPE_PRICE_AI_PLUS`, `STRIPE_PRICE_AI_MAX` | from the apply's printed block |
| `STRIPE_TAX_ENABLED` | unset: Stripe Tax stays off (maintainer, 2026-11-23; §3) |

Hosted production sends email through AWS SES from the `alethia-email` account
(`EMAIL_PROVIDER=ses`, the `ALETHIA_SES_*` keys; `infra/email-ses-account/README.md`).

## 3. Dashboard-only steps (no API)

The script cannot do these. Stripe's API cannot change your **own** account: `POST /v1/accounts/:id`
updates connected accounts only, and its reference says "To update your own account, use the
Dashboard". So branding, public details, the statement descriptor, customer emails, retries, Radar
rules and the account's default invoice footer are set by hand, in **each** mode (test and live are
separate). They are the maintainer's.

1. **Activate the account** as legal representative of ALETHIA LABS (EIK 208913663): business
   details, identity verification and a EUR bank account.
2. **Save the Customer Portal settings once** if `--plan` reports no default configuration (§1), and
   open Settings → Payments → Payment methods once if it reports no default payment method
   configuration.
3. **Stripe Tax stays off** (maintainer, 2026-11-23). Leave `STRIPE_TAX_ENABLED` unset. The head
   office in Settings → Tax is managed by the script and stays as it is.

### The dashboard-only checklist

Set each value exactly. Paths are the dashboard's menu names; the URL follows in brackets.

| Area | Dashboard path | Setting | Value |
|---|---|---|---|
| Branding | Settings → Business → Branding (`dashboard.stripe.com/settings/branding`) | Icon | PNG export of `apps/marketing/public/brand/alethia-app-icon.svg`, square, at least 128 × 128 px |
| | | Logo | PNG export of `apps/marketing/public/brand/alethia-lockup-black.svg` |
| | | Brand colour | `#fafafa` (light background, `RAMP_THEME.light.background` in `packages/brand/src/ramp-srgb.ts`) |
| | | Accent colour | `#171717` (ink, `RAMP_THEME.light.ink`: the console's `--primary`) |
| Public business details | Settings → Business → Business details (`dashboard.stripe.com/settings/business-details`) | Statement descriptor | `ALETHIA LABS` |
| | | Shortened descriptor | `ALETHIA` |
| | Settings → Business → Public details (`dashboard.stripe.com/settings/public`) | Support email | `support@alethialabs.io` |
| | | Business website and support website | `https://alethialabs.io` |
| | | Privacy policy | `https://alethialabs.io/privacy` |
| | | Terms of service | `https://alethialabs.io/terms` |
| Invoice footer | Settings → Billing → Invoices (`dashboard.stripe.com/settings/billing/invoice`) | Default footer | `This is a payment receipt, not a tax invoice. Your фактура is issued by Alethia Labs and is available in your billing settings.` (the console also sets it on every customer it creates, `lib/billing/receipt-footer.ts`; this default covers customers created before that) |
| Customer emails: Stripe's receipts | Settings → Business → Customer emails (`dashboard.stripe.com/settings/emails`), under Payments | Successful payments | **Off**. The console sends its own receipt with the фактура attached |
| | | Refunds | **On** for now. The console does not send a refund email yet; turn it off when it does |
| Customer emails: Stripe's invoices | Settings → Billing → Subscriptions and emails (`dashboard.stripe.com/settings/billing/automatic`), under Manage invoices sent to customers | Send finalized invoices to customers | **Off**. Stripe's invoice is not the invoice of record |
| | | Send credit notes to customers | **Off**, for the same reason |
| | | Send reminders if a recurring invoice hasn't been paid | **Off**. It links Stripe's hosted invoice |
| Customer emails: payment recovery | Billing → Revenue recovery → Emails (`dashboard.stripe.com/revenue_recovery/emails`) | Send emails when card payments fail | **Off**. The console sends its own failed-payment email (`sendPaymentFailedEmail`), and withholds it on purpose while a payment hold is open; Stripe's would contradict that |
| | | Send emails about expiring cards | **On**. The console does not send one |
| | | Send a Stripe-hosted link for customers to confirm their payments when required (3D Secure) | **On**, with its reminders. The console does not handle `invoice.payment_action_required` |
| | | Send emails about upcoming renewals | **On**, if offered. The console does not send one |
| Smart Retries | Billing → Revenue recovery → Retries (`dashboard.stripe.com/revenue_recovery/retries`) | Smart Retries | **On** (Stripe's recommended schedule) |
| | | If all retries for a payment fail | **Cancel the subscription** |
| Radar | Radar → Rules (`dashboard.stripe.com/radar/rules`) | Block if CVC verification fails (or "… based on risk score" where the account shows only the newer rules) | **Enabled** |
| | | Block if postal code verification fails (or "… based on risk score") | **Enabled** |

What the console sends itself, so Stripe's copy stays off: the receipt with the фактура
(`sendReceiptEmail`), the failed-payment email, the trial-ending and trial-ended emails, the
cancellation email, and the payment-hold emails (`lib/email/billing-email.ts`, sent from
`lib/billing/webhook-handler.ts`).

### Stripe's PDF is not the invoice of record

The invoice of record is the фактура the console issues itself from Stripe's paid invoice
(`lib/billing/factura/issue.ts`): a ten-digit number from a gap-free series, and the Art. 114 ЗДДС
fields, rendered to PDF from an immutable snapshot. Stripe's invoice and its PDF are payment records only. That is
why the portal does not show Stripe's invoice history, why Stripe's invoice emails are off at
go-live, and why every Stripe invoice carries the footer "This is a payment receipt, not a tax
invoice." (set on each customer the console creates, and as the account default above).

## 4. Smoke test on live

- Subscribe a real organisation in an open cell, then confirm:
  - the webhook shows **200** (Developers → Webhooks → the endpoint);
  - `organization_billing` is `active` and a `stripe_webhook_event` row is `done`;
  - a `factura` row exists with a ten-digit number and a stored PDF, the `invoice` row reads
    `factura_status = 'issued'`, and the customer receives Alethia's email with the фактура attached,
    and no email from Stripe.
- Trigger a failed renewal with a declining card and confirm the dunning email.
- Run `stripe:check -- --live --webhook-url=…` and keep its output as the evidence.

## 5. Customer emails

Alethia sends the receipt, the failed-payment email, the trial emails and the cancellation email
through the transactional provider. Stripe's copies of those stay off; the emails the console does
not send (expiring card, 3D Secure confirmation, refunds, upcoming renewal) stay on in Stripe (§3,
the checklist). The `stripe_webhook_event` ledger makes each email go out once per event, even when
Stripe retries.

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
- If Alethia's email path fails, fix it; do not turn Stripe's invoice emails back on. They would send
  the customer a second document titled "invoice" with a different number from the фактура.
- A wrong catalog change is undone by the script, not by hand: fix the desired state in
  `stripe-setup.ts` or `@repo/plan-catalog`, then `--plan` and `--apply` again. An archived price stays
  archived; the replacement takes its lookup key.
- The webhook is fail-safe: an email error never fails the webhook (state still syncs); a handler
  error returns 500 so Stripe retries, and the event-log makes retries exactly-once.
