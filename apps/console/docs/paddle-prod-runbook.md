# Paddle runbook: catalog as code, and the dashboard settings that have no API

> **Live sales stay closed until the go-live switch** (`MOR_MARKETS`, Paddle Billing plan). Running
> these commands against the live account prepares it. It does not open a market.

Paddle's sandbox and live environments are **separate accounts with separate keys**. Both are set up
by `apps/console/scripts/paddle-setup.ts` and checked by the read-only
`apps/console/scripts/paddle-check.ts`. The key reaches them only through the credential broker
(`pnpm creds`), as `PADDLE_API_KEY`. It is never printed.

| Profile | Holds | Store it with |
|---|---|---|
| `paddle-sandbox` | a sandbox API key (`pdl_sdbx_apikey_…`) | `! pnpm creds --set paddle-sandbox` |
| `paddle-live` | a live API key (`pdl_live_apikey_…`) | `! pnpm creds --set paddle-live` |

The key needs read and write on products, prices and notification settings, and on client-side
tokens (`client_token.read`, `client_token.write`) when `--client-token` is given. The environment comes
from the key's prefix: a key with any other prefix is refused, and a live key is refused unless
`--live` is given.

---

## 1. Plan, apply, check

Every run prints its target first, as `→ Paddle SANDBOX · https://sandbox-api.paddle.com`. Read
that line before anything else.

```sh
# Sandbox
pnpm creds paddle-sandbox -- pnpm -C apps/console run paddle:setup -- --plan --client-token
pnpm creds paddle-sandbox -- pnpm -C apps/console run paddle:setup -- --apply --client-token
pnpm creds paddle-sandbox -- pnpm -C apps/console run paddle:check -- --client-token

# Live: every command needs --live. The full go-live order is §3.
pnpm creds paddle-live -- pnpm -C apps/console run paddle:setup -- --live --plan \
  --webhook-url=https://alethialabs.io/api/webhooks/paddle --client-token
pnpm creds paddle-live -- pnpm -C apps/console run paddle:setup -- --live --apply \
  --webhook-url=https://alethialabs.io/api/webhooks/paddle --client-token
pnpm creds paddle-live -- pnpm -C apps/console run paddle:check -- --live \
  --webhook-url=https://alethialabs.io/api/webhooks/paddle --client-token
```

- **`--plan` only reads.** One line per change: `+` create, `~` update in place, `±` replace, `-`
  archive, `✓` already right, `✗` blocking, `!` a note (a catalog gap that does not block).
- **`--apply` makes exactly the plan's changes**, then reads the account again and fails unless a
  second plan is empty. It ends by printing the env lines below.
- **`paddle:check` only reads.** It exits 0 only when the setup plan would be empty. `--json` prints
  one JSON object.
- **Without `--webhook-url`** the notification destination is not planned.
- **Without `--client-token`** the Paddle.js client-side token is not planned (nor read, so a key
  without the `client_token` permissions still works).

### The env lines

`--apply` (and `paddle:check`, as `env:` lines) prints the values the console needs. None of them
is a secret. Put them in the target environment:

```
PADDLE_PRICE_TEAM=pri_…
PADDLE_PRICE_AI_PLUS=pri_…
PADDLE_PRICE_AI_MAX=pri_…
PADDLE_PRODUCT_AI_CREDITS=pro_…
PADDLE_PRODUCT_RUNNER_MINUTES=pro_…
NEXT_PUBLIC_PADDLE_CLIENT_TOKEN=live_…   # only with --client-token; test_… on the sandbox
```

The names are not typed by the script: it prints them from `apps/console/lib/billing/paddle/env-names.ts`,
the same definition `lib/billing/paddle/config.ts` reads, so a printed name is always a read one.
`PADDLE_PRICE_ENTERPRISE` is read too but has no catalog price (Enterprise is sold by contract).

A replaced price gets a new id, so after an apply that replaced anything, update these.

### What the script manages

| Object | Desired state | How a difference is fixed |
|---|---|---|
| Products Alethia Pro, AI Plus, AI Max, AI credits, runner minutes (found by `custom_data.alethia`) | name, `tax_category: saas` | updated in place. Two active products with one tag are blocking |
| Prices `alethia_pro_monthly`, `alethia_ai_plus_monthly`, `alethia_ai_max_monthly` (found by `custom_data.alethia_key`) | the amounts in `@repo/plan-catalog`: a USD unit price, an EUR override for `EUROZONE_COUNTRIES`, monthly, `tax_mode: account_setting`; Pro quantity 1 to 100 (seats), the AI tiers 1 | **replaced**: a new price is created with the key, then the old one is archived. The unit price is never edited, so existing subscriptions keep their price. Name and description are updated in place |
| The AI-credits and runner-minutes products | product only. Credit packs (`AI_CREDIT_PACKS`, USD) and runner overage are charged with **non-catalog** prices against them at checkout time, so they have no catalog price | — |
| Notification destination at `--webhook-url` | type `url`, subscribed to exactly `PADDLE_WEBHOOK_EVENTS`, active | created, or its events set to exactly that list. Two destinations at one URL are blocking |
| Client-side token, with `--client-token` | one active token named `Alethia console (Paddle.js)` | created if missing. Two active tokens with that name are blocking; revoked ones are ignored |

**Retired price keys.** Earlier versions of the script also created catalog prices
`alethia_ai_credits_s`, `_m`, `_l`. Nothing reads them. The plan reports any active price whose key
is no longer in the catalog as a `!` note and never touches it; archive those in the dashboard.

