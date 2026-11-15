<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Retiring the hosted `infra/email-ses` resources

This is a runbook for the maintainer. It removes the SES resources that `infra/email-ses` and
`infra/email-ses/bootstrap` created in the Alethia platform account (**270587882865**,
`eu-central-1`). SES production access was refused in that account, so hosted email never used
these resources. Hosted email is `infra/email-ses-account`, in the dedicated `alethia-email` account
(604925221417). The stack code stays in this directory as a self-hosting reference.

Nothing here runs by itself. `.github/workflows/infra-email-ses.yml` is validate-only since this
runbook was added, so a merge to `main` applies nothing. Every command below is run by hand, from a
checkout of `main`, with an administrator `alethia-sso` session for 270587882865.

Hosted sending is not affected by any step. The console sends through Resend or through the
`alethia-email` account, and its SES webhook accepts only the topic ARNs in
`ALETHIA_SES_EVENTS_TOPIC_ARNS` (by default the `alethia-email` account's `alethia-ses-events`).

## What the state holds (inventory, 2026-11-15)

Read with `tofu state list` against `alethia-tofu-state-270587882865`. A read-only `tofu plan` of
the main stack reported no drift. The bootstrap reported one in-place update on the OIDC provider's
thumbprint list.

**`ses/terraform.tfstate`** (main stack): 20 resources. **All of them are retired.**

| Resource | Address |
|---|---|
| Configuration sets `alethia-auth`, `alethia-general` | `aws_sesv2_configuration_set.stream["auth"]`, `["general"]` |
| Their SNS event destinations | `aws_sesv2_configuration_set_event_destination.sns["auth"]`, `["general"]` |
| Domain identities `alethialabs.io`, `auth.alethialabs.io`, `mail.alethialabs.io` | `aws_sesv2_email_identity.apex`, `aws_sesv2_email_identity.stream["auth"]`, `["general"]` |
| Custom MAIL FROM `bounce.auth.…`, `bounce.mail.…` | `aws_sesv2_email_identity_mail_from_attributes.stream["auth"]`, `["general"]` |
| SNS `alethia-ses-events` and its HTTPS subscription to `https://alethialabs.io/api/webhooks/ses` | `aws_sns_topic.events`, `aws_sns_topic_policy.events`, `aws_sns_topic_subscription.events_https[0]` |
| SNS `alethia-ses-alarms` and its email subscription | `aws_sns_topic.alarms`, `aws_sns_topic_policy.alarms`, `aws_sns_topic_subscription.alarms_email[0]` |
| Reputation alarms `alethia-ses-bounce-rate`, `alethia-ses-complaint-rate` | `aws_cloudwatch_metric_alarm.bounce_rate`, `.complaint_rate` |
| KMS key for the topics, alias `alias/alethia-ses-sns` | `aws_kms_key.sns`, `aws_kms_alias.sns` |
| Account VDM | `aws_sesv2_account_vdm_attributes.this` |

**`ses-bootstrap/terraform.tfstate`** (bootstrap): 9 resources. **4 are kept, 5 are retired.**

| Resource | Address | Decision |
|---|---|---|
| GitHub Actions OIDC provider `token.actions.githubusercontent.com` | `aws_iam_openid_connect_provider.github[0]` | **KEEP.** Seven other roles trust it (`alethia-cp-deployer`, `alethia-connector-assets-deployer`, `alethia-deploy-reader`, `alethia-e2e-nightly`, `alethia-runner-release-deployer`, `alethia-spend-reporter`, `alethia-books-deployer`). `infra/aws-oidc` and `infra/connector-assets/bootstrap` adopt it as a data source. It has no `prevent_destroy`. |
| State bucket `alethia-tofu-state-270587882865` | `aws_s3_bucket.tofu_state` | **KEEP.** It holds 14 state files (2026-11-15), including these two. `prevent_destroy` is set. |
| Its versioning, encryption and public-access block | `aws_s3_bucket_versioning.tofu_state`, `aws_s3_bucket_server_side_encryption_configuration.tofu_state`, `aws_s3_bucket_public_access_block.tofu_state` | **KEEP.** |
| Deploy role `alethia-ses-deployer` and its inline policy | `aws_iam_role.deployer`, `aws_iam_role_policy.deployer` | **Retire.** Only the removed apply job of `infra-email-ses.yml` assumed it (repo variable `SES_DEPLOYER_ROLE_ARN`). No other workflow names it. Last used 2026-08-09. |
| Inline send policy `alethia-ses-send` on `alethia-ses-sender` | `aws_iam_user_policy.sender_send` | **Retire.** |
| IAM user `alethia-ses-smtp-gmail` and its policy | `aws_iam_user.smtp_gmail`, `aws_iam_user_policy.smtp_gmail_send` | **Retire.** It holds one access key, inactive and never used. |

**Because the OIDC provider has no `prevent_destroy`, never run an untargeted `tofu destroy` in
`bootstrap/`.** Use only the targeted commands in step 3.

**Outside any state** (created by hand, deleted by hand in step 4):

- the IAM user `alethia-ses-sender` (the bootstrap only reads it). Its two access keys are inactive.
- some email-address identities that were verified by hand for sandbox testing. List them with
  `aws sesv2 list-email-identities`.
- the DNS records at Cloudflare for the three retired domain identities (step 6).

## 0. Before you start

1. This runbook's PR is on `main`, so `infra-email-ses.yml` has no apply job.
2. Check that the vault does not use an access key of the old `alethia-ses-sender`. This prints
   only `yes` or `no`, never a key:

   ```bash
   export AWS_PROFILE=alethia-sso AWS_REGION=eu-central-1
   v="$(aws secretsmanager get-secret-value --secret-id alethia/prod/env \
         --query SecretString --output text | jq -r '.ALETHIA_SES_ACCESS_KEY_ID // ""')"
   m=no; for k in $(aws iam list-access-keys --user-name alethia-ses-sender \
         --query 'AccessKeyMetadata[].AccessKeyId' --output text); do [ "$k" = "$v" ] && m=yes; done
   echo "vault uses an old-account key: $m"; unset v
   ```

   It printed `no` on 2026-11-15. If it prints `yes`, stop: the vault points at this account.
3. Save the DKIM tokens of the three identities **before** step 2. Step 6 needs them, and they
   cannot be read after the identities are deleted. Keep the file outside the repository:

   ```bash
   for i in alethialabs.io auth.alethialabs.io mail.alethialabs.io; do
     printf '%s ' "$i"
     aws sesv2 get-email-identity --email-identity "$i" \
       --query 'DkimAttributes.Tokens' --output text
   done > ~/ses-270587882865-dkim-tokens.txt
   ```

## 1. Back up both state files

The bucket is versioned, so this is a second copy, not the only one:

```bash
aws s3 cp s3://alethia-tofu-state-270587882865/ses/terraform.tfstate ~/ses.tfstate.bak
aws s3 cp s3://alethia-tofu-state-270587882865/ses-bootstrap/terraform.tfstate ~/ses-bootstrap.tfstate.bak
```

## 2. Destroy the main stack

Every resource in this state is retired and none is shared, so the destroy plan covers the whole
state. Read the plan before you apply it:

```bash
cd infra/email-ses
cp backend.hcl.example backend.hcl
tofu init -backend-config=backend.hcl
tofu state list                              # the 20 resources above, and the data sources
tofu plan -destroy -out=retire.tfplan        # expect: 0 to add, 0 to change, 20 to destroy
tofu show -no-color retire.tfplan | grep -E '^  # '
tofu apply retire.tfplan
rm -f retire.tfplan backend.hcl
```

Notes:

- The KMS key is scheduled for deletion with a 7-day window (`deletion_window_in_days = 7`). It is
  not deleted at once.
- Deleting `alethia-ses-events` removes its HTTPS subscription. After this, the old topic sends
  nothing to the console.
- The email subscription on `alethia-ses-alarms` is deleted with the topic. If it was still pending
  confirmation, AWS removes it on its own.

## 3. Destroy the retired bootstrap resources, keep the rest

IAM does not delete a user that still has an access key, so delete the inactive
`alethia-ses-smtp-gmail` key first:

```bash
cd infra/email-ses/bootstrap
aws iam list-access-keys --user-name alethia-ses-smtp-gmail \
  --query 'AccessKeyMetadata[].[AccessKeyId,Status]' --output text
aws iam delete-access-key --user-name alethia-ses-smtp-gmail --access-key-id <AccessKeyId>
```

Then the targeted destroy. The targets are the 5 retired resources and nothing else:

```bash
cp backend.hcl.example backend.hcl
tofu init -backend-config=backend.hcl
tofu plan -destroy \
  -target=aws_iam_role_policy.deployer \
  -target=aws_iam_role.deployer \
  -target=aws_iam_user_policy.sender_send \
  -target=aws_iam_user_policy.smtp_gmail_send \
  -target=aws_iam_user.smtp_gmail \
  -out=retire-bootstrap.tfplan               # expect: 0 to add, 0 to change, 5 to destroy
tofu show -no-color retire-bootstrap.tfplan | grep -E '^  # '
tofu apply retire-bootstrap.tfplan
rm -f retire-bootstrap.tfplan backend.hcl
```

**Do not apply the plan if it lists `aws_iam_openid_connect_provider.github[0]` or any
`aws_s3_bucket*` address.** A `-destroy -target` destroys the targets and what depends on them,
never what they depend on, so neither should appear.

After this, `ses-bootstrap/terraform.tfstate` holds only the OIDC provider and the 4 bucket
resources. The code for the 5 retired resources is still in `bootstrap/`, so an untargeted
`tofu apply` there would create them again. Do not run one. A follow-up PR removes `deployer.tf`,
`sender-policy.tf`, `smtp-gmail.tf` and their outputs and variables.

## 4. Delete what no state holds

```bash
# The old sender user. Its inline policy went in step 3; its two keys are inactive.
aws iam list-access-keys --user-name alethia-ses-sender \
  --query 'AccessKeyMetadata[].[AccessKeyId,Status]' --output text
aws iam delete-access-key --user-name alethia-ses-sender --access-key-id <AccessKeyId>   # once per key
aws iam list-user-policies --user-name alethia-ses-sender            # expect: empty
aws iam list-attached-user-policies --user-name alethia-ses-sender   # expect: empty
aws iam delete-user --user-name alethia-ses-sender

# The email-address identities verified by hand. Check each one before you delete it.
aws sesv2 list-email-identities --query 'EmailIdentities[].IdentityName' --output text
aws sesv2 delete-email-identity --email-identity <address>          # once per address
```

If `delete-user` fails, the user still has a login profile, MFA device, signing certificate, SSH
key or service-specific credential. The error names which one.

## 5. GitHub, console and vault

- **GitHub:** the repository variable `SES_DEPLOYER_ROLE_ARN` has no reader after this PR. Delete
  it after step 3:

  ```bash
  gh variable delete SES_DEPLOYER_ROLE_ARN -R alethialabs-io/alethialabs
  ```

- **Console env:** nothing to remove. On 2026-11-15 the vault did not set
  `ALETHIA_SES_EVENTS_TOPIC_ARNS`, so `scripts/ci/deploy-console-assemble-env.sh` writes its default,
  the `alethia-email` account's topic. The old topic
  (`arn:aws:sns:eu-central-1:270587882865:alethia-ses-events`) is not in the allow-list and is not
  needed. If someone adds it to the vault later, remove it.
- **Vault:** no key is stale because of this retirement. The `ALETHIA_SES_*` keys in
  `alethia/prod/env` are for the `alethia-email` account (step 0.2 checks the access key), and the
  vault holds no `SES_SMTP_*` key.

## 6. DNS at Cloudflare

The DNS records are not managed by OpenTofu. Remove them by hand in the Cloudflare dashboard for
`alethialabs.io`, after step 2:

| Record | Host | Type |
|---|---|---|
| DKIM ×3 for each identity in `~/ses-270587882865-dkim-tokens.txt` | `<token>._domainkey.auth`, `<token>._domainkey.mail`, `<token>._domainkey` (apex) | CNAME → `<token>.dkim.amazonses.com` |
| MAIL FROM | `bounce.auth`, `bounce.mail` | MX `feedback-smtp.eu-central-1.amazonses.com` |
| MAIL FROM SPF | `bounce.auth`, `bounce.mail` | TXT `v=spf1 include:amazonses.com ~all` |

**The `alethia-email` account's `alethialabs.io` identity has its own three `_domainkey` CNAMEs on
the apex, and hosted DKIM depends on them.** Delete only CNAMEs whose token is in the saved file.
To see the tokens that must stay:

```bash
AWS_PROFILE=alethia-email-admin aws sesv2 get-email-identity --region eu-central-1 \
  --email-identity alethialabs.io --query 'DkimAttributes.Tokens' --output text
```

Keep `_dmarc`, the apex SPF record and the Cloudflare Email Routing MX records
(`infra/cp-hetzner/email-routing.tf`).

`scripts/gmail-inbox/` relayed Gmail "Send mail as" through this account's apex identity and the
`alethia-ses-smtp-gmail` user. That relay never went into service (the user's only key was never
used). Using it again needs an SMTP user in the `alethia-email` account, which is not created.

## 7. Check the result

```bash
aws sesv2 list-configuration-sets                          # no alethia-auth / alethia-general
aws sns list-topics --query 'Topics[].TopicArn' --output text | tr '\t' '\n' | grep alethia-ses   # nothing
aws cloudwatch describe-alarms --alarm-name-prefix alethia-ses --query 'MetricAlarms[].AlarmName'  # []
aws iam get-role --role-name alethia-ses-deployer          # NoSuchEntity
aws iam list-open-id-connect-providers                     # token.actions.githubusercontent.com is still there
aws s3api head-bucket --bucket alethia-tofu-state-270587882865   # still there
```

Then sign in at https://alethialabs.io with an email code. It must arrive as it did before.

## Rollback

Nothing in steps 0 and 1 changes anything. After that:

- **Main stack (step 2):** apply it again from a checkout of `main`, as in `README.md` §2
  (`tofu init -backend-config=backend.hcl`, then `tofu apply`). The identities are created again
  with **new** DKIM tokens, so publish the new CNAMEs (`tofu output -json dkim_tokens_apex` and the
  `get-email-identity` commands in `README.md` §1). The HTTPS subscription confirms only if
  `ALETHIA_SES_EVENTS_TOPIC_ARNS` lists this account's topic ARN. While the old KMS key is pending
  deletion, `aws kms cancel-key-deletion --key-id <key-id>` stops the deletion. The new stack does
  not need the old key.
- **Bootstrap (step 3):** `tofu apply` with the same five `-target` flags creates the role, the
  policies and the SMTP user again. Then set the variable again with
  `gh variable set SES_DEPLOYER_ROLE_ARN -R alethialabs-io/alethialabs --body "$(tofu output -raw deployer_role_arn)"`.
  `aws_iam_user_policy.sender_send` needs `alethia-ses-sender` to exist, so after step 4 create that
  user first with `aws iam create-user --user-name alethia-ses-sender`.
- **Access keys deleted in steps 3 and 4** cannot be restored. They were all inactive.
- **A state file:** the bucket is versioned. Restore an earlier version with
  `aws s3api list-object-versions --bucket alethia-tofu-state-270587882865 --prefix ses/` and
  `aws s3api get-object --version-id <id> …`, or copy the backup from step 1.
- **The CI apply job:** it is in this file's history. `git log -- .github/workflows/infra-email-ses.yml`
  shows the commit that removed it.
