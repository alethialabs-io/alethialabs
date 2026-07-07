# Platform AWS identity — the connector hub (keyless)

The **one** AWS identity Alethia's control plane authenticates as, for **AWS + GCP**. It's **keyless** —
the control plane runs off-AWS and federates INTO this account via the Alethia OIDC issuer (the same
issuer Azure + Alibaba use), so there's no access key to create, store, or rotate.

- **AWS** — the console federates in via `AssumeRoleWithWebIdentity` (minted assertion), then
  `sts:AssumeRole` into the customer's cross-account provisioner role (`AlethiaProvisionerRole-<externalId>`,
  created by [`infra/connector/aws`](../../connector/aws/)).
- **GCP** — google-auth uses the resulting **temporary** creds (incl. the session token) as the
  Workload-Identity subject-token source: the customer's WIF pool trusts this account's AWS provider
  (`create-aws --account-id=<this account>`), so no separate GCP secret exists.
- **Azure / Alibaba** — do **not** ride this hub; they federate the OIDC issuer directly.

So: **provision this once, wire the role ARN, and both AWS + GCP connectors light up.**

## What it creates
An IAM **OIDC identity provider** for `https://alethialabs.io/api/oidc` + a least-privilege **role**
whose trust policy allows **only** `AssumeRoleWithWebIdentity` from that provider, pinned to Alethia's
workload subject + audience (`sub = alethia-connector`, `aud = sts.amazonaws.com`). Its permission policy
allows **only** `sts:AssumeRole` on `arn:aws:iam::*:role/AlethiaProvisionerRole-*` (any customer account,
that role-name prefix, ExternalId-gated at assume time). **No access key — no secret ever enters state.**

## Apply (once, admin identity in account 270587882865)
```bash
cd infra/connector-platform/aws
cp backend.hcl.example backend.hcl                 # or run without a backend for a local trial
tofu init -backend-config=backend.hcl
tofu fmt -check && tofu validate
tofu apply                                         # check blocks refuse a wrong-account apply or an
                                                   # under-pinned trust policy
```

## Wire it (finish the connector)
```bash
# → put the assumer_role_arn output in deploy/prod/secrets.local.env as:
#     ALETHIA_AWS_PLATFORM_ROLE_ARN=<assumer_role_arn>
#     (ALETHIA_AWS_ACCOUNT_ID defaults to 270587882865)
./scripts/bootstrap-secrets.sh
gh workflow run deploy-console.yml
```
The console mints a fresh assertion per ~1h session and writes/refreshes `AWS_*` at runtime for
google-auth. In the console → Connectors, **AWS and GCP** now show **Connect**.

**Rotation:** automatic — nothing to rotate (each session is a fresh short-lived assertion).

See also: docs → Self-hosting → *Managed cloud connectors*, and the per-cloud customer guides under
`docs/console/connectors/`.

## Variables
| var | default | purpose |
|---|---|---|
| `platform_account_id` | `270587882865` | the account this must live in (a `check` fails a wrong-account apply) |
| `role_name` | `alethia-connector-assumer` | the IAM role name the console federates into |
| `oidc_issuer_url` | `https://alethialabs.io/api/oidc` | the Alethia issuer (web-identity trust root) |
| `oidc_audience` | `sts.amazonaws.com` | the audience the console mints (OIDC provider client id) |
| `workload_subject` | `alethia-connector` | the OIDC subject the trust policy pins |
| `customer_role_name_prefix` | `AlethiaProvisionerRole-` | the customer role-name pattern the assumer may assume |
| `aws_region` | `eu-central-1` | provider region (IAM is global) |
