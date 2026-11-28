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
| `email-ses/` | Self-host reference: AWS SES in the self-hoster's own account. **Not a deployment target of ours.** Its hosted resources in acct **270587882865** (where SES production access was refused) are retired by hand per [`email-ses/RETIRE.md`](email-ses/RETIRE.md) | **None** — CI is validate-only (no backend, no secrets, no role); a self-hoster applies it locally | the self-hoster's own (`backend.hcl`); hosted state was `alethia-tofu-state-270587882865` · `ses/` | `email-ses/bootstrap/` — in the hosted account it still owns the account's GitHub OIDC provider + the shared state bucket; **both stay** (never run an untargeted destroy there) |
| `email-ses-account/` | Hosted transactional email: AWS SES in the dedicated `alethia-email` account (**604925221417**, which holds SES production access): config sets, events topic → `/api/webhooks/ses`, reputation alarms, VDM, the `alethia-ses-sender` user. **Applied by hand** (it creates IAM); CI validates only | none — the provider assumes `alethia-email-admin` from the maintainer's `alethia-sso` session | `alethia-tofu-state-270587882865` · `email-ses-account/` | `email-ses-account/bootstrap/` — the `alethia-email-admin` role, applied once with the organization's management-account credentials |
| `assets-cdn/` | `assets.alethialabs.io`: a Cloudflare R2 bucket (`alethia-public-assets`, EU jurisdiction) for public media — films, posters, photos, brand files — behind an R2 custom domain and the zone's cache rule. **Applied by hand**; CI validates and runs the mocked `tofu test` only | none — the provider reads a scoped `CLOUDFLARE_API_TOKEN` from the maintainer's environment | `…270587882865` · `assets-cdn/` | none (the bucket exists) |
| `connector-assets/` | Public S3 bucket serving cloud-connector setup artifacts (acct **270587882865**) | **GitHub OIDC** (`alethia-connector-assets-deployer`) | `…270587882865` · `connector-assets/` | `connector-assets/bootstrap/` — adopts the OIDC provider + state bucket |
| `cp-hetzner` | The hosted control-plane box (prod) | **GitHub OIDC** (`alethia-cp-deployer`); Hetzner + Cloudflare tokens from AWS Secrets Manager | `…270587882865` · `hetzner/` | — |
| `cp-aws` / `cp-gcp` / `cp-azure` / `cp-alibaba` | Self-host options: the control-plane box on another cloud. Not deployment targets of ours | **None** — CI is validate-only (no backend, no secrets); a self-hoster applies it locally | S3-compatible, the self-hoster's own (`backend.hcl`) | — |
| `books-archive/` | The immutable books archive in the existing `alethia-backup` account (**450956683176**): an S3 bucket with Object Lock **COMPLIANCE 4018 days (11 y)**, SSE-KMS under a deny-delete key, the `books-monthly` OIDC role (only `repo:alethialabs-io@293964056/books@1470091729:environment:books`), the put-only, IP-locked `console-books-writer` user (no key in the state), the `alethia/books/connectors` secret shell, a USD 5 budget. About USD 1.5/month. **Applied by hand** (`books-archive/ops/`: plan → saved-plan apply → mint key into the vault); CI validates only | none — the provider assumes `alethia-backup-admin` from the maintainer's `alethia-sso` session | `alethia-tofu-state-270587882865` · `books-archive/` | none of its own — the admin role and the GitHub OIDC provider come from `backup-account/` (its bootstrap and its `oidc.tf`) |
| `status/` | `status.alethialabs.io` — a Cloudflare Worker (D1 history, KV snapshot, 1-minute cron, DNS record, route) built from `packages/status` (#7148). **Applied by hand** (its token needs account-level Workers/KV/D1 scopes); CI builds the bundle and validates only | none — the provider reads the maintainer's `CLOUDFLARE_API_TOKEN` | `alethia-tofu-state-270587882865` · `status/` | — |

### The e2e federation stacks

The OIDC/WIF plane the T2 real-cloud nightly authenticates through. **Never applied by CI** — each
one mints broad provisioning identity, so it is applied by hand with an admin identity
— by the maintainer, or by an agent on the maintainer's instruction, plan first. All of them keep state remotely and
no static state keys exist. `aws-oidc`, `gcp-e2e`, `azure-e2e` and `alibaba-e2e` keep it in the same
account/project/subscription as the identity they describe. `aws-e2e` is the deliberate exception:
its state stays in the platform account's bucket, OUTSIDE the e2e account whose role holds `s3:*`
and `iam:*` there (see its README, "Where the state lives").

| Stack | Purpose | State | Bootstrap |
|---|---|---|---|
| `aws-oidc/` | GitHub-OIDC deploy roles + the runner ECR repository + the `alethia-e2e-nightly` provisioning role + budget | `s3` · `alethia-tofu-state-270587882865` · `aws-oidc/` | `email-ses/bootstrap/` already owns the bucket |
| `aws-e2e/` | The dedicated `alethia-e2e` account (556074788436): GitHub OIDC provider + `alethia-e2e-nightly` + broker trust + budget + the `e2e.alethialabs.io` zone. Replaces the e2e half of `aws-oidc/` once its runbook's cutover is done | `s3` · `alethia-tofu-state-270587882865` · `aws-e2e/` | `aws-e2e/bootstrap/`, which is NOT a state container: it is the `alethia-e2e-admin` role the stack applies through (applied once with the organization's management-account credentials) |
| `gcp-e2e/` | WIF pool + ref-bound provider + provisioner SA + billing budget | `gcs` · `alethia-tofu-state-<project_id>` · `gcp-e2e/` | `gcp-e2e/bootstrap/` — the GCS bucket |
| `azure-e2e/` | Entra app + federated credential + subscription roles + AKS admin group | `azurerm` · `alethiatfstate`/`tfstate` · `azure-e2e.tfstate` | `azure-e2e/bootstrap/` — RG + storage account + container |
| `alibaba-e2e/` | RAM OIDC provider + `alethia-e2e-nightly` role + least-priv policy | `oss` · `alethia-tofu-state-e2e-alibaba` · `alibaba-e2e/` | `alibaba-e2e/bootstrap/` — the OSS bucket |
| `e2e-issuer/` | The E2E assertion issuer's origin `e2e-issuer.alethialabs.io`: the Workers Custom Domain, its CAA set, and the reviewed TLS CA pin `alibaba-e2e` reads | `s3` · `alethia-tofu-state-270587882865` · `e2e-issuer/` | none (the bucket exists). Applied with a zone-scoped Cloudflare token, never the deploy token |
| `aws-secrets-e2e/` | Account-B canary for the cross-account keyless secret proof | `s3` · `alethia-tofu-state-270587882865` | — |

