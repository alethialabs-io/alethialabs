# `aws-secrets-e2e` — account B for the cross-account keyless secrets e2e

Applied **once, by hand**, in the **target** AWS account (account B) to support the
cross-account keyless cloud-secret-manager e2e (#1268, part of epic #1206).

The e2e provisions an EKS cluster in **account A** and proves a workload reads a secret that lives
**here**, in account B, holding no credential anywhere: the External Secrets Operator assumes the
read role below using the cluster's own IRSA identity, and the test compares the materialized value
by SHA-256.

## This is not the customer bootstrap

The shipped customer module is [`infra/connector/aws/secrets-xacct`](../connector/aws/secrets-xacct),
which trusts an **exact role ARN** — and must keep doing so.

This stack trusts a narrow **principal pattern** instead, because the e2e cluster is destroyed and
recreated nightly:

> IAM resolves a role-ARN principal to that role's unique id (`AROA…`) when the trust policy is
> **saved**. A destroy/recreate mints a new unique id, so an exact-ARN trust is dead on the second
> run. `aws:PrincipalArn` is evaluated per **request** against the caller's current ARN, which
> survives recreation.

The account-root principal does **not** mean "any principal in account A": it delegates trust to
account A's IAM, and the `ArnLike` condition narrows the actual caller to one role-name shape. Both
must pass, and `checks.tf` refuses a pattern that could match everything.

**The consequence is recorded, not hidden:** the nightly proves the ESO *read path*, not the exact
trust-policy shape the customer module writes. `docs/testing/xacct-secrets-parity.md` carries this
as a known divergence, closed by a one-shot manual `strict` run.

## Apply

```bash
cp backend.hcl.example backend.hcl        # edit: target account's state bucket
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars                  # set cluster_account_id (account A)

tofu init -backend-config=backend.hcl
TF_VAR_canary_value="$(openssl rand -hex 24)" tofu apply
```

`canary_value` has **no default** and is never written to a file — generate it inline. The e2e only
ever compares its SHA-256, so the value itself never reaches CI config, job logs or the proof
bundle.

## Outputs → repo variables

| Output | Repo variable |
|---|---|
| `target_role_arn` | `E2E_SECRETS_XACCT_ROLE_ARN` |
| `target_account_id` | `E2E_SECRETS_XACCT_ACCOUNT` |
| `region` | `E2E_SECRETS_XACCT_REGION` |
| `secret_name` | `E2E_SECRETS_XACCT_REMOTE_KEY` |
| `canary_sha256` | `E2E_SECRETS_XACCT_EXPECT_SHA256` |

All five are **variables**, not secrets — a role ARN, an account id, a region, a secret name and a
digest. Then set `E2E_SECRETS_XACCT=1` to enable the lane. Full procedure:
[`docs/testing/e2e-nightly-enablement.md`](../../docs/testing/e2e-nightly-enablement.md).

## Why only AWS

GCP, Azure and Alibaba have no equivalent stack here because their ESO identity cannot be
pre-trusted the same way — see the per-cloud verdicts in
[`docs/testing/xacct-secrets-parity.md`](../../docs/testing/xacct-secrets-parity.md). GCP and Azure
are unblocked instead by the `external_secrets_*` **adoption variables** on their project templates
(adopt a standing identity, so the target-side grant is applied once); Alibaba is an honest
exclusion, since ESO's RRSA needs an OIDC provider registered against *this cluster's* issuer.
