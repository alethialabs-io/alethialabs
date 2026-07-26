# Cross-subscription keyless Azure Key Vault — target-vault read grant

Run this **once, in the subscription that owns the vault** (subscription **B**, in the **same tenant** as
your cluster), to let an Alethia cluster in another subscription (**A**) read that vault's secrets
**keylessly** — no client secret is ever created or stored. It is the target-side of the [Model B] read
grant for the `azure-kv-xacct` secrets connector (#1206).

## How it works

The in-cluster [External Secrets Operator] authenticates with the cluster's AKS workload identity
(`authType: WorkloadIdentity`) and reads the target vault by URL. This module assigns that identity's
service principal the **Key Vault Secrets User** role on the **target vault only** — read-only, scoped to
the one vault. There is **no cluster-side resource**: the grant lives entirely on the target vault.

Alethia (subscription A) never holds admin in subscription B.

## ⚠️ Same-tenant only

This works **within one Entra tenant**, across subscriptions. **Cross-tenant is not supported keyless** —
an Azure managed / workload identity cannot be used across tenants. Reading a vault in a *different tenant*
requires you to create an app registration + federated credential in the vault's tenant; that is out of
scope here (documented exclusion, #1206).

## Prerequisites

- OpenTofu/Terraform authenticated to the **secrets subscription (B)**, with Azure AD read.
- The target vault must use **RBAC authorization** (`enable_rbac_authorization = true`). On an
  access-policy vault, grant a `Get` secrets access policy to the same principal instead.
- Your cluster's external-secrets workload-identity **client id** — the `azure-kv-xacct` connector shows
  it, or read the project's `external_secrets_client_id` output.

## Use

```hcl
module "alethia_secrets_read" {
  source                              = "./infra/connector/azure/secrets-xacct"
  cluster_workload_identity_client_id = "11111111-1111-1111-1111-111111111111"
  target_key_vault_id                 = "/subscriptions/<sub-b>/resourceGroups/<rg>/providers/Microsoft.KeyVault/vaults/acme-secrets"
}
```

```bash
tofu init && tofu apply
```

Enter the **target subscription id** and the **vault URL** (e.g. `https://acme-secrets.vault.azure.net`)
in the Alethia **`azure-kv-xacct`** connector.

[Model B]: the customer bootstraps a least-privilege read grant; Alethia only references it.
[External Secrets Operator]: https://external-secrets.io/latest/provider/azure-key-vault/
