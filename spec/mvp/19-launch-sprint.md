# 19 — 30-Day Launch Sprint (stars · self-host users · first MRR)

The time-boxed GTM execution plan: in **30 days**, go public, win **GitHub stars +
Reddit/HN self-host users**, and land **first self-serve MRR**. This doc is the **tracker** —
work the checkboxes week by week. Strategy/messaging lives in
[`market-intel/docs/marketing-strategy.md`](../../../market-intel/docs/marketing-strategy.md)
and the launch copy in `market-intel/docs/launch/`.

> Source-of-truth rule applies: when a task ships, check it here, then propagate.

## Why these constraints (honest)

- The product **self-hosts + provisions AWS today** (the 5-min demo works — [13](13-user-flows.md)).
  GCP/Azure, multi-tenant orgs, SSO are partial ([04](04-feature-inventory.md), [15](15-mvp-scope-milestones.md)).
- The repo is still private (`bb-thesis-2026`) → **public migration to `alethialabs-io` is the launch gate.**
- **No billing in code yet.** Design exists in [14](14-gtm-pricing.md); the entitlement gate is
  the `ee/` `getEntitlements(scope)` seam ([07](07-auth-rbac-sso.md) §billing hook).

### Scope decision (what makes 30 days possible)
Billing ships as a **minimal self-serve slice**: **Stripe Checkout + webhook + a single-workspace
"Founding" plan** (the hosted Starter/individual funnel tier in [14](14-gtm-pricing.md)) gating
1–2 features. **Full multi-tenant orgs / SSO / Enterprise billing is deferred past day 30.** Without
this cut, 30 days does not hold.

---

## Week 1 (D1–7) — Harden + prep *(repo still private)*

**Product — make the hero flow flawless** *(blocks everything; → [E1](../features/mvp-roadmap/e1-hero-flow-hardening.md), [E5](../features/mvp-roadmap/e5-self-host-tier0.md))*
- [ ] Finish **E1**: GitOps failures fail loudly; `gitops_status` surfaced; connector pre-flight; the proof run (real AWS: connect → design → plan+cost → apply → EKS+ArgoCD wired → push reconciles → destroy).
- [ ] **E5 self-host one-click**: `docker compose up` + tested `deploy/install.sh` → dashboard in ≤10 min on a clean box.
- [ ] Record a **60–90s demo GIF/video** of the hero flow (the single most important launch asset).
- [ ] Tighten the **5-minute quickstart** (`apps/docs/.../self-hosting/index.mdx`) — copy-paste clean.

**Billing — start the slice** *(design → [14](14-gtm-pricing.md))*
- [ ] Create Stripe account; define products/prices: **Founding** (e.g. ~$19/mo or lifetime founder deal).
- [ ] Decide the 1–2 gated features (candidates: AI repo-scanner runs, extra Zones, FinOps preview).
- [ ] Schema: `workspace.plan` + `stripe_customer_id` + `stripe_subscription_id` (Drizzle pipeline per CLAUDE.md).

**Launch prep**
- [ ] Repo-migration checklist for `github.com/alethialabs-io/alethialabs`; audit hardcoded URLs (`get.alethialabs.io`, raw installer URL, Homebrew tap, docs links).
- [ ] Draft **Show HN** + **r/selfhosted** posts (in `market-intel/docs/launch/`).
- [ ] Draft **comparison page #1 — vs Porter** (from `competitors/porter.md`).
- [ ] GitHub repo prep: topics (`kubernetes opentofu argocd self-hosted devops`), description, social preview image, issue templates, `CONTRIBUTING`/CLA visible.

## Week 2 (D8–14) — Go public (soft) + checkout

**Go public**
- [ ] Migrate to **public `alethialabs-io/alethialabs`**; repoint all URLs; verify installer / Homebrew tap / docs links resolve.
- [ ] **README polish**: hero line, demo GIF, 5-min quickstart, badges (license, CI, stars), "anti-Porter" one-liner.
- [ ] Run `scripts/seed-launch-board.sh` → create the 4 milestones + issues (public roadmap = marketing).

**Soft launch (low-risk surfaces first)**
- [ ] Post to **r/selfhosted** (value-first; the "self-host your own control plane" angle).
- [ ] File the **awesome-selfhosted PR**.
- [ ] Triage feedback; fix the top 3 rough edges within 48h.

**Billing**
- [ ] **Stripe Checkout + webhook**; set `workspace.plan` on `checkout.session.completed`.
- [ ] Wire the `ee/` `getEntitlements` gate to the plan; gate the chosen feature(s).
- [ ] **Pricing page** (console + docs) with the Founding CTA.

**Content**
- [ ] Publish **vs Porter** + **vs Qovery** comparison pages (`apps/docs/.../compare/`).

## Week 3 (D15–21) — Big launch for stars + self-serve live

**The launch (this is the star engine)**
- [ ] **Show HN** Tue/Wed ~8–10am ET; **r/devops** + **r/kubernetes** staggered (not same hour); LinkedIn/X build-in-public thread.
- [ ] **Engage every comment for 48h** — fastest, most honest replies. (This converts views → stars more than the post itself.)
- [ ] Post in 2–3 relevant Slack/Discord (OpenTofu, ArgoCD, Talos, Karpenter) — participate, don't spam.

**Billing**
- [ ] **Self-serve checkout LIVE**; "Upgrade to Founding" CTA in console + pricing page; verify end-to-end with a real card (test mode → live).

**Content**
- [ ] **vs Spacelift** comparison + 1 SEO post: "Provision EKS without storing cloud credentials."

**Target: 200–500 stars by EOW.**

## Week 4 (D22–30) — Convert to MRR + iterate

- [ ] Drive launch traffic → free signups → **paid Founding subscriptions** (founder/lifetime discount to seed first payers).
- [ ] Backstop revenue: close **1–2 manual paid design-partner pilots** (invoice; use `market-intel/docs/outreach/design-partner-offer.md`).
- [ ] Ship **1 community-requested quick win**; reply to all issues; thank contributors.
- [ ] **Metrics review**; hit the **first-MRR milestone**.

---

## KPI table (update weekly)

| Metric | Baseline | W1 | W2 | W3 | W4 | Target |
|---|---|---|---|---|---|---|
| GitHub stars | 0 | | | | | **200–500** |
| HN points / Reddit upvotes | — | | | | | top-of-page |
| Docker pulls / installs | 0 | | | | | trending |
| Free signups | 0 | | | | | 50–150 |
| Free → paid (Founding) | 0 | | | | | **≥3** |
| Design-partner pilots (paid) | 0 | | | | | **1–2** |
| **MRR** | $0 | | | | | **first $** |

## Tracking
- This doc = source of truth. Promote to a **GitHub Projects (v2)** board + 4 weekly **Milestones**
  via `scripts/seed-launch-board.sh` once public. A public roadmap is itself build-in-public marketing.
- Definition of done per week = all that week's boxes checked + KPI row filled.

## Risks (flagged, not hidden)
- **Critical path = E1 hardening (W1).** If the hero flow isn't flawless, delay the public launch — a
  broken first impression costs more than a week.
- **Billing = minimal slice only.** First MRR is a few Founding subs + manual pilots, not scaled revenue.
- **Weak launch** is the main marketing risk — mitigated by: harden first · crisp demo GIF · the
  anti-Porter / zero-stored-credentials narrative · 48h hands-on engagement.
- 30 days solo is aggressive; if a week slips, cut content scope before product hardening.
