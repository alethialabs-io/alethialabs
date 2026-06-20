# 08 — Integrations & Extensibility

**Status:** Accepted (architecture). Lets users **mix-and-match the tools they already use** per category — Cloudflare DNS instead of Route 53, Datadog/Grafana/Prometheus for observability, HashiCorp Vault for secrets, Docker Hub for registries — instead of being locked to cloud-native defaults.

## Why

The catalog already exists; the backends don't. The `integrations` table (`lib/db/migrations`) is **data-driven** and already seeds six providers as `coming_soon`: **Cloudflare** (dns), **HashiCorp Vault** (secrets), **Datadog / Grafana Cloud / Prometheus** (observability), **Docker Hub** (registry). Component tables (`spec_dns`, `spec_secrets`, `spec_container_registries`) already gained a **`provider_config` JSONB** hook in the multi-cloud refactor (`20260531000100_multi_cloud_schema.sql`). So "implement integrations" = build **per-category provider backends** behind the existing card UI — not new plumbing.

## Today (the starting point)

- The catalog is data-driven, but every category resolves to a **hardcoded cloud-native** backend per cloud directory: `infra/templates/spec/{aws,gcp,azure}/` uses `aws_route53_record` / `aws_secretsmanager_secret` / `aws_ecr_repository` (and GCP/Azure equivalents). DNS provider, secrets provider, etc. are *implied by the cluster's cloud*, not chosen.
- Credentials live in `cloud_identities` (cloud, JSONB) and `provider_tokens` (git OAuth). The six `api_key` integrations have **no credential store yet**.
- There is **no observability/monitoring component** table at all.

## The model — category × provider, one interface per category

Decouple **what** a Spec needs (a DNS zone, secrets, a registry, observability) from **who** provides it. Each **category** is an abstraction with a small set of interchangeable **providers**; the cloud-native option is just the default provider for that category.

| Category | Default (cloud-native) | Pluggable alternatives | Credential |
|---|---|---|---|
| **dns** | Route 53 / Cloud DNS / Azure DNS | **Cloudflare** | api_key (token) |
| **secrets** | Secrets Manager / Secret Manager / Key Vault | **HashiCorp Vault** | api_key (addr + token) |
| **registry** | ECR / Artifact Registry / ACR | **Docker Hub** | api_key (user + token) |
| **observability** | (none today) CloudWatch/Cloud Monitoring | **Datadog · Grafana Cloud · Prometheus** | api_key |
| git | — | GitHub · GitLab · Bitbucket (shipped) | oauth |
| cloud | — | AWS · GCP · Azure (+ new clouds, see [09](09-multi-cloud-cluster-strategies.md)) | iam_role / wif / federated |

The `integrations` table stays the **registry of record** — adding a provider to the catalog is a data row, and the UI (`components/integrations/`) renders it automatically.

## The `CategoryProvider` contract

Mirror the cloud-provider pattern (`packages/core/cloud/provider.go`, see [09](09-multi-cloud-cluster-strategies.md)) one level down, per category. Each provider backend implements:

```go
type CategoryProvider interface {
    Category() string          // "dns" | "secrets" | "registry" | "observability"
    Slug() string              // "cloudflare" | "vault" | "dockerhub" | "datadog" ...
    RequiredCredential() CredentialSpec        // shape to collect + store
    Tfvars(component, creds) map[string]any     // provider-specific tfvars
    ModulePath() string        // the OpenTofu module to compose into the plan
    Validate(component, specContext) error      // compatibility checks
}
```

A **category registry** (`map[category]map[slug]CategoryProvider`) is the single source of truth, mirrored to a TS union for the form — so "supported providers per category" is declared **once** (avoids the four-place drift problem called out in [05-architecture-overview](05-architecture-overview.md)/[09](09-multi-cloud-cluster-strategies.md)).

## Data model changes

1. **`integration_credentials`** (new) — store the `api_key`-style secrets the six providers need, alongside the existing `cloud_identities` (cloud) and `provider_tokens` (git):
   ```sql
   integration_credentials(id, user_id/org_id, integration_id FK, credentials JSONB, is_verified, created_at)
   ```
   (Subject to the same PDP/RLS scoping as everything else — [07](07-auth-rbac-sso.md).)
2. **`provider` selector per component** — add a `provider` (slug) column to `spec_dns`, `spec_secrets`, `spec_container_registries` (default = the cluster cloud's native provider). Provider-specific options ride in the **existing `provider_config` JSONB**.
3. **`vine_observability`** (new) — the missing component table; `enabled`, `provider` (datadog/grafana/prometheus/cloud-native), `provider_config`.

## Credential flow to the runner

Unchanged in shape from today: the `config_snapshot` carries **identifiers, not secrets**; the runner fetches the credential at execution time and injects it as a Terraform variable. Extend the resolver so that for a component whose `provider` is a pluggable one, the runner reads `integration_credentials` (instead of `cloud_identities`) and sets e.g. `TF_VAR_cloudflare_api_token` / `TF_VAR_vault_addr+token`. Zero-credential model preserved — secrets never sit in the snapshot, only flow to the runner at runtime.

## Template / module layout

Promote category modules to **composable, cloud-independent** units so a Cloudflare DNS module attaches to an AWS *or* GCP cluster Spec:

```
infra/templates/
  categories/
    dns/        route53/   clouddns/   azuredns/   cloudflare/
    secrets/    secretsmanager/  ...   vault/
    registry/   ecr/  ...           dockerhub/
    observability/  cloudwatch/  datadog/  grafana/  prometheus/
  spec/{aws,gcp,azure,...}/    # the cluster + network (see 09); composes the category modules
```

The runner selects modules by `(category, component.provider)` and composes them into the plan, regardless of the cluster's cloud.

## Adding a provider — the extensibility checklist (no core changes)

1. Insert a catalog row in `integrations` (category, slug, auth_method, icon).
2. Add a `CategoryProvider` impl (Go) + register it in the category registry.
3. Add the OpenTofu module under `infra/templates/categories/<category>/<slug>/`.
4. Map its credential into `integration_credentials` (the form is generated from `RequiredCredential()`).

That's it — the card UI, the form, and the runner pick it up from the registry. This is the **open-ended catalog** promise: integrations are added by registration, not by editing call sites.

## Compatibility validation

`Validate()` guards nonsensical combinations (e.g. a managed-certificate flag that only Route 53 + ACM supports, selected with Cloudflare DNS) and surfaces them in the form before a plan. Keep validation in the provider, not scattered in the UI.

## Open-core note

Integrations are **core value and stay AGPL/community** — gating the catalog would undercut "own your whole stack." The registry-of-record (`integrations` table) and the category contract are community. Only *premium* integrations (if any commercial-data-source connectors emerge) or org-scoped integration governance would live in `ee/` ([12-licensing-open-core](12-licensing-open-core.md)) — not the base pluggability.

## Exit criteria

- A Spec on AWS can select **Cloudflare** for DNS, **Vault** for secrets, **Docker Hub** for a registry, and **Grafana/Prometheus** for observability, and provision successfully.
- Adding a seventh provider requires only the 4-step checklist (catalog row + `CategoryProvider` + module + credential) — no changes to routes, the runner core, or the form engine.
- Credentials for pluggable providers flow to the runner at runtime only (never in `config_snapshot`).
