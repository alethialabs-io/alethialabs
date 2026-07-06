<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# connector-assets

Public-read S3 bucket that serves the **cloud-connector setup artifacts** the console
and CLI hand out during the AWS / GCP / Azure connect flows:

| Object | Source | Used by |
|---|---|---|
| `alethia-bootstrap.yaml` | `infra/connector/aws/alethia-bootstrap.yaml` | AWS CloudFormation **quick-create** (`templateURL`) |
| `alethia-gcp-setup.sh` | `infra/connector/gcp/alethia-gcp-setup.sh` | GCP Cloud Shell `curl … \| bash` |
| `alethia-azure-setup.sh` | `infra/connector/azure/alethia-azure-setup.sh` | Azure Cloud Shell `curl … \| bash` |

Served at the canonical
`https://alethia-connector-assets.s3.eu-west-1.amazonaws.com/<object>`. This is the
default of `NEXT_PUBLIC_CONNECTOR_ASSETS_ORIGIN`
(`apps/console/components/connector/connector-assets.ts`) and the CLI's
`connectorBaseURL` (`apps/cli/cmd/connector.go`). The same files ship in
`apps/console/public/` (byte-identical) as the self-host fallback.

> AWS CloudFormation quick-create requires an **S3-hosted** template URL — that's why a
> real bucket (not just the console origin) is the canonical fix.

## Layout

- `bootstrap/` — owns all IAM (admin applies **once**): the GitHub-OIDC deploy role
  `alethia-connector-assets-deployer` and its least-privilege policy. Adopts the
  account's existing OIDC provider and state bucket (both created by
  `infra/email-ses/bootstrap`).
- root (`main.tf`, …) — the bucket + public-read policy + the uploaded objects.
  Applied by CI (`.github/workflows/infra-connector-assets.yml`) as the deploy role.

State lives in `alethia-tofu-state-270587882865` (account `270587882865`); the OIDC
role authenticates the S3 backend natively — no static state keys.

## First-time setup

```bash
# 1. Bootstrap (IAM) — once, with an admin identity for account 270587882865.
cd infra/connector-assets/bootstrap
cp backend.hcl.example backend.hcl
cp terraform.tfvars.example terraform.tfvars   # adjust if needed
tofu init -backend-config=backend.hcl
tofu apply
tofu output deployer_role_arn                  # → next step

# 2. Set the repo Actions variable so CI can assume the role:
#      CONNECTOR_ASSETS_DEPLOYER_ROLE_ARN = <deployer_role_arn>

# 3. Merge to main → infra-connector-assets.yml creates + populates the bucket.
#    (Or apply the main stack locally as the deploy role / an admin.)
```

## Verify

```bash
curl -fsS https://alethia-connector-assets.s3.eu-west-1.amazonaws.com/alethia-azure-setup.sh | head
# → the shell script (NOT an <?xml …?> error)
```

## Updating a setup script

Edit the source under `infra/connector/{aws,gcp,azure}/` **and** mirror the change into
`apps/console/public/` (keep them byte-identical). The CI workflow triggers on
`infra/connector/**`, and `etag = filemd5(...)` re-uploads the changed object on the
next apply.
