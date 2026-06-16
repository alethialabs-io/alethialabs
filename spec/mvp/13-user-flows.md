# 13 — User Flows

The core journeys, in the Alethia lexicon. The hero flow is **provision infrastructure**; self-host install and mix-and-match integrations are the two flows that express the thesis.

## Flow 1 — Provision infrastructure (hero)

1. **Connect a cloud** (zero-trust). Add a cloud identity — AWS cross-account role / GCP WIF / Azure federated / a provider API token. No static keys stored.
2. **Design a Spec.** The guided form: cluster + network + databases/caches/queues + DNS + secrets + registries + observability. Real-time **cost** (Infracost) updates as you go.
3. **Plan.** Queue a `plan` job; a **runner** assumes the role and runs OpenTofu plan; review the resource tree + cost.
4. **Apply.** Queue `alethia apply`; the runner provisions; logs stream live (SSE). On success, outputs (cluster endpoint, etc.) are finalized and **ArgoCD** is bootstrapped (GitOps).
5. **CLI variant:** `alethia login → alethia <design/import> → alethia plan → alethia apply → alethia jobs logs` — same state as the web.

## Flow 2 — Self-host install (the ownership flow)

1. `git clone` + `cp .env.example .env` (Postgres URL, S3 endpoint+keys, OAuth secrets).
2. `docker compose up` → **web · postgres · s3 (SeaweedFS) · node**. `drizzle-kit migrate` + seed run on first boot.
3. First login via **Better Auth** (email/social). You now run the entire control plane — no Supabase, no SaaS. ([06](06-self-hosting-architecture.md))
4. Connect a cloud + register a runner → provision (Flow 1). Optional `redis` profile only at scale.

## Flow 3 — Mix-and-match integrations

1. Open **Integrations** → connect the tools you use: **Cloudflare** (DNS), **Vault** (secrets), **Grafana/Prometheus/Datadog** (observability), **Docker Hub** (registry). Credentials stored scoped to you/your org.
2. In a Spec, pick the provider per category (default = cloud-native). E.g. an AWS cluster with **Cloudflare DNS + Vault secrets**.
3. Apply — the runner composes the right category modules and injects credentials at runtime only. ([08](08-integrations-extensibility.md))

## Flow 4 — runner (worker) lifecycle

- **Cloud-hosted:** a Fargate runner auto-registers, claims jobs (`SKIP LOCKED`), heartbeats, scales to zero when idle.
- **Self-hosted:** `alethia runner` registers a runner in your own infra (native permissions). Stale jobs auto-recover.

## Flow 5 — Teardown

`alethia` (or web) → `destroy` a Spec → a runner runs OpenTofu destroy → resources removed, state cleaned. Per-resource status tracked throughout.

## Flow 6 — Team & RBAC *(commercial `ee/`)*

1. Create/join an **organization**; invite members (SSO/SAML in `ee/`).
2. Assign roles (`owner/admin/operator/viewer`) at the org or per **Zone**; grants inherit Org→Zone→Spec.
3. Every action is checked by the PDP and recorded in the audit log ("who can `destroy` production?"). ([07](07-auth-rbac-sso.md))
