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
| `cp-aws` / `cp-azure` / `cp-alibaba` / `cp-hetzner` | Per-cloud control-plane box | Static cloud keys (CI secrets) | S3-**compatible** `terraform-state` · `<cloud>-cp/` (custom endpoint) | — |
| `status/` | `status.alethialabs.io` Gatus VPS (Hetzner) | Static keys (CI secrets) | S3-compatible `terraform-state` · `status/` | — |

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

## Conventions

- Resource names `alethia-<purpose>`; vars `snake_case`; uniform tag block
  `{ project = "alethia", role = "<stack>", managed = "opentofu" }`; secrets `sensitive = true`.
- `required_version >= 1.10`, providers pinned `~> N` (OpenTofu reads the `terraform {}` block).
- Shared lint config: `infra/.tflint.hcl`; security baseline: `infra/.tfsec/`.

## Auth parity (known gap)

`email-ses` + `connector-assets` use **GitHub OIDC** (no stored keys). The five `cp-*` stacks
and `status` still use **static cloud keys** in CI secrets. Full OIDC parity is deferred: it
needs per-cloud federation (GCP Workload Identity Federation, Azure federated credentials, and
there is no native OIDC for Alibaba/Hetzner), **and** the `cp-*` state lives in an
S3-*compatible* store (custom endpoint) that OIDC would not authenticate. Target design lives
here; tracked as follow-up.
