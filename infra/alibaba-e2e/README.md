<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# alibaba-e2e

The **`alethia-e2e-nightly` RAM role** — the keyless identity the T2 real-cloud nightly
(`.github/workflows/e2e-nightly.yml`, `alibaba` provider) assumes via **AssumeRoleWithOIDC** to
provision + tear down a **genuine, ephemeral ACK estate** from `infra/templates/project/alibaba`
(ACK + VPC + NAT + SLB/ALB + CSI cloud disks + …). The Alibaba analogue of `infra/aws-oidc`'s
`alethia-e2e-nightly` role (BYOC A1.1) and `infra/gcp-e2e` / `infra/azure-e2e`.

| Resource | Purpose |
|---|---|
| `alicloud_ims_oidc_provider.github` | Trusts the **GitHub Actions** OIDC issuer (`token.actions.githubusercontent.com`), CA-fingerprint-pinned |
| `alicloud_ram_role.e2e` | `alethia-e2e-nightly` — trust bound **exactly** to `repo:<repo>:ref:refs/heads/<branch>` |
| `alicloud_ram_policy.e2e_provision` + attachment | Least-privilege **Custom** policy: `cs/ecs/vpc/slb/alb/eip:*` + `tag:*` (teardown) + the 3 non-escalating service-linked-role verbs |

Distinct from `infra/connector/alibaba`: that stack registers a RAM OIDC provider trusting the
**Alethia control-plane** issuer (a customer connecting their account); this one trusts **GitHub
Actions** so CI can provision the e2e estate. Two different IdPs, two different providers/roles.

## Security model — defense by guardrail

A provisioning identity is inherently broad — you can't enumerate a least-privilege action list for
"build + destroy a whole ACK estate" without it breaking on the next template change. So, mirroring
the AWS twin, the model is **defense by guardrail**, and every guardrail is asserted in `checks.tf`:

1. **Ref-bound OIDC trust** — only Actions runs whose OIDC `sub` is *exactly*
   `repo:<github_repo>:ref:refs/heads/<e2e_github_branch>` (default `main`) may assume the role.
   `StringEquals`, **never** `StringLike` — no PR, fork, or sibling branch/repo can match. `oidc:aud`
   (`sts.aliyuncs.com`) and `oidc:iss` are pinned too. This is the same non-wildcard subject binding
   `packages/core/verify/controls_alibaba.go` **ALI-OIDC-001** enforces on RRSA trusts.
