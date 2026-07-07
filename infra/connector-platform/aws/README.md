# Platform AWS identity — the connector hub

The **one** AWS identity Alethia's control plane authenticates as. The whole managed-cloud connector
model hubs through it:

- **AWS** — the console/runner use its static key to `sts:AssumeRole` into the customer's cross-account
  provisioner role (`AlethiaProvisionerRole-<externalId>`, created by
  [`infra/connector/aws`](../../connector/aws/)).
- **GCP** — google-auth uses the **same** key as the Workload-Identity subject-token source: the
  customer's WIF pool trusts this account's AWS provider (`create-aws --account-id=<this account>`), so
  no separate GCP secret exists.
- **Azure** — the customer app's federated credential trusts `sts.amazonaws.com` with this account as
  subject (the runner path today; console verify is a follow-up).

So: **provision this once, wire the key, and both AWS + GCP connectors light up.**

## What it creates
`alethia-connector-assumer` — an IAM **user** + a least-privilege policy allowing **only**
`sts:AssumeRole` on `arn:aws:iam::*:role/AlethiaProvisionerRole-*` (any customer account, that role-name
prefix, ExternalId-gated at assume time). No access key is created here — you make it manually so **no
secret enters OpenTofu state**.

## Apply (once, admin identity in account 270587882865)
```bash
cd infra/connector-platform/aws
cp backend.hcl.example backend.hcl                 # or run without a backend for a local trial
tofu init -backend-config=backend.hcl
tofu fmt -check && tofu validate
tofu apply                                         # a check block refuses a wrong-account apply
```

## Wire it (finish the connector)
```bash
aws iam create-access-key --user-name alethia-connector-assumer
# → put AccessKeyId/SecretAccessKey in deploy/prod/secrets.local.env as:
#     ALETHIA_AWS_ACCESS_KEY_ID / ALETHIA_AWS_SECRET_ACCESS_KEY
#     (ALETHIA_AWS_ACCOUNT_ID defaults to 270587882865)
./scripts/bootstrap-secrets.sh
gh workflow run deploy-console.yml
```
`deploy-console` also exports these as `AWS_*` so google-auth can mint the GCP subject token. In the
console → Connectors, **AWS and GCP** now show **Connect** (not "Not enabled on this instance").

**Rotate:** create a new key → update the vault + redeploy → delete the old key.

See also: docs → Self-hosting → *Managed cloud connectors*, and the per-cloud customer guides under
`docs/console/connectors/`.

## Variables
| var | default | purpose |
|---|---|---|
| `platform_account_id` | `270587882865` | the account this must live in (a `check` fails a wrong-account apply) |
| `user_name` | `alethia-connector-assumer` | the IAM user name |
| `customer_role_name_prefix` | `AlethiaProvisionerRole-` | the customer role-name pattern the assumer may assume |
| `aws_region` | `eu-central-1` | provider region (IAM is global) |