**EUR override countries** are the 21 euro-area states of 2026 (`EUROZONE_COUNTRIES` in the script).
This is narrower than `EU_COUNTRIES` in `@repo/plan-catalog`, which also bills non-euro EU states and
the EEA in EUR in the console's own currency toggle. Buyers in those countries pay USD at a Paddle
checkout.

### The transaction mirror backfill

The console keeps a local copy of each Paddle transaction (`paddle_transaction`), written by the
webhook. Transactions from before the destination existed, and transactions the webhook could not tie
to an organization, are not in it. Set `ALETHIA_PADDLE_TRANSACTION_BACKFILL=1` in the environment to
fill those gaps. The console then reads the account's billed, paid, past-due and completed
transactions once a day (read-only towards Paddle) and applies each one through the same rules as
the webhook. A credit pack read this way grants nothing. Each pass logs
`[paddle] transaction backfill pass` with its counts.

Turn it on before go-live, after `--apply` has subscribed the destination to the
`transaction.billed`, `transaction.paid` and `transaction.past_due` events.

### Tax mode: set the account default first

The prices ask for `tax_mode: account_setting`. Paddle **resolves** that when the price is created
and returns the resolved mode afterwards (on the sandbox, a new price read back `location`). A price
keeps the mode it resolved to. So set the account's tax default in the dashboard (§2) **before the
first `--apply` on live**. The plan's `✓` lines show each price's resolved mode. The script records
the requested mode in `custom_data.alethia_tax_mode`, which is what it compares.

### The endpoint secret is never printed

Paddle returns a destination's secret key when it is created. `--apply` writes it to
`~/.alethia/paddle/<environment>-<destination id>.secret`, mode 0600, in a 0700 directory, and prints
only the path. Store it as `PADDLE_WEBHOOK_SECRET` in the target environment without printing it
(for example `gh secret set <NAME> < <path>`), then delete the file.

---

## 2. Dashboard checklist: what the API cannot set

Do these by hand, in each environment. Sandbox first, then live.

- [ ] **Domain approval.** Checkout → Website approval: submit `alethialabs.io`. Paddle reviews the
      site, which must show pricing, terms, privacy and the refund policy (`/refunds`). Live checkout
      does not open until this is approved.
- [ ] **Default payment link.** Checkout → Checkout settings: set the default payment link to a page
      on an approved domain that loads Paddle.js (the console's checkout page).
- [ ] **Checkout branding.** Checkout → Checkout settings: logo, colours and font to match the Alethia
      brand.
- [ ] **Customer portal settings.** Turn **pause off** (the console does not support paused
      subscriptions as an entitlement state). Leave cancel on, at the end of the billing period.
- [ ] **Tax display: exclusive.** Business account → Tax: prices shown exclusive of tax, with the tax
      added at checkout. Do this **before** the first live `--apply` (see "Tax mode" above).
- [ ] **Payout details.** Business account → Payouts: the company's EUR bank account (Revolut).
- [ ] **Self-billing toggle.** Business account → Invoicing: decide whether Paddle issues self-billed
      invoices to Alethia, or Alethia issues its own фактура to Paddle each month (plan open question
      O3; the accountant confirms). Set the toggle to match.
- [ ] **Client-side token.** `--client-token` creates it (§1). By hand only if the key lacks the
      `client_token` permissions: Developer tools → Authentication, named
      `Alethia console (Paddle.js)` so the script recognises it. It is not secret but is per
      environment.

After the checklist, run `paddle:check` and keep its output as evidence.

---

## 3. Live go-live sequence

Run in this order, when instructed. Each step is safe to repeat. Sales stay closed until the last
step (and `MOR_MARKETS`).

1. **Dashboard first** (§2): domain approved, tax display exclusive, account tax default set. The
   tax default must precede the first live `--apply`.
2. **Plan, and read it.**

   ```sh
   pnpm creds paddle-live -- pnpm -C apps/console run paddle:setup -- --live --plan \
     --webhook-url=https://alethialabs.io/api/webhooks/paddle --client-token
   ```

   The first line must read `→ Paddle LIVE · https://api.paddle.com`. Expect only `+` lines on a new
   account, and no `✗`.
3. **Apply the same flags.**

   ```sh
   pnpm creds paddle-live -- pnpm -C apps/console run paddle:setup -- --live --apply \
     --webhook-url=https://alethialabs.io/api/webhooks/paddle --client-token
   ```

   It must end with `✓ Converged`. Keep the printed env block. The endpoint secret goes to
   `~/.alethia/paddle/live-<ntfset id>.secret`; only the path is printed.
4. **Check.**

   ```sh
   pnpm creds paddle-live -- pnpm -C apps/console run paddle:check -- --live \
     --webhook-url=https://alethialabs.io/api/webhooks/paddle --client-token
   ```

   It must exit 0 with `matches_catalog: yes`. Keep the output as evidence.
5. **Store the values in `alethia/prod/env`** (AWS Secrets Manager, the vault the deploy reads), without
   printing any secret:
   - `PADDLE_ENVIRONMENT=live`
   - `PADDLE_API_KEY`: the live key, from the `paddle-live` profile
   - `PADDLE_WEBHOOK_SECRET`: the contents of the `.secret` file from step 3; delete the file after
   - the env block from step 3 (`PADDLE_PRICE_*`, `PADDLE_PRODUCT_*`, `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN`)

   `scripts/ci/deploy-console-assemble-env.sh` carries exactly these names into the console env, and
   the console refuses a config whose key prefix, `PADDLE_ENVIRONMENT` and client-token prefix
   disagree.
6. **Switch new sales to Paddle**: set `BILLING_PROVIDER=paddle` in `alethia/prod/env` and redeploy
   the console. Existing Stripe subscriptions keep following their own row.

Do not run steps 3 onwards without step 2's plan having been read.