2. **Least-privilege Custom policy** — service-scoped (`cs/ecs/vpc/slb/alb/eip:*`) plus `tag:*` (the
   teardown sweeper) and the narrow `ram:*ServiceLinkedRole*` grant ACK/NAT need on first use.
   **Never** a bare `*:*` and **never** an admin System policy (`AdministratorAccess` /
   `AliyunRAMFullAccess`) — the exact hard-fails **ALI-LEASTPRIV-001** blocks. (Service wildcards on
   `Resource:"*"` are an accepted *warn*, the same posture as the AWS role's `ec2:*`/`eks:*`.)

### Known limitation — no region lock, no permissions boundary (Alibaba gap)

Unlike AWS, **Alibaba RAM has no universal region condition key** (no `aws:RequestedRegion`
analogue) and **no permissions-boundary mechanism**. So this role cannot be region-fenced or
boundary-capped *in policy* the way the AWS e2e role is. Two things make that acceptable here:

- Alethia runs **no prod infrastructure in any Alibaba region**, so there is no prod blast radius to
  fence away (the AWS lock exists because that account is shared with prod state/SES/fleet). The
  `region` variable + `prod_regions` guard are kept as a tripwire for if that ever changes.
- The real wall is therefore the **ref-bound OIDC trust**: only trusted-branch runs execute here, so
  *"who can run the nightly"* ≈ *"who can push the e2e branch."* The **region-locked sweeper**
  (`scripts/e2e/alibaba-cleanup.sh`, scoped to `ALETHIA_E2E_REGION` + the unique per-run
  `alethia:project-id=e2e-<env>` tag) is the teardown guarantee.

**Recommended before Alibaba goes to cron (maintainer):** give the e2e nightly its **own dedicated
Alibaba account** (the Alibaba analogue of the invariant-3 "separate hcloud account for e2e"
decision) — the clean fix for the absent region/boundary controls.

### Cost guard — no native budget resource

The `aliyun/alicloud` provider exposes **no cost-budget resource** (no `alicloud_bss_budget`
equivalent to AWS `aws_budgets_budget`; `alicloud_cms_alarm` is a *metric* alarm, not a spend
budget). So the cost ceiling is enforced **out-of-band**:

- **Manual budget (do this once):** Alibaba Cloud console → **Expenses / Cost Management → Budgets**
  → create a monthly budget (e.g. **$100**) with actual-spend alerts at 50/80/100 %, notified to the
  maintainer. This is the Alibaba analogue of the AWS `e2e-budget.tf` SNS budget.
- **In-run guard:** the T2 harness pins the cheapest ACK node shape per provider
  (`ecs.e-c1m2.large` ×1, min disk — see `e2e-nightly.yml`), and the always()-teardown sweeper
  removes the run's resources no matter how the test ends. A leak surfaces as the manual budget's
  alert.

## Apply (once, with an admin identity)

This is a bootstrap: it creates RAM entities, so it needs an admin Alibaba identity the first time.
State is **local** (a one-time bootstrap; gitignored) — wire an `oss` backend if you prefer.

```bash
# Authenticate an admin identity (env keys, an `aliyun` CLI profile, or a RAM session):
export ALICLOUD_ACCESS_KEY=...  ALICLOUD_SECRET_KEY=...  # (admin — used only to CREATE the RAM entities)

cp terraform.tfvars.example terraform.tfvars   # edit if repo/region differ
tofu init
tofu apply
```

## Enable the Alibaba nightly (maintainer)

```bash
# 1. Apply the stack (creates the OIDC provider + e2e role + least-priv policy).
tofu apply

# 2. Publish the outputs as the repo Actions VARIABLES the nightly gates on. Until E2E_ALIBABA_ROLE_ARN
#    is set, the alibaba path of e2e-nightly.yml green-skips (mirrors the hetzner HCLOUD_TOKEN gate).
gh variable set E2E_ALIBABA_ROLE_ARN          -b "$(tofu output -raw E2E_ALIBABA_ROLE_ARN)"
gh variable set E2E_ALIBABA_OIDC_PROVIDER_ARN -b "$(tofu output -raw E2E_ALIBABA_OIDC_PROVIDER_ARN)"

# 3. Create the manual monthly budget in the Alibaba console (see "Cost guard" above).

# 4. Dispatch a manual run and watch it (provision → prove → destroy):
gh workflow run e2e-nightly.yml -f provider=alibaba
gh run watch "$(gh run list --workflow=e2e-nightly.yml -L1 --json databaseId -q '.[0].databaseId')"

# 5. Kill-drill the teardown guarantee: cancel a run mid-apply, then confirm the always()-step
#    sweeper (scripts/e2e/alibaba-cleanup.sh) removed everything. From an admin shell:
DRY_RUN=1 ALETHIA_E2E_ENV="<run_id>-<attempt>" ALETHIA_E2E_REGION=eu-central-1 \
  ALETHIA_E2E_PROJECT=alethia-nl ./scripts/e2e/alibaba-cleanup.sh   # list-only; expect "none" everywhere

# 6. Gate = cron: once a manual run is green AND the kill-drill leaves nothing, Alibaba joins the
#    nightly cron matrix automatically (the gate flips on E2E_ALIBABA_ROLE_ARN being set).
```

The nightly's token-request step MUST mint the GitHub OIDC token with audience **`sts.aliyuncs.com`**
(the `oidc_audience` this provider pins). The `id-token: write` permission used to assume the role
lives only on `e2e-nightly.yml`, which triggers **solely on `schedule` / `workflow_dispatch`** —
never `pull_request` (program invariant 1).

## Notes on provider spellings (validated)

- The OIDC provider resource is **`alicloud_ims_oidc_provider`** (the `ims` service), not
  `alicloud_ram_oidc_provider` — matching `infra/connector/alibaba/main.tf`.
- The role trust attribute is **`assume_role_policy_document`** (a JSON string), the writable
  spelling `controls_alibaba.go` parses (`parseALITrust`). The principal key is **`Federated`** and
  the action **`sts:AssumeRole`** — the Alibaba OIDC-federation shape `isALIFederatedTrust` keys on
  (same as `alethia-alibaba-setup.sh`).
