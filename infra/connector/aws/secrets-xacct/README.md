# Cross-account keyless AWS Secrets Manager — target-account trust bootstrap

Run this **once, in the AWS account that owns the secrets** (account **B**), to let an Alethia cluster in
another account (**A**) read that account's Secrets Manager secrets **keylessly** — no access key is ever
created or stored. It is the target-side of the [Model B] trust bootstrap for the `aws-sm-xacct` secrets
connector (#1206).

## How it works

The in-cluster [External Secrets Operator] runs under the cluster's IRSA identity. When it reads an
`aws-sm-xacct`-backed secret it calls `sts:AssumeRole` on the **read role this module creates**, then
`secretsmanager:GetSecretValue` in account B. This module's role:

- **trusts only** your cluster's external-secrets IRSA role ARN (a specific role in account A) — nothing
  else, and an optional `external_id` for defense in depth;
- grants **read only** — `secretsmanager:GetSecretValue` + `secretsmanager:DescribeSecret` — on the
  secret ARNs you name (scope these!), plus optional `kms:Decrypt` for CMK-encrypted secrets.

Alethia (account A) never holds admin in account B; account B never trusts an Alethia AWS account.

## Prerequisites

- OpenTofu/Terraform authenticated to the **secrets account (B)** (`AWS_REGION` set).
- Your cluster's external-secrets IRSA role ARN — the `aws-sm-xacct` connector shows it, or read the
  project's `eks_irsa_external_secrets_arn` output.

## Use

```hcl
module "alethia_secrets_read" {
  source                            = "./infra/connector/aws/secrets-xacct"
  cluster_external_secrets_role_arn = "arn:aws:iam::111111111111:role/irsa-external-secrets-eks-..."
  # SCOPE this to the secrets you intend to share (least-privilege):
  secret_arns = ["arn:aws:secretsmanager:eu-west-1:222222222222:secret:acme/prod/*"]
  # kms_key_arns = ["arn:aws:kms:eu-west-1:222222222222:key/<id>"]  # only for CMK-encrypted secrets
  # external_id  = "..."                                            # optional; also enter it in the connector
}

output "target_role_arn" { value = module.alethia_secrets_read.target_role_arn }
```

```bash
tofu init && tofu apply
```

Copy the printed `target_role_arn` into the Alethia **`aws-sm-xacct`** connector's **Target Role ARN**,
along with the target account id and region.

[Model B]: the customer bootstraps a least-privilege read grant; Alethia only references it.
[External Secrets Operator]: https://external-secrets.io/latest/provider/aws-secrets-manager/
