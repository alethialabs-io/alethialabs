<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# email-ses-account

Hosted transactional email through AWS SES, from a dedicated AWS account: **`alethia-email`
(604925221417)**, `eu-central-1`. It is a member of the same AWS Organization as the Alethia platform
account (270587882865).

AWS denied SES production access in the platform account, so `infra/email-ses` was never used by
hosted prod, and prod sends through Resend. The `alethia-email` account has production access
(50,000 messages a day, 14 a second). The domain identity `alethialabs.io` is verified there with
Easy DKIM, and the account-level suppression list covers bounces and complaints. That was done by
hand. This stack adds everything else the app needs to send through it.

| File | What |
|---|---|
| `bootstrap/` | One role, `alethia-email-admin`, which the main stack applies through. Applied **once** with the organization's management-account credentials, because only that account can assume `OrganizationAccountAccessRole`. The same shape as `infra/aws-e2e/bootstrap`. |
| `provider.tf` | Assumes `alethia-email-admin`. `allowed_account_ids = [email_account_id]`, so the provider refuses to run in any other account. |
| `identity.tf` | **Reads** the existing `alethialabs.io` identity. The plan fails if it is missing, not a domain, or not verified for sending. |
| `config-sets.tf` | `alethia-auth` and `alethia-general`, each sending BOUNCE, COMPLAINT, DELIVERY, REJECT and RENDERING_FAILURE events to SNS. The same names and event types as `infra/email-ses`. |
| `sns.tf`, `kms.tf` | `alethia-ses-events`, with an HTTPS subscription to `https://alethialabs.io/api/webhooks/ses`. `alethia-ses-alarms`, with one email subscription per address. Both are encrypted with one customer-managed KMS key. |
| `cloudwatch.tf` | The bounce-rate (0.05) and complaint-rate (0.001) alarms, as `infra/email-ses`. |
| `account.tf` | Account VDM, as `infra/email-ses`, and the account suppression list (BOUNCE + COMPLAINT). The suppression list is already set; this records it. |
| `sender.tf` | `alethia-ses-sender`: an IAM user that may only `ses:SendEmail` / `ses:SendRawEmail` as the identity and through the two configuration sets. **Its access key is not created here.** |
| `checks.tf` / `checks.tftest.hcl` | Invariants, and a credential-free test that the committed posture plans as claimed and that each refusal fires. CI runs it in `.github/workflows/infra-email-ses-account.yml`. |

## Design decisions

**A new stack, not a re-targeting of `infra/email-ses`.** That stack's state
(`ses/terraform.tfstate`) describes resources in the platform account. If its provider pointed at the
email account, the next plan would find none of them, plan to create them again in the new account,
and stop tracking the old ones without deleting them. It also has an apply job that runs on every
push to `main` that touches `infra/email-ses/**`, as `alethia-ses-deployer` in the platform account.
This stack creates IAM, so, like `infra/aws-e2e`, it is applied by hand and CI only validates it.
`infra/email-ses` is left exactly as it is. Its retirement is a separate PR (see "Not done here").

**Account access: a bootstrap role, the same as `infra/aws-e2e`.** The management account belongs
to the organization, not to Alethia. The bootstrap uses its credentials once, to create
`alethia-email-admin`. That role trusts only exact principal ARNs in the platform account
(`ArnEquals` on `aws:PrincipalArn` under the account root). After the bootstrap, the maintainer's
ordinary `alethia-sso` session does everything. The management account's ID is not written anywhere
in this repository; the bootstrap reads a local profile name from `TF_VAR_management_profile`.

**Where the state lives: the existing platform-account bucket.** The keys are
`email-ses-account/bootstrap/terraform.tfstate` and `email-ses-account/terraform.tfstate` in
`alethia-tofu-state-270587882865`. That is the same bucket and the same `alethia-sso` authentication
as `infra/aws-e2e`. The email account has no grant on the bucket.

