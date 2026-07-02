<!--
SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Gmail shared-inbox setup (alethialabs.io)

One-off, idempotent script that wires the `alethialabs.io` addresses into a Gmail
account: **labels**, **filters** (label per address + never-spam), and **"Send mail
as"** aliases that relay through **SES SMTP** so replies go out *as*
`support@alethialabs.io` etc.

It's the Gmail half of the email setup. The other halves:

- **Inbound** — `infra/cp-hetzner/email-routing.tf` (Cloudflare Email Routing) forwards
  `support@/sales@/legal@/security@/feedback@/dmarc@/borislav@` → this Gmail.
- **Outbound identity** — `infra/email-ses` (apex `alethialabs.io` SES identity + the
  `alethia-ses-smtp-gmail` IAM user) makes the SMTP relay possible.

This folder is intentionally **outside** the pnpm workspace (own `package.json`,
own `node_modules`) so `googleapis` never touches the monorepo.

## Prerequisites

1. **Inbound must work first** — apply `infra/cp-hetzner`, then verify the destination
   address in the email Cloudflare sends. Otherwise the alias-verification emails below
   never arrive.
2. **SES SMTP credentials** — mint them once from the `alethia-ses-smtp-gmail` IAM user
   (created by `infra/email-ses/bootstrap`). See `infra/email-ses/README.md` §6. Export:
   ```bash
   export SES_SMTP_USER=AKIA...              # SMTP username
   export SES_SMTP_PASSWORD='...'            # SMTP password (HMAC of the secret key)
   # host/port default to email-smtp.eu-central-1.amazonaws.com:587
   ```
   Requires the SES account to be **out of the sandbox** to email arbitrary recipients.
3. **OAuth client** — in Google Cloud Console → APIs & Services:
   - Enable the **Gmail API**.
   - Create an **OAuth client ID** of type **Desktop app**, download it as
     **`credentials.json`** into this folder (gitignored).
   - Add your Gmail address as a **test user** on the OAuth consent screen.

## Run

```bash
cd scripts/gmail-inbox
npm install
node setup.mjs
```

A browser opens for consent (scopes `gmail.settings.basic` + `gmail.settings.sharing`);
the token is cached in `token.json` (gitignored). The script prints what it creates vs.
skips. Re-run any time — it's idempotent.

## Finish

Each new send-as alias triggers a **"Gmail Confirmation"** email that routes back through
Cloudflare into this inbox. **Click the link in each** to activate the alias. After that,
Gmail's compose `From:` dropdown offers each `@alethialabs.io` address, sent via SES.

## Manual fallback (no script)

Everything here can be done by hand: Gmail → Settings → **Filters and Blocked Addresses**
(filters + labels) and **Accounts and Import → Send mail as** (add each address with the
SES SMTP server, port 587, TLS).
