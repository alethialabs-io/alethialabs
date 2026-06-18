# 17 — Cost Model, Unit Economics & Pricing

Investor-grade COGS analysis **grounded in the actual infrastructure** (`infra/platform/`). All Alethia-specific figures are **estimates to validate**; cloud/API prices are as of 2026 (verify before quoting in a raise).

## The cost boundary — why margins are structurally high

The defining economic fact: **the customer's cluster runs in the customer's own cloud account.** The EKS control-plane fee, the EC2/Karpenter nodes, Aurora, ElastiCache, VPC/NAT, S3 — all billed by AWS/GCP/Azure **to the customer** (the runner assumes `AlethiaProvisionerRole` *into their account*). That spend (~$250–1,000+/mo per cluster) is **not Alethia's COGS.**

Alethia's COGS is only what **we** run to orchestrate:

```
  Alethia COGS  =  control plane (fixed, multi-tenant)
                +  runner-minutes (provisioning compute)
                +  object storage (TF state / artifacts / logs)
                +  AI tokens        (AI tier only)
                +  support          (enterprise)
```

Everything heavy lives in the customer's bill. That's the whole margin story.

## Unit costs (infra-grounded)

| Cost driver | Spec (verified in `infra/platform/`) | Unit cost (2026 est.) |
|---|---|---|
| **Runner** (provisioning worker) | Fargate **ARM64, 1 vCPU + 4 GB**, scale-to-zero, 1 job/task | **~$0.045/hr ≈ $0.00075/min** |
| — per `PLAN` | 5–15 min | ~$0.005–0.011 |
| — per `DEPLOY`/apply (EKS create) | 20–45 min | ~$0.015–0.034 |
| — per `DESTROY` | 10–20 min | ~$0.008–0.015 |
| — `CONNECTION_TEST` / `FETCH` | <3 min | ~$0.002 |
| — idle hold (scale-to-zero overhead) | ~5 min/job | ~$0.004/job |
| **Control plane** (de-Supabase, ~4 containers) | ECS app + Postgres + SeaweedFS/S3 | **~$120/mo FIXED** (multi-tenant) |
| **Object storage** | ~10 MB TF state + artifacts + logs/cust | ~$0.02–0.10/cust/mo |
| **AI premium** (repo scan) | ~50–200k tokens/scan (Claude) | ~$0.05–0.50/scan (model-dependent) |
| **Support** | human time | priced into Enterprise |

*(Control plane is ~$25/mo today on Supabase Pro; the ~$120/mo figure is the conservative de-Supabase target substrate — see [06-self-hosting-architecture](06-self-hosting-architecture.md).)*

## Per-customer COGS — amortization is the story

The control plane is **fixed and shared across all hosted customers**, so per-customer it shrinks as you grow. The variable cost (runner-minutes) is tiny — provisioning is bursty + scale-to-zero. (A heavy customer doing ~4 deploys + ~20 plans + ~30 tests/mo ≈ ~$0.50–1.00 runner + ~$0.10 storage.)

| Hosted customers | Control-plane share / cust | + Variable (typical) | = **COGS / cust / mo** |
|---|---|---|---|
| 10 | $12.00 | ~$0.80 | **~$13** |
| 50 | $2.40 | ~$1.00 | **~$3.40** |
| 200 | $0.60 | ~$1.50 | **~$2.10** |
| 1,000 | $0.12 | ~$2.00 | **~$2.10** |

**At any real scale, per-customer COGS ≈ $3–5/mo** (the <20-customer stage is the only place the fixed control plane bites).

## Gross margin per tier

| Tier | Price (proposed) | COGS/mo (at 50+ custs) | **Gross margin** |
|---|---|---|---|
| **Community** (self-host) | $0 | $0 — they run it | funnel (n/a) |
| **Team** (hosted) | ~$299/mo | ~$4 | **~99%** |
| **Business** (hosted, orgs/RBAC) | ~$999/mo | ~$5 | **~99%** |
| **Enterprise** (`ee/`, SSO/audit/multi-tenant + SLA) | from ~$2,500/mo | ~$30 (incl. amortized support) | **~95%+** |
| **AI premium** (per-scan, metered) | cost-plus | token cost | ~70–85% (token-bound) |
| **Usage** (runner-minutes overage) | metered, marked up | ~$0.001/min | ~80–95% |

