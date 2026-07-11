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

## Status

- **checks.tf** invariants: added to aws/gcp/azure (done, this phase).
- **AWS Route53 zone-create**: added (`aws/route53.tf` + `aws/modules/route53/`, wired into ACM + outputs;
  Go emits `cloud_dns_enabled`) — DNS zone-creation parity with GCP/Azure. Done, this phase.
- **The 10 knobs above**: backlog (Phase A.2) — declare + module-wire per cloud.
