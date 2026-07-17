<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# AWS project template — tagging (label-at-source) & money-guards

This is the AWS EKS + VPC + RDS + ECR project template. The rest of the config is documented inline
(one file per concern) and in the per-module READMEs under `modules/`. This README covers the two
cross-cutting guarantees the BYOC real-apply campaign depends on: **label-at-source tagging** (so a
guarded sweeper can reclaim exactly one environment) and **plan-failing money-guards** (so an
automated apply can't accidentally provision an expensive estate).

## Label-at-source: the sweep key on every sweepable resource

The console emits `var.classification_tags` (`packages/core/cloud/tags.go`, B1.2) — the project's
classification dimensions plus the mandatory sweep handles `alethia:project-id` /
`alethia:environment-id`. These merge into `local.aws_default_tags` **under** the platform base tags,
so a base key always wins a collision (`checks.tf: classification_base_tags_win`), and none is
dropped (`classification_tags_present`).

The sweep key must reach **every** resource class a sweeper might reclaim. AWS has three distinct
tagging paths, not one:

| Resource class | How the sweep tag lands | Wired in |
|---|---|---|
| Most taggable resources (VPC, S3, DynamoDB, Route53, WAF, SQS, IAM, …) | provider `default_tags` fan-out | `main.tf` (B1.3) |
| ECR repositories | `resources_tags = local.aws_default_tags` | `ecr.tf` (B1.3) |
| EKS cluster + managed node group | `eks_tags = local.aws_default_tags` | `eks.tf` (B1.3) |
| **EBS volumes dynamically provisioned for PVCs** | EBS-CSI addon `controller.extraVolumeTags` | `modules/eks/eks.tf` (B1.3) — **unproven, see below** |
| **Karpenter-launched EC2 / EBS** | `EC2NodeClass spec.tags` ← `karpenter_node_tags` output | `outputs.tf` (**A1.2**) |

### Karpenter (A1.2)

Karpenter provisions instances/volumes via its **own** `ec2:CreateFleet`/`RunInstances` calls, not
via OpenTofu, so the provider `default_tags` and the EKS-module `tags` **never** reach them. The only
lever is `spec.tags` on the `EC2NodeClass` CR (applied post-apply by the runner). The template surfaces
the exact tag map as the **`karpenter_node_tags`** output (= `local.aws_default_tags`); the EC2NodeClass
renderer must stamp it verbatim. `checks.tf: karpenter_node_tags_carry_sweep_handle` asserts, at plan
time, that when Karpenter is enabled the classification/sweep handles are all present in that map, so
the output can never ship without them. (Whether the renderer actually applies `spec.tags` is proven
by the A1.3 sweeper / an A0.3-style cloud-side check on a real apply — not by this template.)

### EBS-CSI `extraVolumeTags` — UNPROVEN until A0.3 is green

`controller.extraVolumeTags` (`modules/eks/eks.tf`) is the only lever that stamps the tags onto every
dynamically-provisioned `pvc-*` volume — but it is **only observable after a real apply with live
PVCs**. It is wired but **not yet verified** against a real volume in this program; A0.3's cloud-side
sweep-tag check on a Bound volume is what upgrades it from "wired" to "proven". **Fallback** if it
turns out not to stamp: set the sweep tags via StorageClass `parameters.tagSpecification_N` or the
driver's `--extra-tags` flag (`controller.additionalArgs`) — both are driver-native tagging paths
independent of the addon `configuration_values`.

## ECR + in-cluster builds (W2)

`ecr.tf` creates one repository per entry of **`ecr_names_map`** (`{ <logical name> = <repo base> }`,
composed as `<project_name>-<base>`). The map is populated by the tfvars emitter
(`packages/core/cloud/aws_provider.go: buildECRNamesMap`) — one entry per **native** container-registry
component plus one per **repo-sourced service** (the W2 build destination). `provision_ecr = true`
with an empty map creates nothing; `checks.tf: ecr_names_present_when_provisioned` fails that plan
loudly instead of silently.

The build path is keyless: `irsa.tf` defines the **build-SA IRSA role** (`ecr-build-<eks_name>`),
trusted only by `alethia-build:kaniko-builder` — the exact ServiceAccount the kaniko Job renderer
schedules builds under — and scoped to `ecr:GetAuthorizationToken` + push/pull on the project's own
`<project_name>-*` repositories. Outputs the BUILD/render lanes consume: **`ecr_repository_urls_map`**
(push destination per logical name), **`ecr_build_role_arn`** (annotate the SA), and
**`ecr_build_service_account`** (the namespace:sa contract).

## Money-guards (A1.2)

`cost_guards.tf` enforces **plan-failing** cost ceilings. `check` blocks (in `checks.tf`) only emit
warnings and do **not** stop an apply, so these live in a `terraform_data` resource whose
`precondition`s abort `tofu plan`/`apply`. `terraform_data` makes no cloud call and provisions
nothing; `tofu validate` does not evaluate preconditions, so the template still validates cleanly.

Defaults are generous enough for real production and match the shipped config; each guard is
overridable via its own `cost_guard_*` variable (an explicit, reviewed decision). Their job is to
stop *accidental* runaway, not to cap intentional scale.

| Guard | Fails the plan when | Override | Default |
|---|---|---|---|
| Node ceiling | `eks_ng_max_size` > `cost_guard_max_nodes` | `cost_guard_max_nodes` | 100 |
| Desired ≤ max | `eks_ng_desired_size` > `eks_ng_max_size` | — (fix the values) | — |
| Root volume | `eks_disk_size` > `cost_guard_max_disk_gb` | `cost_guard_max_disk_gb` | 1000 GB |
| Instance family | `eks_instance_types` has bare-metal / ≥16xlarge / high-end GPU (p·dl·trn·inf) | `cost_guard_allow_large_instances = true` | reject |
| Aurora ACUs | `create_rds` and `rds_scaling_config.max_capacity` > `cost_guard_max_rds_acu` | `cost_guard_max_rds_acu` | 16 |
| Expiry tag | `cost_guard_require_expiry_tag` and no `expiry`/`ttl` tag present | `cost_guard_expiry_tag_keys` | off |

The e2e nightly typically tightens the node/instance limits and sets
`cost_guard_require_expiry_tag = true` so a leaked estate is always time-bounded. `m5a.4xlarge`
(the template default) and `m5.12xlarge` are **not** flagged; `m5.16xlarge`, `p4d.24xlarge`,
`g5.48xlarge`, `inf2.xlarge` and `*.metal` are.