**The identity is read, not managed.** It is live and verified, and its DKIM CNAMEs are published at
Cloudflare. Bringing it under management would need an import. A wrong attribute on it could
re-key DKIM, and every send would fail DMARC until new CNAMEs were published. The stack needs only
its ARN. The data source's postcondition makes "the identity is not ready" a plan failure. A verified
domain also covers its subdomains, so `auth.alethialabs.io` and `mail.alethialabs.io` senders are
authorized against the same ARN. The deploy's default From addresses are on the apex.

**Sending credentials: an IAM user with a narrowly scoped key, minted outside tofu.** Hosted prod runs
on Hetzner, so there is no instance role to inherit. The three options:

| | What it would take | Why not |
|---|---|---|
| OIDC federation from the console's own issuer (`lib/oidc/issuer.ts`) | An IAM OIDC provider in the email account for `https://alethialabs.io/api/oidc` with a dedicated audience, a role, and a credential provider in `@repo/email` that mints an assertion and calls `AssumeRoleWithWebIdentity` | Only the **console** holds the issuer. **Marketing and admin** also send through `@repo/email`, from the same `.env`, and would need a second path or stay on Resend. It also puts STS, and STS's fetch of the JWKS from `alethialabs.io` through Cloudflare, into the sign-in path. It is the right end state, and it is a code change in `@repo/email`, not an infra one. |
| IAM Roles Anywhere | A trust anchor and a CA, a client certificate and key on the box, and `aws_signing_helper` in three images | AWS Private CA is a large monthly fee. A self-run CA's key would be one more long-lived secret in the same vault, so this gains nothing over a key there. Certificate expiry becomes a new way for sign-in email to stop. |
| **An IAM user's access key (chosen)** | One user, one inline policy, a key in `alethia/prod/env` | One new static secret, held with every other prod secret. It can do one thing: send as `alethialabs.io` through the two configuration sets. It never enters the state. It can be deactivated in one command, and rotated without downtime (step 9). |

The worst case for a leaked key is mail sent as `alethialabs.io` until the key is deactivated. That is
bounded by the account's own sending quota, watched by the reputation alarms, and visible in
CloudTrail. `sender_source_cidrs` can also lock the key to the box's egress address. It is `[]` in
the committed tfvars, because that address changes whenever `infra/cp-hetzner` re-provisions the
box, and a stale lock refuses every sign-in email. Turn it on with the box's IPv4 `/32` once it is
stable, and update it in the same change that replaces the box.

**The access key never enters tofu state.** An `aws_iam_access_key` resource stores the secret in the
state, which lives in a bucket that several principals can read. So step 5 creates the key with the
CLI, writes it to a mode-600 temporary file, merges it into the vault with
`scripts/bootstrap-secrets.sh`, and deletes the file. The key is never printed.

**The webhook accepts exact topic ARNs only.** `apps/console/app/api/webhooks/ses/route.ts` acts
only on messages whose `TopicArn` is listed in `ALETHIA_SES_EVENTS_TOPIC_ARNS`. With nothing
configured, it refuses every message with 503. The production deploy defaults the variable to this stack's topic,
`arn:aws:sns:eu-central-1:604925221417:alethia-ses-events`. `checks.tftest.hcl` pins the same
literal, and `check.events_topic_is_the_one_the_console_accepts` fires if the real ARN differs.

**The transport is selected in the vault.** `scripts/ci/deploy-console-assemble-env.sh` used to pin
`EMAIL_PROVIDER=resend`. It now emits the vault's `EMAIL_PROVIDER` (unset means `resend`) and the
`ALETHIA_SES_*` keys. So switching to SES, and back, is a vault edit and a redeploy, not a PR.
`scripts/ci/check-email-provider-keys.sh` refuses `ses` without its five keys, and any value other
than `resend` or `ses`. It runs in the deploy's `preflight` job, before any image is built, and again
in the deploy step. `RESEND_API_KEY` stays required while SES is selected, because it is the
rollback.

## Runbook

Each step says what it changes and how to undo it. Steps 1 to 5 change nothing that hosted prod
sends with.

