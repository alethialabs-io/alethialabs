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
  existing runtime user.
- **AWS-only** — this stack does **not** manage DNS (set the records once with any DNS
  provider, see below) and does **not** receive mail (send-only; no receipt rules).

## State backend

OpenTofu state lives in **AWS S3** (`alethia-tofu-state-270587882865`, eu-central-1,
versioned/encrypted/private) in the same account, so the deploy role / your admin creds
authenticate the backend natively — **no static state keys**. Copy `backend.hcl.example`
→ `backend.hcl` (gitignored), then `tofu init -backend-config=backend.hcl`.

## 0. Bootstrap once (admin)

The `bootstrap/` stack creates the GitHub-OIDC **deploy role** (`alethia-ses-deployer`,
no `iam:*` for itself), the state bucket, and the scoped send policy on
`alethia-ses-sender`. Apply it once with an **admin/root identity** for `270587882865`:

```bash
cd bootstrap
cp backend.hcl.example backend.hcl
tofu init -backend-config=backend.hcl
tofu apply
tofu output -raw deployer_role_arn
```

Set that ARN as the repo **Actions variable** `SES_DEPLOYER_ROLE_ARN` (not a secret) so CI
can assume it via OIDC. To run the main stack locally, add your admin ARN to
`admin_principal_arns` and assume the role, or just use admin creds directly.

## 1. DNS records (set once, any provider — NOT managed here)

SES needs these records on `alethialabs.io`. Get the exact values from
`aws sesv2 get-email-identity --region eu-central-1 --email-identity auth.alethialabs.io`
(and `mail.…`). Per sending subdomain (`auth`, `mail`):

| Record | Host | Type | Value |
| --- | --- | --- | --- |
| DKIM ×3 | `<token>._domainkey.<sub>` | CNAME | `<token>.dkim.amazonses.com` |
| MAIL FROM | `bounce.<sub>` | MX (10) | `feedback-smtp.eu-central-1.amazonses.com` |
| MAIL FROM SPF | `bounce.<sub>` | TXT | `v=spf1 include:amazonses.com ~all` |

Once for the root domain: `_dmarc` TXT `v=DMARC1; p=none; rua=mailto:dmarc@alethialabs.io; fo=1`.
(For alethialabs.io these are already live in Cloudflare; this stack intentionally does not
manage them so it stays AWS-only and OSS-friendly.)

**Apex send-as identity:** the `alethialabs.io` apex identity (for Gmail "Send mail as",
§6) also needs its **3 DKIM CNAMEs** — `<token>._domainkey` on the apex, value
`<token>.dkim.amazonses.com`, from `tofu output -json dkim_tokens_apex`. This gives
`d=alethialabs.io` DKIM so replies from `support@`/`sales@`/… pass DMARC.

## 2. Apply the main stack

The SES identities / config sets are already applied for alethialabs.io. For a fresh
environment, import any pre-existing SES identities so the first plan is additive:

```bash
cp backend.hcl.example backend.hcl
tofu init -backend-config=backend.hcl
# only if the identities already exist:
tofu import 'aws_sesv2_email_identity.stream["auth"]'    auth.alethialabs.io
tofu import 'aws_sesv2_email_identity.stream["general"]' mail.alethialabs.io
tofu import 'aws_sesv2_email_identity_mail_from_attributes.stream["auth"]'    auth.alethialabs.io
tofu import 'aws_sesv2_email_identity_mail_from_attributes.stream["general"]' mail.alethialabs.io

tofu plan -var events_webhook_url=""   # webhook deferred until the console route is live
tofu apply -var events_webhook_url=""
```

## 3. Wire the app

Set in the deployed console's runtime env (so sends are tagged → events flow):

```bash
ALETHIA_SES_AUTH_CONFIG_SET=alethia-auth
ALETHIA_SES_GENERAL_CONFIG_SET=alethia-general
```

Deploy the console (with the `/api/webhooks/ses` route), then drop the
`-var events_webhook_url=""` and re-apply so SNS creates + auto-confirms the HTTPS
subscription (it can only confirm once that endpoint is live).

## 4. Leave the SES sandbox (one-time, not Terraform)

```bash
aws sesv2 put-account-details --region eu-central-1 \
  --production-access-enabled \
  --mail-type TRANSACTIONAL \
  --website-url https://alethialabs.io \
  --use-case-description "Transactional email for the Alethia control plane: sign-in codes, email verification, org invites, and operational alerts. No marketing/bulk." \
  --additional-contact-email-addresses borislav@alethialabs.io \
  --contact-language EN
```

AWS reviews in ~24h. Until then sending is sandbox-limited to verified addresses + the simulator.

## 5. Verify

**One shot:** `./verify.sh` (after `apply`, or pass `SES_EVENTS_TOPIC_ARN=…`). It checks DKIM,
sends a real message (asserts a MessageId), then sends a simulator bounce + complaint and asserts
both land on the events topic — captured via a throwaway SQS queue, so it does not need the console
webhook deployed. Run it as the **deploy role** (its policy grants the send + SNS-subscribe + SQS
perms verify needs); admin creds work too.

## 6. SMTP credentials for Gmail "Send mail as" (reply *as* the addresses)

Inbound to `support@`/`sales@`/… is handled by Cloudflare Email Routing
(`infra/cp-hetzner/email-routing.tf`). To *reply as* them, add them in Gmail as
"Send mail as" aliases that relay through **SES SMTP** — automated by
[`scripts/gmail-inbox/`](../../scripts/gmail-inbox/README.md). SMTP needs a username +
password minted from the least-priv `alethia-ses-smtp-gmail` IAM user (created by
`bootstrap/`, scoped to `ses:SendRawEmail` on the apex identity):

```bash
# SMTP username = the access key id; keep the secret to derive the password.
aws iam create-access-key --user-name alethia-ses-smtp-gmail

# SES SMTP password = HMAC of the secret key (region-specific). Node one-liner:
SECRET='<SecretAccessKey>' node -e '
  const {createHmac}=require("crypto");
  const sign=(k,m)=>createHmac("sha256",k).update(m,"utf8").digest();
  let s=sign("AWS4"+process.env.SECRET,"11111111");
  for (const p of ["eu-central-1","ses","aws4_request","SendRawEmail"]) s=sign(s,p);
  console.log(Buffer.concat([Buffer.from([0x04]),s]).toString("base64"));'
```

Then set `SES_SMTP_USER` (the `AccessKeyId`) + `SES_SMTP_PASSWORD` (the printed value) for
the Gmail script. Host/port are `email-smtp.eu-central-1.amazonaws.com:587` (STARTTLS).
Requires production access (§4) to email arbitrary recipients. (Console shortcut: SES →
*SMTP settings* → *Create SMTP credentials* also works, but mints its own broadly-scoped
IAM user rather than reusing the least-priv one above.)

## CI

`.github/workflows/infra-email-ses.yml`: PRs run `tofu validate` (no creds); pushes to `main` assume
the deploy role via **GitHub OIDC** (`id-token: write`) and apply — **no stored AWS keys, no state
keys** (S3 backend in-account). Config: just the Actions **variable** `SES_DEPLOYER_ROLE_ARN`
(= the bootstrap `deployer_role_arn`). The deploy role trusts `alethialabs-io/alethialabs@main` —
change `github_repo` / `github_branch` in the bootstrap stack if that moves.
