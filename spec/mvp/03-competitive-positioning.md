# 03 — Competitive Positioning

## Market category

Alethia sits in the gap between two crowded categories:
- **IaC orchestration** (Terraform Cloud, Spacelift) — runs your IaC, but gives you *plumbing*, not a product; you still write everything and often hand it credentials.
- **BYOC app PaaS** (Qovery, Porter, Northflank) — a product, but it wants your cloud keys and/or runs only on *its* hosted control plane, and centers on app deploys, not infrastructure design.

Alethia's wedge cuts across both: **a self-hostable, open-source control plane that designs and provisions infrastructure with zero stored credentials, lets you plug in your own tools, and runs on any cloud.** Nobody else owns "own-the-control-plane + zero-trust + integration breadth + open source" together.

## Landscape

| Capability | **Alethia** | Terraform Cloud | Spacelift | Qovery | Porter | Northflank | Crossplane | Cloudfleet / Syself |
|---|---|---|---|---|---|---|---|---|
| **Self-host the control plane** | ✅ ~4 containers | ❌ SaaS | ❌ SaaS | ❌ SaaS | partial | ❌ (control plane hosted) | ✅ (in your cluster) | ❌ managed |
| **Zero stored credentials** | ✅ runner assumes roles | stored/dynamic | stored role | BYOC, but connected | BYOC | BYOC | n/a (in-cluster) | managed creds |
| **Open source** | ✅ AGPL core | OSS engine, paid SaaS | ❌ | partly | partly | ❌ closed-core | ✅ Apache | thin/none |
| **Visual design + CLI, shared state** | ✅ Spec form + `alethia` | ❌ HCL only | ❌ | app UI | app UI | app UI | ❌ CRDs/YAML | ❌ |
| **Pluggable integrations (mix-match)** | ✅ per-category | provider-agnostic | provider-agnostic | limited | limited | limited | composition | ❌ |
| **Multi-cloud + managed/self-managed strategies** | ✅ | agnostic | agnostic | hyperscaler | hyperscaler | broad | k8s-native | EU providers |
| **Generates real OpenTofu you own** | ✅ | you write it | you write it | abstracted | abstracted | abstracted | CRD-driven | n/a |
| **App-delivery model** | ✅ GitOps (ArgoCD + your repo) | n/a | n/a | proprietary PaaS | proprietary PaaS | proprietary PaaS | GitOps/CRDs | n/a |
| **Pricing model** | open-core: free self-host + hosted/ee | resource-based | from $399/mo + $40/runner | $899–$1,999/mo | ~$225/mo floor | usage-based | free (ops cost) | free→paid (Cloudfleet free ≤24 vCPU) |

*(Pricing as of 2026; sources below.)*

## Key differentiators

### 1. Own the control plane (self-hostable OSS)
Terraform Cloud, Spacelift, Qovery, and Northflank are **SaaS** — the brain runs on the vendor's servers. Alethia's entire control plane self-hosts as ~4 containers (Postgres + S3 + app + runner), AGPL-licensed. You can run it air-gapped, in-region, under your own audit. ([06-self-hosting-architecture](06-self-hosting-architecture.md))

### 2. Zero-trust remote provisioning
Most tools ask you to store a cloud key or hand them an admin role. Alethia's runner runs in *your* account and assumes roles **at execution time** — the control plane never sees or stores cloud credentials. Short-lived, scoped, nothing to leak.

### 3. Integration breadth — your tools, not lock-in
Cloud-native by default, but **swap any category**: Cloudflare DNS, Vault secrets, Datadog/Grafana/Prometheus observability, Docker Hub registries. The PaaS competitors lock you to their opinionated stack. ([08-integrations-extensibility](08-integrations-extensibility.md))

### 4. Cloud-native, not lowest-common-denominator
Like Crossplane it's a real control plane, but without forcing every team to learn CRDs/YAML and operate it — Alethia gives a guided **Spec** form + `alethia` CLI and generates real OpenTofu you own. Unlike the hyperscaler-only PaaS, it spans many clouds and both managed and self-managed cluster strategies.

### 5. App-delivery you own — GitOps, not a black box
Alethia wires ArgoCD to **your** repo with auto-sync (standard Kustomize/Helm) — your apps deploy from a `git push` and stay reconciled, using tooling you can take anywhere. Porter/Qovery/Northflank deploy through *their* proprietary pipeline on *their* control plane; leaving means re-platforming. With Alethia there's nothing to leave — it's your cluster, your ArgoCD, your repo. **Same outcome (a production app platform, fast), opposite ownership model — the anti-Porter.**

## What Alethia replaces

| Current approach | Pain | Alethia |
|---|---|---|
| Hand-written Terraform modules | weeks of boilerplate, reinvented per team | Spec form → real OpenTofu in minutes |
| Static cloud keys in CI/IaC SaaS | leak, over-permission, fail audits | roles assumed at runtime, nothing stored |
| Hosted PaaS holding your keys | vendor lock-in, can't self-host | own the AGPL control plane |
| Cloud-native lock-in (Route 53/Secrets Manager only) | can't use your existing tools | pluggable per-category providers |
| Crossplane DIY | powerful but ops-heavy, CRD-only, no UI | guided design + CLI, you still own the output |

## Positioning statement

**For** platform/DevOps teams and orgs that must own their infrastructure stack, **who** won't hand a hosted SaaS their cloud keys or lock into one cloud, **Alethia** is an open-source, self-hostable, multi-cloud control plane **that** designs and provisions production Kubernetes with zero stored credentials and your choice of integrations. **Unlike** Terraform Cloud/Spacelift (SaaS plumbing) and Qovery/Porter/Northflank (key-holding, hyperscaler-locked PaaS), **Alethia** you run yourself, on any cloud, and own end to end.

## Per-competitor deep-dives

Full sourced, head-to-head comparisons (Alethia vs each of 14) live in [`competitors/`](competitors/), with the [**master matrix**](competitors/README.md). The honest pattern across all of them: **Alethia wins on ownership, openness (AGPL), zero-trust, and — vs the PaaS — provisioning real cloud infra you own; but nearly every competitor is more mature today with shipping day-2 ops — which is exactly Alethia's V2.** Hold the moat (own-it + zero-trust + open-source) now; close the day-2 gap in V2.

- **BYOC PaaS:** [Porter](competitors/porter.md) · [Qovery](competitors/qovery.md) · [Northflank](competitors/northflank.md) · [Azin](competitors/azin-run.md)
- **IaC orchestration:** [Terraform Cloud](competitors/terraform-cloud.md) · [Spacelift](competitors/spacelift.md)
- **Control plane:** [Crossplane](competitors/crossplane.md)
- **Managed Kubernetes:** [Cloudfleet](competitors/cloudfleet.md) · [Syself](competitors/syself.md)
- **Self-hosted PaaS:** [Coolify](competitors/coolify.md) · [Dokploy](competitors/dokploy.md) · [Sealos](competitors/sealos.md)
- **Hosted PaaS:** [Render](competitors/render.md) · [Railway](competitors/railway.md)

## References

- Qovery pricing — https://www.qovery.com/pricing
- Porter / Northflank BYOC + pricing — https://northflank.com/blog/best-paas-that-runs-in-my-own-cloud-account-bypc-self-hosted-paas · https://northflank.com/pricing
- Spacelift / Terraform Cloud pricing — https://spacelift.io/blog/terraform-cloud-pricing
- Crossplane (CNCF, Apache-2.0) — https://www.crossplane.io/
- Cloudfleet pricing (free ≤24 vCPU) — https://cloudfleet.ai/pricing/ · Syself — https://syself.com/
