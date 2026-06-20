# 14 — Go-To-Market, Revenue Model & Pricing

Open-core revenue, grounded in the `ee/` boundary ([12](12-licensing-open-core.md)), the authz/orgs paid
line ([07](07-auth-rbac-sso.md)), the unit economics ([17](17-cost-model-and-pricing.md)), and the
competitive monetization reality ([03](03-competitive-positioning.md) + `competitors/`).

## The floor (the rule that governs everything): you cannot sell the core

The AGPL self-hostable core is **free forever** — a free management layer over the customer's **own**
cloud spend; a self-hoster pays $0, and that's the trust that fuels the funnel ([12](12-licensing-open-core.md)).
Revenue = what a team pays us to **not operate / not worry about** themselves: **convenience** (hosting),
**governance** (`ee/`), **insight** (FinOps), **usage**, **support/SLA**, **compliance** — never the core.

## Revenue streams — ranked by what the market actually validates

The data-room competitor scan (`competitors/`) shows where money is actually made; ranked by leverage:

1. **Governance / Enterprise auth (`ee/`) — the engine.** Orgs · teams · SSO/SAML · custom roles · audit
   + retention/export · policy. **10 of 14 competitors gate RBAC/SSO/audit** behind their top tier — the
   single most-validated lever — at ~99% gross margin ([17](17-cost-model-and-pricing.md)). This, not
   usage, is the business. **Price it for the mid-market** (undercut Qovery's ~$1,999/mo governance floor)
   to win the SMB gap incumbents leave open.
2. **Hosted / managed convenience.** "We run the ~4-container control plane + the managed runner fleet —
   HA, backups, upgrades, SLA." Every SaaS competitor validates a $500–$2k/mo managed tier. This is the
   "don't self-host" line; for an AGPL company it is structurally dominant (you can always host your own
   code, so we sell *operating* it, not the code).
3. **FinOps / cost-governance — our whitespace.** *No competitor monetizes this, and we are uniquely built
   for it:* we already run Infracost ([E4](../../spec/features/mvp-roadmap/e4-cost-loop.md)), know
   per-spec / per-team spend, and control provisioning. Sell spend dashboards, **chargeback/showback**,
   drift-to-cost, right-sizing recommendations, and Savings-Plan/commitment coordination. Competitors ship
   only thin "billing analytics"; this is a differentiated **recurring** add-on aimed at the cost/lock-in
   buyer ([02](02-icp-personas.md)).
4. **Usage meters — EXPANSION, not the engine.** Two meters: **cloud-hosted runner-minutes** (we run the
   provisioning fleet → bill the compute) and **AI scans** ([11](11-ai-scanner-mcp.md), high marginal
   cost). Marked-up, **only when WE host the runner** (self-hosted runner = $0, by design). Keep it small
   with a **generous included allowance** so it never reads as the resented "double-billing" that drives
   churn at Porter/Qovery. **Never meter the customer's own workload compute — we already provisioned their
   cloud; double-billing their cloud bill is the #1 competitor churn trap.**
5. **Self-managed Enterprise license + support/SLA + compliance.** A **signed entitlement key** for
   air-gapped / sovereignty / AGPL-averse buyers who run `ee/` on-prem (annual, seat- or instance-tiered)
   — also the **dual-license escape** for orgs that ban AGPL. White-glove support/SLA priced in. The
   **compliance / zero-trust package** (SOC2-aligned audit, a "the control plane never stores your cloud
   keys" attestation/report) is unique whitespace: regulated buyers (fintech/health/public sector) pay for
   it and no competitor sells it, because no competitor has the zero-credential model by default.

> **The runner verdict** (is the packaged runner the best idea?). **Yes — keep it; it is the moat.**
> Runtime role-assumption with zero stored credentials is exactly what Render/Railway/Porter can't match
> and what regulated buyers require. But it is a **moat, not a revenue pillar**: runner-minutes only earn on
> the hosted fleet, the $/min is small, and over-metering it triggers the double-billing churn. Right split:
> **self-hosted runner = free (customer's compute); cloud-hosted runner fleet = part of the hosted tier**,
> with minutes as an *expansion* meter. (The multi-tenant fleet that assumes roles into many customer
> accounts is real ops/security work — see `08-runner-fleet-autoscaling`; it's justified only by the hosted
> tier, not by the meter alone.)

## Pricing tiers (hybrid — per-seat captures team value without compute double-billing)

| Tier | Who | What | Shape |
|---|---|---|---|
| **Community** | self-hosters, solo, homelab | full provisioning + integrations + community RBAC + RLS + SSE; single-tenant | **free** (AGPL, self-host) |
| **Team** (hosted) | scale-ups, growing teams | orgs/teams, RBAC, basic audit, hosted convenience, **generous included runner-minutes** | **per-seat** (~$20–40/seat/mo) + included usage allowance |
| **Enterprise** | regulated / large | SSO/SAML/SCIM, full audit + retention/export, multi-tenant, SLA, priority security, dedicated support; self-managed or hosted | **flat annual** (land ~$1k–$2.5k/mo; undercut the $1,999 incumbent governance floor) |
| **Add-ons** | any paid org | **FinOps / cost-governance module**; runner-minutes & AI-scan overage | flat (FinOps) + metered (usage) |

A generous hosted **Starter/individual** mirrors the self-host core as a funnel into Team/Enterprise.

**Why this shape wins** (vs the competitor failure modes in `competitors/`): per-seat scales with team
value the Vercel way without the per-vCPU "double-billing" resentment (Porter's churn); flat Enterprise is
predictable (vs Terraform Cloud's opaque per-resource meter); usage is upside, not the floor. It anchors to
the **$15k MRR mix** (~2 enterprise @ ~$2.5k + ~7 hosted teams + ~$2k usage — [16](16-market-and-fundraising.md))
— but the **engine is governance + hosting + FinOps, not the meters.**

## Competitive pricing rationale (do / don't)

- **Do** price governance for the **mid-market** — most incumbents gate SSO/RBAC/audit behind a high
  Enterprise floor (Qovery $1,999, Spacelift/TFC enterprise); a low Team-governance entry is open whitespace.
- **Do** lean on the three things competitors structurally can't: **ownership** (free self-host, no lock-in
  churn), **zero-trust** (compliance package), and **FinOps insight** (we have the cost + provisioning data).
- **Don't** bill the customer's own compute (per-vCPU/GB) — we already provisioned their cloud; that's the
  most-resented model and the clearest churn driver across the scan.
- **Don't** ship opaque resource-count meters (the TFC RUM perverse incentive); keep meters legible + capped.

## GTM motion

- **Community-led + ownership-led.** Land via OSS adoption and the self-hosting/own-your-stack crowd; expand
  to Team/Enterprise when a free self-hoster grows a team (hits the org boundary) or a buyer needs
  SSO/audit/compliance/FinOps.
- **Wedge → expand:** land on "own your control plane, zero stored credentials"; expand to governance +
  hosted + cost-governance.
- **Channels:** cloud-provider co-marketing (esp. cheaper/EU-native providers as multi-cloud breadth lands),
  OSS/GitOps/OpenTofu/Talos communities, `r/selfhosted` + awesome-selfhosted, EU founder/CTO networks.
  Trigger-based outbound on the buying signals in [02-icp-personas](02-icp-personas.md).

## Comparable open-core models

| Company | Core | Paid | Lesson |
|---|---|---|---|
| **Cal.com** | AGPL | `ee/` SSO/SAML/SCIM, platform | the closest twin — copy the AGPL+`ee/` structure |
| **GitLab** | MIT core, `ee/` | SSO, advanced RBAC, audit, SaaS | single codebase, `ee/` dir |
| **PostHog** | MIT | RBAC/SSO + usage-based cloud | broad free tier + pay-as-you-go |
| **Plausible** | AGPL | hosted + team UI only | sell *only* hosting + team mgmt |
| **Vercel** | (proprietary) | per-seat Pro + usage | per-seat "pay for the team" + metered usage — the hybrid shape |

**Recommendation:** model the license structure on **Cal.com** (AGPL core + `ee/` commercial +
Better-Auth-style pluggable identity), and the **pricing shape** on **Vercel** (per-seat team tier +
metered usage), adding the two lines those models lack: the **FinOps module** and the **runner-minutes**
compute meter.

## License hygiene (cross-ref [12](12-licensing-open-core.md))
CLA from day one (keeps the dual-license/commercial option alive); SPDX/REUSE + boundary-guard lint keep
the `ee/` line clean. The signed self-managed entitlement key replaces the dev-only `ALETHIA_LICENSE_ACTIVE`
env (see [07](07-auth-rbac-sso.md) + the billing build B1–B3).