### 0. Preflight (read-only)

```bash
AWS_PROFILE=alethia-sso aws sts get-caller-identity --query Account --output text   # 270587882865
AWS_PROFILE=alethia-sso aws iam list-roles --path-prefix /aws-reserved/ --query 'Roles[].Arn'
```

The second command prints the SSO role ARN, **path included**, for the bootstrap's
`admin_principal_arns`.

### 1. Ship the console change to production

Merge this PR and let it reach `main` the usual way. The production deploy then runs a console that
accepts the new topic ARN, still sending through Resend. Check that the route is reachable from the
internet:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://alethialabs.io/api/webhooks/ses -d '{}'   # 400
```

`400` is the route rejecting an empty SNS envelope. `403` from Cloudflare, or a `404`, means SNS
cannot reach the route either. Fix that before step 3.

- **Roll back:** revert the PR. Nothing is subscribed to the route yet.

### 2. Bootstrap: create `alethia-email-admin` (management-account credentials, once)

```bash
cd infra/email-ses-account/bootstrap
cp backend.hcl.example backend.hcl
cp terraform.tfvars.example terraform.tfvars   # paste the SSO role ARN from step 0
AWS_PROFILE=alethia-sso tofu init -backend-config=backend.hcl
AWS_PROFILE=alethia-sso TF_VAR_management_profile=<management-account profile> \
  tofu plan -out=bootstrap.tfplan      # expect: 2 to add, 0 to change, 0 to destroy
AWS_PROFILE=alethia-sso TF_VAR_management_profile=<management-account profile> \
  tofu apply bootstrap.tfplan
```

- **Changes:** one IAM role and one `AdministratorAccess` attachment in 604925221417, and one new
  state object in the platform-account bucket.
- **Verify:** `AWS_PROFILE=alethia-sso aws sts assume-role --role-arn arn:aws:iam::604925221417:role/alethia-email-admin --role-session-name probe --query AssumedRoleUser.Arn`
- **Roll back:** the same two environment variables, then `tofu destroy`.

To use the account by hand from now on, add a profile to `~/.aws/config`:

```ini
[profile alethia-email-admin]
source_profile = alethia-sso
role_arn       = arn:aws:iam::604925221417:role/alethia-email-admin
region         = eu-central-1
```

### 3. Main apply: config sets, topics, alarms, VDM, the sender user

```bash
cd infra/email-ses-account
cp backend.hcl.example backend.hcl
printf 'ses_alarm_emails = ["you@example.com"]\n' > emails.auto.tfvars
AWS_PROFILE=alethia-sso tofu init -backend-config=backend.hcl
AWS_PROFILE=alethia-sso tofu plan -out=email.tfplan
AWS_PROFILE=alethia-sso tofu apply email.tfplan
```

- **Expect:** `17 + <number of alarm emails>` to add, 0 to change, 0 to destroy. That is the KMS
  key and alias, two topics and two topic policies, two configuration sets and two event
  destinations, the HTTPS subscription, two alarms, VDM, the suppression attributes, and the user and
  its policy. The plan must show **no** `check` warning and no other change.
- **The HTTPS subscription waits for the console.** SNS posts a `SubscriptionConfirmation` to the
  route, which confirms it. The apply waits up to five minutes for that. If step 1 is not live, the
  apply fails at that one resource. Re-apply once it is, or apply with
  `-var events_webhook_url=null` and drop the flag later.
- **Then:** click the confirmation link AWS emails to each alarm address.
- **Verify:**

  ```bash
  AWS_PROFILE=alethia-email-admin aws sns list-subscriptions-by-topic \
    --topic-arn "$(AWS_PROFILE=alethia-sso tofu output -raw events_topic_arn)" \
    --query 'Subscriptions[].[Protocol,Endpoint,SubscriptionArn]' --output text
  ```

  The HTTPS row must show a full subscription ARN, not `PendingConfirmation`.
- **Roll back:** `AWS_PROFILE=alethia-sso tofu destroy`. Nothing sends through the account yet.
  Destroying the two account-level resources only resets those settings.

### 4. Cost

The KMS key, the two alarms and the SNS traffic are small fixed costs. VDM is billed per message,
in addition to SES's own per-message price. Check the current SES pricing page before you rely on a
number.

### 5. Mint the sender's key into the vault (still dark)

The key goes straight from IAM into a mode-600 temporary file, then into the vault. It is never
printed, and it never enters tofu state. Only the keys in `$f` are merged.
`scripts/bootstrap-secrets.sh` also adds any missing internal secret, and never overwrites an
existing one.

```bash
umask 077
f="$(mktemp)"
AWS_PROFILE=alethia-email-admin aws iam create-access-key --user-name alethia-ses-sender --output json \
  | jq -r '.AccessKey | "ALETHIA_SES_ACCESS_KEY_ID=\(.AccessKeyId)\nALETHIA_SES_SECRET_ACCESS_KEY=\(.SecretAccessKey)"' > "$f"
