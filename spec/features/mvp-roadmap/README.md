# MVP Roadmap — Epics

Cross-cutting roadmap from the **current built state** (the platform is 85–95% built; this tracks
the *remaining* work to a launchable MVP), not the abstract M0–M5 milestones in `spec/mvp/`.

**MVP = a self-hostable OSS control plane whose AWS hero flow is bulletproof, plus the `ee/`
orgs/teams/SSO/RBAC tier real enough to sell.** Locked: AWS-deep first · orgs+teams+SSO are in MVP ·
AI scanner deferred.

## Epics

| # | Epic | Community/ee | Lane | Status |
| --- | --- | --- | --- | --- |
| **E1** | [Hero flow: AWS E2E hardening + proof](e1-hero-flow-hardening.md) | community | this instance | ▶ active |
| **E2** | Identity · Orgs · Teams · SSO · RBAC | community + **ee/** | other instance (FGA-*) | in flight ~85–95% |
| **E3** | Pluggable integrations: finish + verify | community | other instance | in flight |
| **E4** | [Cost estimation: close the loop](e4-cost-loop.md) | community | this instance | todo |
| **E5** | [Self-host distribution: Tier-0 launch-ready](e5-self-host-tier0.md) | community | this instance | todo |
| **E6** | Runner fleet & autoscaling | community/hosted | this instance | todo (lower prio) |
| **E7** | [Licensing & open-core hygiene](e7-licensing.md) | cross-cutting | this instance | todo |
| **E8** | Multi-cloud breadth + cluster strategies | community | — | post-MVP |
| **E9** | AI repo-scanner + MCP | **ee/** metered | — | post-MVP |
| **E10** | Hosted SaaS (alethialabs.io) | **ee/** | — | post-MVP |

> E2 (auth/orgs/SSO) and E3 (connectors) are the other instance's active lanes — see
> `spec/features/control-plane/` + the `lib/authz/`, `ee/`, `packages/core/categories/` code and
> the `FGA-*` commit trail. Not duplicated here to avoid collision.

## MVP Definition of Done (launch gate)
- [ ] One real AWS account: connect → design → plan (+ live cost) → apply → **real EKS + ArgoCD
      wired to a git repo (push→deploy)** + outputs in dashboard → `destroy`. **Validated, not assumed.**
- [ ] `docker compose up` self-host boots the whole stack; a fresh operator completes the above.
- [ ] Orgs/teams/SSO/RBAC usable + **license-gated by a real entitlement check** (not an env var).
- [ ] Cost shown live in the designer from real Infracost output (E4).
- [ ] `eslint` / `check-types` / `go test` / `go build` green; AGPL + `ee/` boundary CI passing (E7).
- ⛔ Out of MVP: GCP/Azure verified, self-managed clusters, AI scanner, hosted SaaS, day-2 ops.

## "Better than spec" notes
1. **E1 is the real launch blocker** and isn't a clean spec milestone — the spec calls provisioning
   "shipped," but the ArgoCD/GitOps bootstrap silent-fails and the flow is unvalidated post
   OpenTofu/de-Supabase. Make E1 the spine.
2. **Cost (E4)** is believed-working but disconnected between runner (real Infracost) and console
   (`estimated_monthly_cost` display) — cheap fix, headline-screenshot credibility.
3. **License entitlement (E2)** is an env-var placeholder; the whole monetization model rests on it.
4. **Connector pre-flight verify** — small change, fail-fast UX payoff.
