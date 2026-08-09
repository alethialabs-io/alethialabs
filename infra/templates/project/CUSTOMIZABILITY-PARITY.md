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

⚠️ **And the passthrough is per-COMPONENT, not global.** `mergeProviderConfig` is called for exactly
three components — `Cluster.ProviderConfig`, `DNS.ProviderConfig` and each database's
`ProviderConfig`. `ProjectContainerRegistryConfig` carries a `ProviderConfig` field
(`packages/core/types/project_config.go`) that **no provider passes to it**, so a registry variable is
reachable only by a BYO-IaC caller writing raw tfvars, whatever the template declares. Declaring more
`ecr_*`-style registry knobs before that line exists would manufacture unreachable knobs — the
"unwired template" state `apps/console/scripts/check-offer-parity.mjs` is built to catch. Wire the
registry passthrough first.

Two claims, not one: *declared in `variables.tf`* and *reachable through a component's
`provider_config`*. `TestProviderTfvars_NodeShapeAndSecretKeepersAreReachable`
(`packages/core/cloud/passthrough_test.go`) asserts both halves per knob, re-scraping the `.tf` on
every run so the two cannot drift apart silently. And a third claim sits under those: *read by a
resource argument*. A knob can be declared, reachable, and assigned to nothing — which is why the
node-shape suites assert on the **planned resource** where the template can plan one under mocks
(`alibaba/checks_cluster.tftest.hcl`), not merely on the local that feeds it.

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

Counted with `grep -c '^variable "' <cloud>/variables.tf`, so the number is re-derivable rather than
remembered:

| Template | root variables |
|----------|----------------|
| AWS      | 107 |
| GCP      | 78 |
| Azure    | 72 |
| Alibaba  | 54 |
| Hetzner  | 29 |

AWS is the most fleshed-out because it was built first. Some of the spread below it is legitimate:
Hetzner substitutes in-cluster OSS (CloudNativePG, Vault, Harbor, RabbitMQ, Valkey, MinIO) for
managed services, so it genuinely has fewer cloud-native knobs to expose. The rest is drift.

**A raw count is not a parity measure**, and this table should not be read as one. GCP's number
included `gke_spot`, `gke_preemptible`, `gke_enable_private_endpoint` and `gke_log_retention_days` —
four variables declared in `variables.tf` and read by **no resource on any code path**. `gke_spot`
shipped `default = true`, so the template advertised Spot node pools it never provisioned. A count
credits a dead declaration exactly as much as a working knob; only the carrier rule
(`check-offer-parity.mjs`) tells them apart.

## Top gaps to close for full parity (Phase A.2 backlog)

Each needs: declare the variable in `variables.tf` **and** wire it into the component module. Mostly Azure,
some GCP. (AWS-only knobs with no analogue — Karpenter, IRSA, CloudFront-WAF — are intentionally excluded.)

| # | Component | Knob | GCP | Azure | Analogue to add |
|---|-----------|------|-----|-------|-----------------|
| 1 | Cluster | log retention | ok | **missing** | `aks_log_retention_days` (Log Analytics) |
| 2 | Cluster | API-server authorized CIDRs | ok | **missing** | `aks_master_authorized_cidr_blocks` |
| 3 | Cluster | node disk type | ok | ✅ shipped | `aks_os_disk_type` (Managed/Ephemeral) |
| 4 | Cluster | spot/preemptible nodes | ✅ shipped | ✅ shipped | `aks_spot_*` (a separate node pool); `gke_spot`/`gke_preemptible` were declared-and-dead |
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
- **`ClusterAdmins` on hetzner** — Talos has no cloud IAM plane; access is the emitted
  `talosconfig`/kubeconfig, so there is no in-template `cluster_admins` knob to wire. A genuine
  ceiling.
