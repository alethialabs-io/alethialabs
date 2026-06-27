<!--
SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# infra/email-ses

Production AWS SES for **alethialabs.io** transactional email — codified.

- **Account:** `270587882865` · **Region:** `eu-central-1`
- Two reputation-isolated sending subdomains: `auth.alethialabs.io` (auth/security,
  `AUTH_EMAIL_FROM`) and `mail.alethialabs.io` (product/general, `EMAIL_FROM`).
- Per stream: SES domain identity + Easy DKIM + custom MAIL FROM (`bounce.<sub>`) +
  configuration set → **SNS events** → the console `/api/webhooks/ses` handler → the
  `email_suppression` table.
- Account VDM, two reputation CloudWatch alarms, a least-privilege send policy on the
  existing runtime user, and Cloudflare DNS as source of truth.
- **Send-only** — no inbound (receipt rules / S3 spool).

## Prerequisites

- **One-time bootstrap** (`./bootstrap`) applied by an **admin/root identity** in account
  `270587882865`. It creates the GitHub-OIDC **deploy role** (`alethia-ses-deployer`) + its
  least-privilege policy + the scoped send policy on `alethia-ses-sender`. This is the **only**
  step that needs admin — everything below runs as the deploy role, which has **no `iam:*`**.
- Cloudflare API token with DNS edit on the `alethialabs.io` zone + the zone id.
- The S3-compatible state backend creds (`TF_STATE_S3_*`, as in `infra/cp-aws`).

## 0. Bootstrap once (admin)

```bash
cd bootstrap
# admin creds for 270587882865 in env, plus TF_STATE_S3_* for the backend
tofu init -backend-config=backend.hcl
tofu apply                 # OIDC provider + alethia-ses-deployer role + send policy
tofu output -raw deployer_role_arn
```

Set that ARN as the repo **Actions variable** `SES_DEPLOYER_ROLE_ARN` (it's not a secret) so CI
can assume it via OIDC — no AWS keys are stored anywhere. To run the steps below locally, add your
admin ARN to `admin_principal_arns` and assume the deploy role, or just use admin creds directly.

> The Cloudflare token shared during setup was sent in plaintext — **rotate it**.

Local creds for the main stack go in a gitignored `infra/email-ses/.env`:

```bash
# infra/email-ses/.env  (gitignored)
export AWS_ACCESS_KEY_ID=...            # assumed alethia-ses-deployer (or admin)
export AWS_SECRET_ACCESS_KEY=...
export AWS_SESSION_TOKEN=...            # when assuming the role
export TF_VAR_cloudflare_api_token=...
export TF_VAR_cloudflare_zone_id=...
```

## 1. Inventory live state first (verify-at-apply)

The DNS / identities may already exist (set up by hand). Check before applying so the
plan is additive, not a replace:

```bash
source .env
aws sesv2 get-account --region eu-central-1
aws sesv2 list-email-identities --region eu-central-1
aws sesv2 get-email-identity --region eu-central-1 --email-identity auth.alethialabs.io
aws sesv2 list-configuration-sets --region eu-central-1
```

## 2. Init + import what exists

```bash
tofu init -backend-config=backend.hcl
```

Import any pre-existing resources so the first `plan` shows only additions. The
import ids:

```bash
# SES identities + MAIL FROM (id = the domain)
tofu import 'aws_sesv2_email_identity.stream["auth"]'    auth.alethialabs.io
tofu import 'aws_sesv2_email_identity.stream["general"]' mail.alethialabs.io
tofu import 'aws_sesv2_email_identity_mail_from_attributes.stream["auth"]'    auth.alethialabs.io
tofu import 'aws_sesv2_email_identity_mail_from_attributes.stream["general"]' mail.alethialabs.io

# Existing Cloudflare records (id = "<zone_id>/<record_id>"; get record ids from the
# Cloudflare dashboard or API). DKIM keys are "<stream>-0|1|2", e.g.:
tofu import 'cloudflare_record.dkim["auth-0"]'      <zone_id>/<record_id>
tofu import 'cloudflare_record.mail_from_mx["auth"]'  <zone_id>/<record_id>
tofu import 'cloudflare_record.mail_from_spf["auth"]' <zone_id>/<record_id>
tofu import 'cloudflare_record.dmarc'                 <zone_id>/<record_id>
```

Then:

```bash
tofu plan   # expect only additive changes (config sets, SNS, VDM, alarms)
tofu apply
```

## 3. Wire the app

From `tofu output`:

```bash
ALETHIA_SES_AUTH_CONFIG_SET=alethia-auth
ALETHIA_SES_GENERAL_CONFIG_SET=alethia-general
```

Deploy the console (with the `/api/webhooks/ses` route), then set
`events_webhook_url = "https://alethialabs.io/api/webhooks/ses"` and re-apply so SNS
creates + auto-confirms the HTTPS subscription.

## 4. Leave the SES sandbox (one-time, not Terraform)

```bash
aws sesv2 put-account-details --region eu-central-1 \
  --production-access-enabled \
  --mail-type TRANSACTIONAL \
  --website-url https://alethialabs.io \
  --use-case-description "Transactional email for the Alethia control plane: sign-in codes, email verification, org invites, and operational alerts. No marketing/bulk." \
  --additional-contact-email-addresses ops@alethialabs.io \
  --contact-language EN
```

AWS reviews in ~24h. Until then sending is sandbox-limited to verified addresses.

## 5. Verify

**One shot:** `./verify.sh` (run from this dir after `apply`, or pass
`SES_EVENTS_TOPIC_ARN=…`). It checks DKIM, sends a real message (asserts a
MessageId), then sends a simulator bounce + complaint and asserts both land on
the events topic — captured via a throwaway SQS queue, so it does not need the
console webhook deployed. Run it as the **deploy role** (its policy already grants
the send + SNS-subscribe + SQS perms verify needs); admin creds work too.

The individual commands, if you want to run them by hand:

```bash
# DKIM verified + sending enabled
aws sesv2 get-email-identity --region eu-central-1 --email-identity auth.alethialabs.io \
  --query '{Dkim:DkimAttributes.Status,Verified:VerifiedForSendingStatus}'

# Send through a config set → MessageId
aws sesv2 send-email --region eu-central-1 \
  --from-email-address "Alethia <no-reply@auth.alethialabs.io>" \
  --destination 'ToAddresses=success@simulator.amazonses.com' \
  --configuration-set-name alethia-auth \
  --content 'Simple={Subject={Data=ses test,Charset=UTF-8},Body={Text={Data=hello,Charset=UTF-8}}}'

# Bounce + complaint → events land on SNS → a row appears in email_suppression
#   to: bounce@simulator.amazonses.com / complaint@simulator.amazonses.com
# (the SES simulator does NOT touch SES's own suppression list — assert via the
#  app's SNS→webhook→DB path.)
```

## CI

`.github/workflows/infra-email-ses.yml`: PRs run `tofu validate` (no creds);
pushes to `main` assume the deploy role via **GitHub OIDC** (`id-token: write`) and
apply — **no stored AWS keys**. Config:

- Actions **variable** `SES_DEPLOYER_ROLE_ARN` = the bootstrap `deployer_role_arn`.
- Secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ZONE_ID` (DNS) and `TF_STATE_S3_*`
  (state backend).

The deploy role trusts `bobikenobi12/bb-thesis-2026@main` — change `github_repo` /
`github_branch` in the bootstrap stack if that moves.
