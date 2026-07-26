# Cross-account keyless Alibaba KMS Secrets Manager — target-account trust bootstrap

Run this **once, in the Alibaba RAM account that owns the secrets** (account **B**), to let an Alethia
cluster in another account (**A**) read that account's KMS Secrets Manager secrets **keylessly** — no
access key is ever created or stored. It is the target-side of the [Model B] trust bootstrap for the
`alibaba-kms-xacct` secrets connector (#1206).

## How it works

The in-cluster [External Secrets Operator] authenticates with the cluster's RRSA (RAM Roles for Service
Accounts) identity. Because ESO does a **single `AssumeRoleWithOIDC`** (no role chaining), a cross-account
read requires account **B** to host its own RAM OIDC provider trusting the cluster's ACK issuer, plus a
role that provider can vend. This module:

- registers the cluster's ACK OIDC issuer as a **RAM OIDC provider** in account B (CA-pinned);
- creates a **KMS-read role** trusting only the cluster's external-secrets ServiceAccount via that
  provider (issuer + audience + subject pinned);
- grants **read only** — `kms:GetSecretValue` + `kms:DescribeSecret`.

Alethia (account A) never holds admin in account B. The store then reads via
`spec.provider.alibaba.auth.rrsa` with the target `oidcProviderArn` + `roleArn`.

## Prerequisites

- OpenTofu/Terraform authenticated to the **secrets account (B)**.
- The cluster's ACK OIDC issuer URL — the project's `rrsa_oidc_issuer_url` output.

## Use

```hcl
module "alethia_secrets_read" {
  source                  = "./infra/connector/alibaba/secrets-xacct"
  cluster_oidc_issuer_url = "https://oidc-ack-<region>.oss-<region>.aliyuncs.com/<cluster-id>"
  # SCOPE this to the secrets you intend to share (least-privilege):
  kms_secret_resources = ["acs:kms:<region>:<account-b>:secret/acme/prod/*"]
}

output "target_role_arn"          { value = module.alethia_secrets_read.target_role_arn }
output "target_oidc_provider_arn" { value = module.alethia_secrets_read.target_oidc_provider_arn }
```

```bash
tofu init && tofu apply
```

Copy the printed `target_role_arn` and `target_oidc_provider_arn` into the Alethia
**`alibaba-kms-xacct`** connector, with the target account id and region.

## CRD shape (verified)

The rendered `ClusterSecretStore` uses the ESO Alibaba provider's RRSA auth —
`spec.provider.alibaba.{regionID, auth.rrsa.{oidcProviderArn, oidcTokenFilePath, roleArn, sessionName}}`
— with `oidcProviderArn`/`roleArn` pointing at **account B**. See the
[ESO Alibaba provider](https://external-secrets.io/latest/provider/alibaba/). The end-to-end
cross-account read is proven by the main-gated e2e (#1268).

[Model B]: the customer bootstraps a least-privilege read grant; Alethia only references it.
[External Secrets Operator]: https://external-secrets.io/latest/provider/alibaba/