- **`ClusterAdmins` on alibaba — WIRED ([#2005](https://github.com/alethialabs-io/alethialabs/issues/2005)), no longer a skip**.
  An earlier version of this line said the binding is "granted outside the template" (ACK via RAM),
  as if the cloud forced it. Checking the pinned provider refuted that:
  `alicloud_cs_kubernetes_permissions` is in `aliyun/alicloud` 1.286.0 and is exactly a
  cluster-admin binding. The template now declares `ack_cluster_admins`
  (`alibaba/cluster-admins.tf`, reachable through the Cluster `provider_config` passthrough and
  pinned by `alibaba/checks_cluster_admins.tftest.hcl`) and carries the constraint that survived
  the schema check: ACK's grant API is a **replace, not a merge** — it "overwrites the permissions
  that have been granted to the specified RAM user" — so the template owns the full permission set
  of every principal it touches: one resource per uid, duplicate uids refused at the variable, and
  the knob documented as being for principals whose ACK grants the template owns.
- **`ClusterAdmins` on gcp — excluded by this template's own invariants, not cloud-inherent
  ([#2005](https://github.com/alethialabs-io/alethialabs/issues/2005))**. The provider does not
  force the binding out of the template: `google_project_iam_member` with
  `roles/container.clusterAdmin` exists, and so does `kubernetes_cluster_role_binding`
  (`hashicorp/kubernetes` is in the lockfile). Both paths are refused by *named* invariants
  instead. The IAM path needs `resourcemanager.projects.setIamPolicy` — the owner-equivalent
  permission #300 deliberately stripped from the provisioner (the two #722 project bindings that
  tried 403'd on every apply and were deleted; see `gcp/app-db-identity.tf`'s ADOPTION note). The
  in-cluster RBAC path is an in-tofu Kubernetes-applying resource, which
  `scripts/check-templates-plan-safe.sh` forbids because the runner's `tofu plan -out` cannot
  resolve a provider wired from the cluster's own known-after-apply endpoint. So GKE cluster-admin
  grants live where the adopted service accounts already live — the customer's own IAM (connector
  bootstrap) or the runner's post-apply path. Unlike its "cloud-inherent" predecessor, this line
  names the invariants that refuse the knob, so it goes stale loudly if either moves.
- **external-dns on Alibaba** — the alibabacloud external-dns provider has **no RRSA support upstream**
  ([external-dns#5019](https://github.com/kubernetes-sigs/external-dns/issues/5019)); external-dns is
  skipped on Alibaba until that lands. Manage AliDNS records outside the cluster meanwhile.
- **External secrets store on Hetzner** — Hetzner has no *cloud* secret manager, so there is no
  cloud-identity ClusterSecretStore. Source secrets via a **pluggable secrets connector** instead:
  the External Secrets Operator installs on every cloud (incl. Hetzner), and a selected
  **Vault / OpenBao / Doppler / generic / Infisical** connector renders a credential-authenticated
  ClusterSecretStore (`secretstore-<slug>`) so workloads resolve values in-cluster.
- **Pluggable secrets runtime-read (ESO 0.9.20 provider support)** — the in-cluster read path exists
  for the stores ESO 0.9.20 supports first-class with static credentials:
  - **Vault / OpenBao** and **generic** (a Vault-KV-API-compatible endpoint — the `generic` connector
    is `vault` under a provider-neutral label, reusing the same module + `provider.vault` store) →
    `spec.provider.vault` with `auth.tokenSecretRef`.
  - **Doppler** → `spec.provider.doppler` with `auth.secretRef.dopplerToken`.
  - **Infisical** → `spec.provider.infisical` with `auth.universalAuthCredentials` (two secret refs,
    `clientId` + `clientSecret`) and a `secretsScope`. Requires the chart at **0.9.20 or later** — the
    `infisical` provider is absent from 0.9.12's CRD bundle, which is why the pin moved.
    `secretsScope.projectSlug` is the project **slug**, a different identifier from the `workspace_id`
    the tofu write path uses, so the connector collects both.
  - **1Password** — **runtime-read excluded**: ESO's `onepassword` provider is **Connect-only**
    (needs a 1Password Connect server + connect token), which a bare Service-Account token cannot
    satisfy. The provision/write path is unaffected. No chart bump unblocks this — it is a separate
    feature with its own deployment story.
  The exclusion is explicit and documented (not silent) — a store with no first-class read path on
  the pinned chart registers no `saasSecretStore` and renders no ClusterSecretStore.

### Formerly the one real backlog item — since shipped

- **Azure `ClusterAdmins` → `admin_group_object_ids` — WIRED (B4.1 + A2.2)** — unlike hetzner (no
  IAM plane) and gcp (invariant-excluded) above, AKS has a native in-template analogue and it is
  wired end-to-end: the shared `cluster_admins` list (each admin's `groups` holding Entra group
  object IDs) flows through `azure_provider.go` into `aks_admin_group_object_ids`, unioned with an
  explicit `provider_config` value, and lands on
  `azurerm_kubernetes_cluster.azure_active_directory_role_based_access_control.admin_group_object_ids`
  (`azure/aks.tf`, GUID-shape gated by `azure/checks_cluster.tf`). Recorded here because this page
  listed it as backlog long after it shipped — on the very topic where a stale line cost the most
  (#2005).

## Status

- **checks.tf** invariants: added to aws/gcp/azure (done, this phase).
- **AWS Route53 zone-create**: added (`aws/route53.tf` + `aws/modules/route53/`, wired into ACM + outputs;
  Go emits `cloud_dns_enabled`) — DNS zone-creation parity with GCP/Azure. Done, this phase.
- **Alibaba `ack_cluster_admins`** (#2005): wired — `alicloud_cs_kubernetes_permissions`, one
  resource per uid with the replace-not-merge constraint carried on the resource, gated fail-closed
  (ADMINS-001) and pinned by `alibaba/checks_cluster_admins.tftest.hcl`. Done, this phase.
- **The 10 knobs above**: backlog (Phase A.2) — declare + module-wire per cloud.

## Where these decisions are recorded, and the gap in that

Every deferral on this page lives in prose — here, and in `.tf` comments. Neither is machine-checked.

`apps/console/scripts/check-offer-parity.mjs` builds `MEASURED_KINDS` from the **canvas offer
surface**, and `check-config-carriage.mjs` measures **user-settable fields**. Node shape, registry
depth, WAF depth, cluster-admin IAM and control-plane secret encryption are none of those things:
they are template variables reached through `provider_config` passthrough. So no guard can red any
cell on this page, and no deferral here can ever go stale the way a `baseline:` entry does.

That is why entries above carry issue numbers and name the invariants they rest on rather than a
confident sentence — #2005 is what a confident sentence costs here: a false "cloud-inherent"
cluster-admin line stood unquestioned until the provider schema was re-checked, and the azure
wiring sat recorded as backlog long after it shipped. The alibaba knob is now pinned by a suite
(`alibaba/checks_cluster_admins.tftest.hcl`), but nothing reds a cell on this page itself. Until
the template-variable surface has a ratchet of its own — or these knobs become first-class offers
and inherit one — treat this page as a record of intent, not as enforcement.