Each `bootstrap/` owns exactly one thing. Except for `aws-e2e/bootstrap/` (it owns the apply role,
since the bucket already exists), that thing is the container its parent's state lives in. It exists
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
   the shared state bucket `alethia-tofu-state-270587882865`. It still owns both after the hosted
   SES resources are retired (`email-ses/RETIRE.md`), so only targeted destroys run there.
2. **`connector-assets/bootstrap/`** (admin, once) — adopts both; sets repo Actions var
   `CONNECTOR_ASSETS_DEPLOYER_ROLE_ARN`.
3. Main stacks apply via CI on push (or locally as the deploy role / with static keys).

Each bootstrap is admin-applied once and owns **all IAM** so the CI deploy roles carry no
`iam:*`. See each stack's own README / `bootstrap/` for details.

The e2e federation stacks follow the same shape, per cloud and admin-applied throughout:
`<stack>/bootstrap/` (the state container) **then** `<stack>/`. The bootstrap's own state goes into
the container it just created, via one two-phase init: apply under a temporary `backend_override.tf`
forcing `backend "local" {}` (not `tofu init -backend=false`, which cannot plan), delete it, then
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

## Inputs — a default is a decision

A stack's variables are its inputs on paper. In practice they are its inputs *when someone supplies
them*, and the thing that actually runs on a fresh checkout, in CI, or in a worktree is the
**defaults**. So:

- **An input that cannot be committed is declared REQUIRED, with no default.** Personal email
  addresses, an external id, anything the public repo must not carry: leave `default` off, say why
  in the description, and carry the value in a gitignored `*.auto.tfvars`. `tofu plan` then exits 1
  with *"No value for required variable"* instead of applying a silent substitute. See
  `aws-oidc.e2e_budget_alert_emails` and its twin in `azure-e2e`.
- **An input whose value is already public is COMMITTED**, in a `terraform.tfvars` tracked by a
  `!terraform.tfvars` negation in the stack's own `.gitignore` (it has to live there: both
  `infra/.gitignore` and the root `/.gitignore` ignore the file, and only a deeper rule wins).
  `aws-oidc`, `github`, `gcp-e2e`, `azure-e2e` and `alibaba-e2e` do this today.
- **An empty default — `""`, `[]`, `{}`, `false`, `null` — is never neutral.** Gating a `count` or
  `for_each` on one means the default is a **destroy**; steering a ternary on one means the default
  silently narrows or widens. Both have already happened: `aws-oidc` would have destroyed a Route53
  zone delegated at Cloudflare, and `gcp-e2e` narrowed its OIDC trust to ref-only so every
  `workflow_dispatch` from `dev` died at federation while the scheduled run kept passing.
- **A comment saying "never bare-apply" is not a control.** `prevent_destroy` on the irreplaceable
  resource is; a required variable is; a committed input is.

`pnpm check:tfvars-safety` enforces this. It is a static read of the HCL, because nothing in CI runs
`tofu plan` and `tofu validate` evaluates neither `check`, `validation` nor `prevent_destroy`. It
ratchets against `infra/tfvars-safety-baseline.json`: every empty default that still reaches a
decision is recorded there with the reason, a new one fails on the PR that adds it, and an entry
that stops describing anything fails too.

## Conventions

- Resource names `alethia-<purpose>`; vars `snake_case`; uniform tag block
  `{ project = "alethia", role = "<stack>", managed = "opentofu" }`; secrets `sensitive = true`.
- `required_version >= 1.10`, providers pinned `~> N` (OpenTofu reads the `terraform {}` block).
- Shared lint config: `infra/.tflint.hcl`; security baseline: `infra/.tfsec/`.

## Auth parity (known gap)

`connector-assets` uses **GitHub OIDC** (no stored keys); `email-ses` did until its apply job
was removed on 2026-11-15. The five `cp-*` stacks
still use **static cloud keys** in CI secrets (`status` no longer applies from CI at all, #7148). Full OIDC parity is deferred: it
needs per-cloud federation (GCP Workload Identity Federation, Azure federated credentials,
Alibaba `AssumeRoleWithOIDC` — the console already federates into all three keyless; Hetzner has
no native OIDC and stays token-only), **and** the `cp-*` state lives in an
S3-*compatible* store (custom endpoint) that OIDC would not authenticate. Target design lives
here; tracked as follow-up.
