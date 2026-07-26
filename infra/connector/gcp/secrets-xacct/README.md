# Cross-project keyless GCP Secret Manager — target-project read grant

Run this **once, in the GCP project that owns the secrets** (project **B**), to let an Alethia cluster in
another project (**A**) read that project's Secret Manager secrets **keylessly** — no service-account key
is ever created or stored. It is the target-side of the [Model B] read grant for the `gcp-sm-xacct`
secrets connector (#1206).

## How it works

The in-cluster [External Secrets Operator] runs under the cluster's GKE Workload Identity, mapped to the
external-secrets Google service account (GSA). For a cross-project secret it reads project **B** directly
(`spec.provider.gcpsm.projectID`). This module grants that GSA
`roles/secretmanager.secretAccessor` on **each named secret** in project B — a per-secret grant, never
project-wide. There is **no cluster-side resource**: the entire grant lives in the target project.

Alethia (project A) never holds admin in project B.

## Prerequisites

- OpenTofu/Terraform authenticated to the **secrets project (B)**.
- Your cluster's external-secrets GSA email — the `gcp-sm-xacct` connector shows it, or read the
  project's `external_secrets_service_account` output.

## Use

```hcl
module "alethia_secrets_read" {
  source                      = "./infra/connector/gcp/secrets-xacct"
  cluster_external_secrets_sa = "external-secrets@cluster-project-a.iam.gserviceaccount.com"
  target_project_id           = "acme-secrets-b"
  secret_ids                  = ["acme-prod-db-password", "acme-prod-api-key"] # scope to what you share
}
```

```bash
tofu init && tofu apply
```

Enter the **target project id** in the Alethia **`gcp-sm-xacct`** connector.

[Model B]: the customer bootstraps a least-privilege read grant; Alethia only references it.
[External Secrets Operator]: https://external-secrets.io/latest/provider/google-secrets-manager/