printf '%s\n' ALETHIA_SES_REGION=eu-central-1 ALETHIA_SES_AUTH_CONFIG_SET=alethia-auth \
  ALETHIA_SES_GENERAL_CONFIG_SET=alethia-general >> "$f"
AWS_PROFILE=alethia-sso EXT_FILE="$f" ./scripts/bootstrap-secrets.sh
```

Keep `$f` for step 6, then delete it: `rm -P "$f"` on macOS, or `shred -u "$f"` on Linux.

- **Changes:** five new keys in `alethia/prod/env`. `EMAIL_PROVIDER` is not touched, so the next
  deploy still sends through Resend. It also emits these keys, which the app ignores under `resend`.
- **Roll back:** `AWS_PROFILE=alethia-email-admin aws iam delete-access-key --user-name alethia-ses-sender --access-key-id <id>`,
  and remove the five keys from the vault.

### 6. Test-send to a real inbox, as the sender

Send as `alethia-ses-sender` itself, with the key from step 5. That proves its policy, not the admin
role's.

```bash
send() {   # send <to> <configuration set>
  ( set -a; . "$f"; set +a
    env -u AWS_PROFILE -u AWS_SESSION_TOKEN \
      AWS_ACCESS_KEY_ID="$ALETHIA_SES_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$ALETHIA_SES_SECRET_ACCESS_KEY" \
      aws sesv2 send-email --region eu-central-1 \
      --from-email-address 'Alethia <no-reply@alethialabs.io>' \
      --destination "ToAddresses=$1" --configuration-set-name "$2" \
      --content 'Simple={Subject={Data="Alethia SES test"},Body={Text={Data="Sent through the alethia-email account."}}}' \
      --query MessageId --output text )
}
send you@example.com alethia-auth                        # a real inbox: prints a MessageId
send bounce@simulator.amazonses.com alethia-general      # the bounce simulator
```

- **In the inbox:** open the message's original headers. `Authentication-Results` must show
  `dkim=pass header.d=alethialabs.io` and `dmarc=pass`. SPF is checked against `amazonses.com`, which
  is the default MAIL FROM, so DMARC passes on DKIM alignment.
- **The bounce:** the simulator's bounce is published to `alethia-ses-events` and posted to the
  webhook. Within a few minutes, `NumberOfNotificationsDelivered` for the topic goes up, and
  `NumberOfNotificationsFailed` does not:

  ```bash
  # macOS `date`; on Linux use: date -u -d '-1 hour' +%FT%TZ
  AWS_PROFILE=alethia-email-admin aws cloudwatch get-metric-statistics --namespace AWS/SNS \
    --metric-name NumberOfNotificationsFailed --dimensions Name=TopicName,Value=alethia-ses-events \
    --start-time "$(date -u -v-1H +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" --period 3600 --statistics Sum
  ```

  On the box, `email_suppression` now has a `bounce` row for `bounce@simulator.amazonses.com`.
- **The scope:** the same key must be refused anything else. For example,
  `aws sesv2 list-email-identities` with the same environment as `send` returns `AccessDenied`.

### 7. Switch hosted prod to SES

```bash
g="$(mktemp)"; echo EMAIL_PROVIDER=ses > "$g"
AWS_PROFILE=alethia-sso EXT_FILE="$g" ./scripts/bootstrap-secrets.sh; rm -f "$g"
gh workflow run deploy-console.yml --ref main
```

That is a vault edit and a redeploy. The deploy's `preflight` job refuses the run before any build if
one of the five SES keys is missing. The box's `.env` then carries:

```
EMAIL_PROVIDER=ses
ALETHIA_SES_REGION=eu-central-1
ALETHIA_SES_ACCESS_KEY_ID=…            (vault)
ALETHIA_SES_SECRET_ACCESS_KEY=…        (vault)
ALETHIA_SES_AUTH_CONFIG_SET=alethia-auth
ALETHIA_SES_GENERAL_CONFIG_SET=alethia-general
ALETHIA_SES_EVENTS_TOPIC_ARNS=arn:aws:sns:eu-central-1:604925221417:alethia-ses-events
```

`tofu output app_env` prints the non-secret half of that.

- **Verify:** request an email sign-in code at https://alethialabs.io for a real inbox. It arrives
  from the vault's `AUTH_EMAIL_FROM` (default `no-reply@alethialabs.io`), and the headers show
  `dkim=pass header.d=alethialabs.io`. The VDM dashboard counts the send under `alethia-auth`.
  Also send one product email, for example an organization invite, to check `alethia-general`.
  Console, marketing and admin all switch at once, because they read the same `.env`.

### 8. Roll back to Resend

```bash
g="$(mktemp)"; echo EMAIL_PROVIDER=resend > "$g"
AWS_PROFILE=alethia-sso EXT_FILE="$g" ./scripts/bootstrap-secrets.sh; rm -f "$g"
gh workflow run deploy-console.yml --ref main
```

`RESEND_API_KEY` is still in the vault, because the deploy requires it either way. The SES keys can
stay in the vault: the app ignores them under `resend`.

If you cannot wait for a deploy, edit `EMAIL_PROVIDER=resend` into `/opt/alethia/.env` on the box,
and recreate the three services that send mail:

```bash
cd /opt/alethia
docker compose -f docker-compose.yml -f deploy/prod/docker-compose.prod.yml \
  -f deploy/prod/docker-compose.tunnel.yml up -d app marketing admin
