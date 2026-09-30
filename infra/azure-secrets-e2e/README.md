# `azure-secrets-e2e`: subscription B for the cross-subscription keyless Key Vault proof (#1268)

This is the Azure sibling of `infra/aws-secrets-e2e` and `infra/gcp-secrets-e2e`. The maintainer
applies it **once, by hand**, as an identity that can create resources in both subscriptions. It
is not the shipped customer bootstrap. That is `infra/connector/azure/secrets-xacct/`, which stays
as it is.

## What it creates

| where | resource | why |
|---|---|---|
| subscription **A** (the cluster's) | RG `alethia-e2e-xacct-identity` + user-assigned identity `alethia-e2e-xacct-eso` | the **standing** identity the nightly cluster adopts |
| subscription **B** | RG `alethia-e2e-xacct-secrets` + Key Vault `alethia-xacct-<6>` (Standard, RBAC-only, no purge protection) | holds the canary |
| subscription B | secret `alethia-e2e-xacct-canary` | the value read across the boundary, compared by sha256 |
| subscription B | `Key Vault Secrets Officer` on the vault → you | vault RBAC is data-plane, so without it the canary write gets a 403 |
| subscription B | `Key Vault Secrets User` on **the secret** → the standing identity | the grant under test |

The cost is cents a month. A Standard vault bills per operation, and the nightly makes a few reads.

## How the principal and the issuer are passed

**The principal is not passed; it is owned.** An Azure role assignment names an **object id**, and
a per-run managed identity gets a new one on every create. So the grant has to name an identity
that outlives the cluster. This stack creates that identity and grants its `principal_id` in the
same apply. If the identity is ever recreated, the grant follows it.

**The issuer is not an input at all.** Every run's AKS cluster has its own OIDC issuer. When a
cluster adopts the identity (`external_secrets_identity_name` / `_resource_group`, set by the harness
through the cluster's `provider_config`), the project template writes a federated credential on the
identity for **that** issuer and the ESO service account. The credential is named after the cluster,
and the run's `tofu destroy` removes it (`infra/templates/project/azure/workload-identity.tf`).
Subscription B trusts the identity. Which cluster may act as it is decided per run in subscription A.

The e2e provisioner's `Contributor` on subscription A (`infra/azure-e2e/roles.tf`) is what lets
the template write that credential into this stack's resource group.

## Apply (maintainer)

```bash
cd infra/azure-secrets-e2e
az login                                   # an identity with rights in BOTH subscriptions, same tenant
cp backend.hcl.example backend.hcl         # the infra/azure-e2e state account; key azure-secrets-e2e.tfstate
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars                   # target_subscription_id (B), cluster_subscription_id (A)
tofu init -backend-config=backend.hcl
TF_VAR_canary_value="$(openssl rand -hex 24)" tofu plan -out=xacct.tfplan
#   expect 8 to add: 2 RGs, identity, random suffix, vault, 2 role assignments, secret; 0 to change/destroy
tofu apply xacct.tfplan
```

The state lives beside `infra/azure-e2e`'s, in the account `infra/azure-e2e/bootstrap` created
(`docs/testing/e2e-state-migration.md`). If that migration has not happened yet, apply the bootstrap
first. Do not keep this stack's state on a laptop; #4903 is the cost of doing that.

**If the canary write returns 403 on the first apply**, the Secrets Officer grant has not reached the
data plane yet. Wait five minutes and run `plan`/`apply` again. Change nothing.

The canary value is supplied at apply time and never committed. Only its **sha256** leaves the
stack.

## The repo variables it produces

```bash
tofu output
```

| output | repo variable |
|---|---|
| `target_subscription_id` | `E2E_SECRETS_XACCT_ACCOUNT_AZURE` |
| `vault_url` | `E2E_SECRETS_XACCT_VAULT_URL` |
| `remote_key` | `E2E_SECRETS_XACCT_REMOTE_KEY_AZURE` |
| `expect_sha256` | `E2E_SECRETS_XACCT_EXPECT_SHA256_AZURE` |
| `eso_identity_name` | `E2E_SECRETS_XACCT_ESO_IDENTITY_NAME` |
| `eso_identity_resource_group` | `E2E_SECRETS_XACCT_ESO_IDENTITY_RG` |

```bash
gh variable set E2E_SECRETS_XACCT_ACCOUNT_AZURE       --body "$(tofu output -raw target_subscription_id)"
gh variable set E2E_SECRETS_XACCT_VAULT_URL           --body "$(tofu output -raw vault_url)"
gh variable set E2E_SECRETS_XACCT_REMOTE_KEY_AZURE    --body "$(tofu output -raw remote_key)"
gh variable set E2E_SECRETS_XACCT_EXPECT_SHA256_AZURE --body "$(tofu output -raw expect_sha256)"
gh variable set E2E_SECRETS_XACCT_ESO_IDENTITY_NAME   --body "$(tofu output -raw eso_identity_name)"
gh variable set E2E_SECRETS_XACCT_ESO_IDENTITY_RG     --body "$(tofu output -raw eso_identity_resource_group)"
```

Three of them are `_AZURE` **siblings** because the flat `ACCOUNT`, `REMOTE_KEY` and `EXPECT_SHA256`
are shared with the aws and gcp legs. The harness reads `<base>_AZURE` first
(`t2ArgoEnvForProvider`), so the azure values cannot clobber another cloud's. The scenario itself is
switched on by the shared `E2E_SECRETS_XACCT=1`. Dispatch `azure` **from `main`** and record the run
(`scripts/e2e/secrets-e2e.sh azure cluster`).

## What refuses what

- **The plan fails** (preconditions and validation):
  - A same-subscription apply. It would prove nothing about crossing a boundary.
  - Two subscriptions in different tenants. Keyless Key Vault access cannot cross a tenant.
  - A canary shorter than 16 characters. A short or empty value would let an empty read pass the
    digest comparison.
- **The plan warns** (`checks.tf`):
  - The grant is scoped wider than the one secret.
  - The grant is anything other than `Key Vault Secrets User`.
  - The tags carry `alethia:project-id`, the tag `scripts/e2e/azure-cleanup.sh` deletes resource
    groups by.

## Known limit: federated credentials

Azure allows 20 federated credentials per identity. A run that is hard-killed before its destroy
leaves its credential on this identity, because the sweep deletes per-run resource groups and this
one is none of them. List and prune them when an adopt fails at apply:

```bash
az identity federated-credential list -g alethia-e2e-xacct-identity --identity-name alethia-e2e-xacct-eso -o table
az identity federated-credential delete -g alethia-e2e-xacct-identity --identity-name alethia-e2e-xacct-eso -n <stale-name> --yes
```
