# 14 — Go-To-Market & Pricing

Open-core revenue, grounded in the `ee/` boundary ([12](12-licensing-open-core.md)) and the authz/orgs paid line ([07](07-auth-rbac-sso.md)).

## Revenue lines

1. **Hosted Alethia Cloud (multi-tenant SaaS) — primary.** We run Alethia (the `ee/` multi-tenancy makes it possible). Sell convenience: zero ops, managed Postgres/S3, managed runner fleet, SSO/RBAC/audit by tier. For an AGPL company this is the dominant line — you can always host your own code, and §13 stops competitors out-hosting you.
2. **Self-managed Enterprise license.** For teams that must self-host (sovereignty, air-gapped, AGPL-averse legal) but need governance — they run `ee/` on-prem under the commercial license + a signed entitlement. Also the **dual-license escape** for enterprises that ban AGPL outright. Annual, seat- or instance-tiered, with support/SLA.
3. **Usage-based.** Two natural meters: **AI premium** (repo-scanner/MCP — [11](11-ai-scanner-mcp.md), high marginal cost → metered) and **cloud-hosted worker-minutes** (we run the runner fleet that provisions → bill compute). Stacks on top of seats.

## Pricing tiers

| Tier | Who | What | Shape |
|---|---|---|---|
| **Community** | self-hosters, solo, homelab | full provisioning + integrations + community RBAC + RLS + SSE; single-tenant | **free** (AGPL, self-host) |
| **Team** (hosted) | scale-ups | orgs/teams, RBAC, basic audit, SSE, hosted | per-seat |
| **Enterprise** | regulated / large | SSO/SAML/SCIM, full audit + retention/export, multi-tenant, SLA, priority security; self-managed or hosted | annual contract |

A generous hosted **Starter/individual** mirrors the self-host core as a funnel into Team/Enterprise.

## The "free-management-layer floor" risk (name it)

The core is a free management layer over the customer's **own** cloud spend — a self-hoster pays $0. **You cannot sell the core.** Sell *convenience* (hosted), *governance* (`ee/`: orgs/SSO/RBAC/audit/multi-tenant), *support/SLA*, and *usage* (AI, worker-minutes). Plan finances around enterprise/hosted ACVs + the worker-minutes meter — not on monetizing self-hosters (you won't, by design — and that's the trust that fuels the funnel).

## GTM motion

- **Community-led + ownership-led.** Land via OSS adoption and the self-hosting/own-your-stack crowd; expand to Team/Enterprise when a free self-hoster grows a team (hits the org boundary) or a buyer needs SSO/audit.
- **Wedge → expand:** land on "own your control plane, zero stored credentials"; expand to governance + hosted.
- **Channels:** cloud-provider co-marketing (esp. cheaper/EU-native providers as multi-cloud breadth lands), OSS/GitOps/OpenTofu/Talos communities, `r/selfhosted` + awesome-selfhosted, EU founder/CTO networks. Trigger-based outbound on the buying signals in [02-icp-personas](02-icp-personas.md).

## Comparable open-core models

| Company | Core | Paid | Lesson |
|---|---|---|---|
| **Cal.com** | AGPL | `ee/` SSO/SAML/SCIM, platform | the closest twin — copy the AGPL+`ee/` structure |
| **GitLab** | MIT core, `ee/` | SSO, advanced RBAC, audit, SaaS | single codebase, `ee/` dir |
| **PostHog** | MIT | RBAC/SSO + usage-based cloud | broad free tier + pay-as-you-go |
| **Plausible** | AGPL | hosted + team UI only | sell *only* hosting + team mgmt |

**Recommendation:** model on **Cal.com** (AGPL core + `ee/` commercial + Better-Auth-style pluggable identity), and add the **worker-minutes meter** as the compute-proportional line Cal.com lacks.

## License hygiene (cross-ref [12](12-licensing-open-core.md))
CLA from day one (keeps the dual-license/commercial option alive); SPDX/REUSE + boundary-guard lint keep the `ee/` line clean.