```

The next deploy rewrites `.env` from the vault, so change the vault as well.

### 9. Rotate or revoke the key

- **Revoke now**, if it leaked:
  `AWS_PROFILE=alethia-email-admin aws iam update-access-key --user-name alethia-ses-sender --access-key-id <id> --status Inactive`.
  Every SES send fails from that moment, so roll back to Resend (step 8) in the same sitting.
- **Rotate without downtime:** an IAM user can hold two keys. Mint the second one with step 5. That
  overwrites the two key values in the vault. Redeploy, check that a sign-in code arrives, then
  deactivate and delete the old key.

## Not done here

- **Retiring `infra/email-ses`.** Its README still describes it as the self-hosters' reference,
  which stays true. Its identities, sets and topics in the platform account, and the deactivated
  `alethia-ses-sender` keys there, are the maintainer's to delete in a separate, reviewed PR.
  Any edit under `infra/email-ses/**` reaching `main` triggers its apply job, which is why this PR
  touches nothing there.
- **A custom MAIL FROM** (`bounce.alethialabs.io`) would align SPF as well as DKIM. It needs an MX
  record and an SPF TXT record at Cloudflare first, then an
  `aws_sesv2_email_identity_mail_from_attributes` resource here. DMARC already passes on DKIM.
- **Keyless sending** through the console's OIDC issuer, once `@repo/email` accepts an injected
  credential provider and marketing and admin have a way to use it. See "Sending credentials".
- **An organization SCP** on `alethia-email`, for example a region lock, can only be attached from
  the management account, so it is not in this repository.