**Headline: ~90–99% software gross margin** on the hosted/enterprise tiers — top-decile SaaS — because the customer bears the cloud-infra cost. The only margin-compressing lines are the **AI tier** (pass-through token cost + margin) and **enterprise support** (priced in).

## Pricing tiers (proposed — validated by COGS + comparables)

Anchored to comparables (Qovery $899 / $1,999; Porter metered) and our COGS:

- **Community — Free.** Self-host the AGPL core: full provisioning + GitOps + integrations + single-tenant + community RBAC. **$0 to us** (they run it). The top of the funnel.
- **Team — ~$299/mo (hosted).** We operate the control plane; a small team / few Zones; standard support. Sells *operational relief* (don't run 4 containers + Postgres + a runner fleet yourself).
- **Business — ~$999/mo (hosted).** Organizations/teams, RBAC, more seats/Zones, basic audit, priority support. *(This is the "hosted team" in the GTM mix.)*
- **Enterprise — from ~$2,500/mo (annual).** `ee/` SSO/SAML, full audit + retention, multi-tenancy, SLA, white-glove onboarding. **Self-managed license** option for AGPL-averse / air-gapped buyers.
- **Add-ons:** **runner-minutes** beyond plan (metered) · **AI premium** (repo-scan, metered per scan/token).

Free self-hosters pay $0 (funnel); revenue = **hosting + `ee/` + usage + support — never the core** (the "free-management-layer floor," see [14-gtm-pricing](14-gtm-pricing.md)). The mix to **$15k MRR** ([16-market-and-fundraising](16-market-and-fundraising.md)): ~2 Enterprise + ~7 Business/Team + usage/AI ≈ 12–15 paying orgs.

## "Host on AWS vs cheap" — a margin lever (sensitivity)

Our control plane + runners can run anywhere — runners only need network + the customer's role. On AWS (current) the control plane ≈ $120/mo; on Hetzner/cheap EU compute ≈ $30–50/mo. But since the control plane **amortizes to <$1/customer at scale either way**, the hosting choice barely moves gross margin — it only matters at the <20-customer stage. **Recommendation:** keep runners on AWS Fargate (role-assumption proximity/simplicity); optionally move the control plane to cheaper compute later. Don't over-optimize a cost that's already <2% of revenue.

## Investor takeaway

- **~90–99% software gross margin** — the heavy infra cost sits in the *customer's* cloud, not ours.
- **Capital-efficient growth** — open-source distribution (low paid CAC) × top-decile margin → the path to $15k MRR (~12–15 paying orgs) and beyond is cheap to run.
- **Honest risks:** AI-tier token costs (metered, pass-through) and enterprise support (priced into Enterprise) are the only COGS that scale with revenue; everything else is near-fixed.

## Caveats

Cloud/API prices as of 2026 (verify). Runner durations are infra-grounded; per-customer op-counts and support time are assumptions to validate against real usage. COGS **excludes one-time engineering/build cost** (that's the raise, not COGS) and assumes the de-Supabase ~4-container control plane as the hosted substrate.

## Sources

- Runner sizing / scaler: `infra/platform/worker/main.tf` (1 vCPU/4 GB ARM64), `infra/platform/scaler/lambda/index.py`, job durations in the runner. Cost boundary: `infra/connector/aws/alethia-bootstrap.yaml` (`AlethiaProvisionerRole`).
- Prices to verify: [AWS Fargate pricing](https://aws.amazon.com/fargate/pricing/) · [RDS pricing](https://aws.amazon.com/rds/postgresql/pricing/) · [S3 pricing](https://aws.amazon.com/s3/pricing/) · [Anthropic API pricing](https://www.anthropic.com/pricing) · comparable pricing in [`competitors/`](competitors/).
