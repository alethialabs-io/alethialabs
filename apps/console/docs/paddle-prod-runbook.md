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

The key needs read and write on products, prices and notification settings. The environment comes
from the key's prefix: a key with any other prefix is refused, and a live key is refused unless
`--live` is given.

---

## 1. Plan, apply, check

Every run prints its target first, as `→ Paddle SANDBOX · https://sandbox-api.paddle.com`. Read
that line before anything else.

```sh
# Sandbox
pnpm creds paddle-sandbox -- pnpm -C apps/console run paddle:setup -- --plan
pnpm creds paddle-sandbox -- pnpm -C apps/console run paddle:setup -- --apply
pnpm creds paddle-sandbox -- pnpm -C apps/console run paddle:check

# Live: every command needs --live
pnpm creds paddle-live -- pnpm -C apps/console run paddle:setup -- --live --plan \
  --webhook-url=https://alethialabs.io/api/webhooks/paddle
pnpm creds paddle-live -- pnpm -C apps/console run paddle:setup -- --live --apply \
  --webhook-url=https://alethialabs.io/api/webhooks/paddle
pnpm creds paddle-live -- pnpm -C apps/console run paddle:check -- --live \
  --webhook-url=https://alethialabs.io/api/webhooks/paddle
```

- **`--plan` only reads.** One line per change: `+` create, `~` update in place, `±` replace, `-`
  archive, `✓` already right, `✗` blocking, `!` a note (a catalog gap that does not block).
- **`--apply` makes exactly the plan's changes**, then reads the account again and fails unless a
  second plan is empty. It ends by printing the env lines below.
- **`paddle:check` only reads.** It exits 0 only when the setup plan would be empty. `--json` prints
  one JSON object.
- **Without `--webhook-url`** the notification destination is not planned.

### The env lines

`--apply` (and `paddle:check`, as `env:` lines) prints the ids the console needs. They are not
secrets. Put them in the target environment:

```
PADDLE_PRICE_PRO=pri_…
PADDLE_PRICE_AI_PLUS=pri_…
PADDLE_PRICE_AI_MAX=pri_…
PADDLE_PRICE_CREDITS_S=pri_…
PADDLE_PRICE_CREDITS_M=pri_…
PADDLE_PRICE_CREDITS_L=pri_…
PADDLE_PRODUCT_RUNNER_MINUTES=pro_…
```

A replaced price gets a new id, so after an apply that replaced anything, update these.

### What the script manages

| Object | Desired state | How a difference is fixed |
|---|---|---|
| Products Alethia Pro, AI Plus, AI Max, AI credits, runner minutes (found by `custom_data.alethia`) | name, `tax_category: saas` | updated in place. Two active products with one tag are blocking |
| Prices `alethia_pro_monthly`, `alethia_ai_plus_monthly`, `alethia_ai_max_monthly` (found by `custom_data.alethia_key`) | the amounts in `@repo/plan-catalog`: a USD unit price, an EUR override for `EUROZONE_COUNTRIES`, monthly, `tax_mode: account_setting`; Pro quantity 1 to 100 (seats), the AI tiers 1 | **replaced**: a new price is created with the key, then the old one is archived. The unit price is never edited, so existing subscriptions keep their price. Name and description are updated in place |
| Prices `alethia_ai_credits_s`, `_m`, `_l` | the amounts in `AI_CREDIT_PACKS` (`lib/billing/ai-credits.ts`), one-time, quantity 1 | as above |
| The runner-minutes product | product only. Overage is charged with non-catalog prices against it | — |
| Notification destination at `--webhook-url` | type `url`, subscribed to exactly `PADDLE_WEBHOOK_EVENTS`, active | created, or its events set to exactly that list. Two destinations at one URL are blocking |

**Known gap:** `AI_CREDIT_PACKS` has USD amounts only, so the credit packs are USD everywhere, with
no EUR override. The plan prints this as a `!` note. Adding EUR amounts to the packs and re-running
`--apply` replaces the three pack prices.

**EUR override countries** are the 21 euro-area states of 2026 (`EUROZONE_COUNTRIES` in the script).
This is narrower than `EU_COUNTRIES` in `@repo/plan-catalog`, which also bills non-euro EU states and
the EEA in EUR in the console's own currency toggle. Buyers in those countries pay USD at a Paddle
checkout.

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
- [ ] **Client-side token.** Developer tools → Authentication: create a client-side token for
      Paddle.js. It is not secret but is per environment.

After the checklist, run `paddle:check` and keep its output as evidence.
