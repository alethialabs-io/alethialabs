<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Cloud template customizability parity — audit + backlog

Part of the Cloud-Parity Foundation (Phase A). Tracks how tunable each managed-cloud project
template is, and the concrete knobs still missing for full parity.

## How customizability works

The Go layer (`packages/core/cloud/*_provider.go`) has a **`mergeProviderConfig` passthrough**: any
key in a component's `provider_config` JSONB flows through to a same-named OpenTofu variable without a
dedicated Go field. So **full customizability already exists for any variable the template declares.**

⚠️ The catch: a variable must be **declared** in the template's `variables.tf` to be settable — the
passthrough can't reach an undeclared knob. So the real parity gap is *declared-variable coverage*, not
the plumbing.

## Full escape hatch — Bring Your Own IaC (E3)

Declared-variable coverage is the parity story for the **built-in templates**. When a customer needs a
knob no template declares — or an entirely different resource graph — the full escape hatch is
**bring-your-own IaC**: attach a git repo holding your **own OpenTofu root module** to a project
environment and Alethia provisions from *your* module instead of the built-in template (v1 = **replace**
mode). This is the ultimate customizability ceiling — arbitrary OpenTofu, subject only to the fail-closed
`iacsafety` static gate (provider allowlist, no `provisioner`/`external`, no remote module sources, no
override files) and the sandbox/verify controls.

- Contract: platform context is injected as frozen `TF_VAR_alethia_*` variables (`alethia_project`,
  `_environment`, `_region`, `_project_id`, `_environment_id`); the `alethia_` var namespace is reserved.
- State: the customer backend block is overridden to Alethia's per-job console HTTP state proxy.
- Cluster wiring: a module that outputs `cluster_name` / `cluster_endpoint` opportunistically gets the
  reachability gate + ArgoCD; one that doesn't degrades gracefully.
- Availability: flag-gated (`ALETHIA_BYO_IAC_ENABLED`), GA on **self** runners; **managed** stays
  trusted-only until the container-sandbox isolation canary passes.

Full detail: [Bring Your Own IaC](../../../apps/docs/content/docs/concepts/bring-your-own-iac.mdx).

## Current declared-variable coverage

| Template | root variables |
|----------|----------------|
| AWS      | ~100 |
| GCP      | ~65 |
| Azure    | ~52 |

AWS is the most fleshed-out; Azure the least. AWS↔GCP↔Azure are at full **feature** parity (every
component provisions), but AWS exposes more fine-grained knobs.

## Top gaps to close for full parity (Phase A.2 backlog)

Each needs: declare the variable in `variables.tf` **and** wire it into the component module. Mostly Azure,
some GCP. (AWS-only knobs with no analogue — Karpenter, IRSA, CloudFront-WAF — are intentionally excluded.)

| # | Component | Knob | GCP | Azure | Analogue to add |
|---|-----------|------|-----|-------|-----------------|
| 1 | Cluster | log retention | ok | **missing** | `aks_log_retention_days` (Log Analytics) |
| 2 | Cluster | API-server authorized CIDRs | ok | **missing** | `aks_master_authorized_cidr_blocks` |
| 3 | Cluster | node disk type | ok | **missing** | `aks_disk_type` (Managed/Ephemeral) |
| 4 | Cluster | spot/preemptible nodes | ok | **missing** | `aks_node_pool_spot_instances` |
| 5 | Database | log exports | **missing** | **missing** | `cloud_sql_log_exports` / `azure_db_log_exports` |
| 6 | Database | network CIDR allowlist | ok | **missing** | `azure_db_allowed_cidr_blocks` |
| 7 | Database | parameter/flags | ok | **missing** | `azure_db_database_flags` |
| 8 | Storage | CMEK encryption | **missing** | **missing** | `encryption_algorithm` + `kms_key_name` on bucket/container objects |
| 9 | Cache | logging | **missing** | **missing** | cache log toggles |
| 10 | NoSQL | PITR / replication | **missing** | **missing** | Firestore PITR / Cosmos multi-region |

## Observability parity — no per-cloud TF needed

None of the templates provision a central observability stack in Terraform, **by design**. Observability
parity is delivered at the cluster layer:

- **Add-ons** (cloud-agnostic Helm, already in `apps/console/lib/addons/catalog.ts`): `kube-prometheus-stack`,
  Grafana Loki, Tempo, OpenTelemetry.
- **Pluggable observability connectors** (`packages/core/categories`): Datadog / Grafana Cloud / Prometheus.

So there is no observability template gap to close — it runs on every cluster regardless of cloud.

## Cloud-inherent skips (not gaps)

Some per-cloud differences are **not** parity gaps to close — the cloud simply has no analogue, so
the honest thing is to record the skip (and its alternative), not paper over it. These are surfaced
as machine-readable per-service decisions (`packages/core/argocd/decisions.go`, forwarded on
`execution_metadata["infra_services"]`) and in the [cloud-abstraction docs](../../../apps/docs/content/docs/concepts/cloud-abstraction.mdx#infra-services-post-apply):

- **Alibaba Database `IamAuth`** — ApsaraDB RDS has no IAM-database-authentication analogue, so the
  shared `iam_auth` toggle is a no-op on Alibaba (AWS Aurora / GCP Cloud SQL / Azure DB support it).
- **Aurora-only `rds_scaling_config`** — serverless-v2 min/max ACU capacity is an Aurora concept; GCP
  Cloud SQL / Azure Database use fixed vCPU/vCore tiers, so the scaling-config block is AWS-only.
- **`ClusterAdmins` on gcp / alibaba / hetzner** — cluster-admin binding is granted **outside** the
  template on these clouds (GKE via IAM, ACK via RAM, Talos via the emitted `talosconfig`/kubeconfig),
  so there is no in-template `cluster_admins` knob to wire there.
- **external-dns on Alibaba** — the alibabacloud external-dns provider has **no RRSA support upstream**
  ([external-dns#5019](https://github.com/kubernetes-sigs/external-dns/issues/5019)); external-dns is
  skipped on Alibaba until that lands. Manage AliDNS records outside the cluster meanwhile.
- **External secrets store on Hetzner** — Hetzner has no cloud secret manager; there is no
  ClusterSecretStore to install. Source secrets via the **Vault connector** instead.

### One real backlog item (a genuine analogue worth adding)

- **Azure `ClusterAdmins` → `admin_group_object_ids`** — unlike gcp/alibaba/hetzner above, AKS **does**
  have a native in-template analogue: AAD RBAC via `azurerm_kubernetes_cluster.azure_active_directory_role_based_access_control.admin_group_object_ids`.
  Wiring the shared `cluster_admins` list to it would give Azure genuine cluster-admin parity. Backlog
  (Phase A.2), not a cloud-inherent skip.

## Status

- **checks.tf** invariants: added to aws/gcp/azure (done, this phase).
- **AWS Route53 zone-create**: added (`aws/route53.tf` + `aws/modules/route53/`, wired into ACM + outputs;
  Go emits `cloud_dns_enabled`) — DNS zone-creation parity with GCP/Azure. Done, this phase.
- **The 10 knobs above**: backlog (Phase A.2) — declare + module-wire per cloud.
