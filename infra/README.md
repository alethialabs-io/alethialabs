<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# infra/

OpenTofu (`tofu`, pinned `1.10.10` in CI) infrastructure for Alethia. Each **stack** is a
self-contained directory with the canonical file set — `backend.tf` · `versions.tf` ·
`variables.tf` · `main.tf` · `outputs.tf` · `backend.hcl.example` · `terraform.tfvars.example`
— and is driven by a matching `.github/workflows/infra-<stack>.yml` (validate on PR, apply on
push to `main`). PR jobs run **no cloud/state credentials** (static checks only:
`tofu fmt -check` + `tflint` + `tfsec`); apply jobs run on `main`.

## Stacks

| Stack | Purpose | Auth (CI) | State | Bootstrap |
|---|---|---|---|---|
| `email-ses/` | AWS SES transactional email (acct **270587882865**) | **GitHub OIDC** (`alethia-ses-deployer`) | `alethia-tofu-state-270587882865` · `ses/` | `email-ses/bootstrap/` — owns the account's OIDC provider + state bucket |
| `connector-assets/` | Public S3 bucket serving cloud-connector setup artifacts (acct **270587882865**) | **GitHub OIDC** (`alethia-connector-assets-deployer`) | `…270587882865` · `connector-assets/` | `connector-assets/bootstrap/` — adopts the OIDC provider + state bucket |
| `cp-aws` / `cp-gcp` / `cp-azure` / `cp-alibaba` / `cp-hetzner` | Per-cloud control-plane box | Static cloud keys (CI secrets) | S3-**compatible** `terraform-state` · `<cloud>-cp/` (custom endpoint) | — |
| `status/` | `status.alethialabs.io` Gatus VPS (Hetzner) | Static keys (CI secrets) | S3-compatible `terraform-state` · `status/` | — |

### The e2e federation stacks

The OIDC/WIF plane the T2 real-cloud nightly authenticates through. **Never applied by CI** — each
one mints broad provisioning identity, so a maintainer applies it by hand with an admin identity
(`tofu apply` on `infra/` identity stacks is maintainer-only). All four keep state remotely, in the
same account/project/subscription as the identity they describe, so the admin's own credentials
authenticate the backend and no static state keys exist.

| Stack | Purpose | State | Bootstrap |
|---|---|---|---|
| `aws-oidc/` | GitHub-OIDC deploy roles + the `alethia-e2e-nightly` provisioning role + budget | `s3` · `alethia-tofu-state-270587882865` · `aws-oidc/` | `email-ses/bootstrap/` already owns the bucket |
| `gcp-e2e/` | WIF pool + ref-bound provider + provisioner SA + billing budget | `gcs` · `alethia-tofu-state-<project_id>` · `gcp-e2e/` | `gcp-e2e/bootstrap/` — the GCS bucket |
| `azure-e2e/` | Entra app + federated credential + subscription roles + AKS admin group | `azurerm` · `alethiatfstate`/`tfstate` · `azure-e2e.tfstate` | `azure-e2e/bootstrap/` — RG + storage account + container |
| `alibaba-e2e/` | RAM OIDC provider + `alethia-e2e-nightly` role + least-priv policy | `oss` · `alethia-tofu-state-e2e-alibaba` · `alibaba-e2e/` | `alibaba-e2e/bootstrap/` — the OSS bucket |
| `aws-secrets-e2e/` | Account-B canary for the cross-account keyless secret proof | `s3` · `alethia-tofu-state-270587882865` | — |

Each `bootstrap/` owns exactly one thing: the container its parent's state lives in. It exists
because a stack cannot keep its state in a bucket it has not created yet — the same chicken-and-egg
`email-ses/bootstrap/` solves on the AWS side. Every state container is **versioned**, refuses
public access, and carries `prevent_destroy`.

Migrating a stack onto its backend is a maintainer act on live identity, written out step by step in
[`docs/testing/e2e-state-migration.md`](../docs/testing/e2e-state-migration.md).

Non-stack directories:
- `connector/` — the artifacts customers run to grant Alethia access (AWS CFN/`.tf`, GCP/Azure
  setup `.sh` + `.tf`). **Single source of truth** for the files mirrored into
  `apps/console/public/` and published by `connector-assets/` (kept in sync by
  `scripts/check-connector-assets.mjs`).
- `templates/` — customer **project** IaC applied at provision time: `project/{aws,gcp,azure}`
  (full per-cloud stacks), `categories/` (pluggable DNS/observability/registry/secrets),
  `argocd/`, `runner/`. Driven by `ProjectConfig` → `ProviderTfvars` → tofu vars
  (`packages/core`). Gated by `.github/workflows/infra-templates.yml` (fmt/validate/lint/tfsec,
  **no apply** — customers apply these).

## Apply order

1. **`email-ses/bootstrap/`** (admin, once) — creates the account's GitHub OIDC provider **and**
   the shared state bucket `alethia-tofu-state-270587882865`.
2. **`connector-assets/bootstrap/`** (admin, once) — adopts both; sets repo Actions var
   `CONNECTOR_ASSETS_DEPLOYER_ROLE_ARN`.
3. Main stacks apply via CI on push (or locally as the deploy role / with static keys).

Each bootstrap is admin-applied once and owns **all IAM** so the CI deploy roles carry no
`iam:*`. See each stack's own README / `bootstrap/` for details.

The e2e federation stacks follow the same shape, per cloud and admin-applied throughout:
`<stack>/bootstrap/` (the state container) **then** `<stack>/`. The bootstrap's own state goes into
the container it just created, via one two-phase `tofu init -backend=false` → apply →
`tofu init -backend-config=backend.hcl -migrate-state`.

## State

Every stack declares a **partial** backend — `terraform { backend "<type>" {} }` — and takes the
bucket/account at init time from a gitignored `backend.hcl` copied from the checked-in
`backend.hcl.example`. Nothing about where state lives is hardcoded in the config, and no state
credential is ever stored: the identity that applies the stack authenticates its backend natively.

A stack with **no** backend block, or with a `backend "local" {}`, keeps state in the working tree —
one machine, no versioning, no recovery. `infra/.gitignore` refuses to track `*_override.tf` for that
reason: OpenTofu merges override files over the stack's own config, so a committed one silently
re-points every operator. That is exactly how `azure-e2e` spent months on local state (#1887).

## Conventions

- Resource names `alethia-<purpose>`; vars `snake_case`; uniform tag block
  `{ project = "alethia", role = "<stack>", managed = "opentofu" }`; secrets `sensitive = true`.
- `required_version >= 1.10`, providers pinned `~> N` (OpenTofu reads the `terraform {}` block).
- Shared lint config: `infra/.tflint.hcl`; security baseline: `infra/.tfsec/`.

## Auth parity (known gap)

`email-ses` + `connector-assets` use **GitHub OIDC** (no stored keys). The five `cp-*` stacks
and `status` still use **static cloud keys** in CI secrets. Full OIDC parity is deferred: it
needs per-cloud federation (GCP Workload Identity Federation, Azure federated credentials,
Alibaba `AssumeRoleWithOIDC` — the console already federates into all three keyless; Hetzner has
no native OIDC and stays token-only), **and** the `cp-*` state lives in an
S3-*compatible* store (custom endpoint) that OIDC would not authenticate. Target design lives
here; tracked as follow-up.
