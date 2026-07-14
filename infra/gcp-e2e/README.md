<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# gcp-e2e

The **GitHub-OIDC → GCP Workload Identity Federation** stack that lets the T2 real-cloud nightly
(`.github/workflows/e2e-nightly.yml`, `provider=gcp`) stand up + tear down a **genuine, ephemeral
GKE cluster** from `infra/templates/project/gcp`. This is the GCP enabler for BYOC **A2.1** — the
third real-provisioning cloud after Hetzner (#1) and AWS (#2, `infra/aws-oidc`).

It is the GCP analogue of `infra/aws-oidc/e2e-nightly.tf` + `e2e-budget.tf`, translated to Google
WIF. A provisioning identity is inherently broad — you can't enumerate a least-privilege action list
for "build + destroy a whole GKE estate" without it breaking on the next template change. So the
security model is **defense by guardrail**, and every guardrail is asserted in `checks.tf`:

1. **Ref-bound WIF trust** — the Workload Identity Pool **provider** carries an attribute
   **condition** admitting only GitHub tokens whose `repository` is *exactly* `github_repo` **AND**
   whose `ref` is *exactly* `e2e_github_ref` (CEL `==`, exact match — never a prefix/glob). PRs,
   forks, and sibling branches mint a token the provider **rejects at the exchange**. The
   provisioner SA is impersonable only by the repo-scoped `principalSet` (ref pinned by the provider).
2. **Estate roles = the customer connector's roles** — the SA gets the *same* enumerated predefined
   roles a real customer connection grants (`infra/connector/gcp/main.tf`), led by
   `roles/container.admin`. **GKE self-admin works through `container.admin`** — no template RBAC
   change is needed (contrast the AWS EKS access-entry gap that blocked managed EKS). So the nightly
   proves exactly what a customer's connection would.
3. **Dedicated project** — applied into a **throwaway `project_id`**, never a shared/prod project.
   This is the clean GCP analogue of the "separate account for e2e" decision; combined with the
   ref-bound trust it caps the blast radius far better than an AWS-shared-account permissions boundary.
4. **Monthly Budget + Pub/Sub** (`e2e-budget.tf`) — a cost kill-signal at 50/80/100 % actual + 100 %
   forecast of `e2e_monthly_budget_usd` (default \$100), scoped to the dedicated project, publishing
   onto a Pub/Sub topic (hang an automated kill-switch off it later).

## Files (one component per file)

| File | What |
|---|---|
| `versions.tf` / `provider.tf` | Pinned `hashicorp/google ~> 6.0`; provider + `data.google_project.this`. |
| `apis.tf` | Enables the federation + estate + billing APIs up-front. |
| `variables.tf` | `project_id`, `region` (validated ≠ prod), `github_repo`, `e2e_github_ref`, WIF ids, `billing_account_id`, `e2e_monthly_budget_usd`. |
| `e2e-nightly.tf` | WIF pool + ref-bound OIDC provider + provisioner SA + estate roles + `workloadIdentityUser` binding. |
| `e2e-budget.tf` | Cloud Billing budget (project-scoped) + Pub/Sub topic + publisher binding. |
| `outputs.tf` | `e2e_gcp_wif_provider`, `e2e_gcp_sa_email`, budget topic, project number. |
| `checks.tf` | Invariant `check` blocks (ref-bound condition, `container.admin` bound, budget cost-capped + project-scoped, region ≠ prod). |

## Enable the GCP nightly (maintainer)

**Real `tofu apply` is maintainer-gated** — agents never apply this (it mints broad IAM). Run it with
an admin identity into a **dedicated e2e project**:

```bash
cd infra/gcp-e2e
cp terraform.tfvars.example terraform.tfvars   # set project_id + billing_account_id (+ repo/region)

tofu init
tofu apply    # creates the WIF pool/provider + SA + estate roles + budget in the dedicated project

# Publish the two repo Actions VARIABLES the nightly gates on:
gh variable set E2E_GCP_WIF_PROVIDER    -b "$(tofu output -raw e2e_gcp_wif_provider)"
gh variable set E2E_GCP_SERVICE_ACCOUNT -b "$(tofu output -raw e2e_gcp_sa_email)"
# (the workflow reads the SA from vars.E2E_GCP_SERVICE_ACCOUNT; E2E_GCP_WIF_PROVIDER is the gate.)
```

Until `E2E_GCP_WIF_PROVIDER` is set, the GCP path of `e2e-nightly.yml` **green-skips** (mirrors the
Hetzner `HCLOUD_TOKEN` / AWS `E2E_AWS_ROLE_ARN` gates). `id-token: write` (used to mint the GitHub
OIDC token WIF exchanges) lives only on `e2e-nightly.yml`, which triggers **solely on `schedule` /
`workflow_dispatch`** — never `pull_request` (program invariant 1).

If budget Pub/Sub notifications don't arrive, grant the Cloud Billing budgets service agent publish
rights on the topic (the stack sets this for `billing-budgets@system.gserviceaccount.com`; confirm
the address for your org in the Cloud Billing → Budgets → *Manage notifications* docs).

## Kick the tyres, then flip cron on

```bash
# 1. One manual GCP run (dispatch). Watch it provision → verify → tear down.
gh workflow run e2e-nightly.yml -f provider=gcp
gh run watch "$(gh run list -w e2e-nightly.yml -L1 --json databaseId -q '.[0].databaseId')"

# 2. KILL-DRILL — cancel mid-apply and confirm the guaranteed sweep leaves ZERO billable resources:
#    the always() teardown runs scripts/e2e/gcp-cleanup.sh scoped to alethia_project-id=e2e-<run>.
#    Then verify by hand (scope-locked, never project-wide):
gcloud container clusters list --filter="resourceLabels.alethia_project-id=e2e-<run_id>-<attempt>"
gcloud compute instances  list --filter="labels.alethia_project-id=e2e-<run_id>-<attempt>"

# 3. Once a green run + a clean kill-drill are proven, add gcp to the cron matrix (the workflow PR
#    owns that edit) — the gate var already in place means cron picks it up.
```

## The guaranteed sweeper — `scripts/e2e/gcp-cleanup.sh`

The nightly runs it in an `always()` step (fail-closed: a GCP run with no executable sweeper is a
HARD error). It is scope-locked to this run's unique `alethia_project-id=e2e-<ENV>` label (and
secondary GKE-`goog-k8s-cluster-name` / VPC-name binds for the out-of-band GKE node MIGs,
CSI `pvc-*` disks, and LoadBalancer front-ends tofu never tracks) — **never project-wide** (cf. the
shared-account near-wipe). `DRY_RUN=1` lists only; `PREFLIGHT=1` sweeps prior-run orphans (best-effort).

## GKE zonal-naming note

`infra/templates/project/gcp/locals.tf` derives a `gcp_region_key` (strips a trailing `-<letter>`
zone suffix) before the region-short lookup, so the T2 default **zonal** `region` (`europe-west3-a`)
names resources without a plan-time "key does not exist in map" error. The GKE module still receives
`location = var.region` verbatim (a zonal cluster — cheaper, intentional for e2e).
