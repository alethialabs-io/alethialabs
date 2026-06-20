# 16 — Market & Fundraising

Sourced market sizing + comparable raises + the fundraising/GTM strategy. **All forward / Alethia-specific figures are estimates to validate** (flagged). Research date 2026-06-16.

## Market sizing (TAM / SAM / SOM)

Alethia sits at the intersection of **IDP / Platform Engineering + IaC + managed-Kubernetes** — no single clean category, all compounding at a consistent **~22–25% CAGR**.

| Market (anchor) | Now | Forecast | CAGR | Source |
|---|---|---|---|---|
| **Platform Engineering / IDP** (TAM anchor) | $10.4B (2026) | $31.6B (2031) | 24.8% | Mordor |
| PaaS (expansive envelope) | $89.8B (2024) | $287.8B (2030) | 21.8% | Grand View |
| IaC | $1.3B (2025) | $9.4B (2034) | 24.4% | Precedence |
| Kubernetes management | $3.1B (2026) | $8.4B (2031) | 21.9% | Mordor |

- **TAM ≈ $10B (2026) → ~$32B (2031)** — IDP/Platform-Engineering basis (conservative); expansive PaaS view $90B→$288B.
- **SAM ≈ $80–120M/yr** — paying BYOC / self-host / zero-trust K8s buyers: ~7,000 target orgs (≈30–58k software cos × **82% run K8s** × ~15–20% self-host/BYOC sweet-spot) × **~$12k** blended ACV. Bottom-up (~$84M) and top-down (IDP TAM × ~1% ≈ $100M) agree.
- **SOM (3 yr) ≈ $2–3.5M ARR** (~2–4% of SAM). **Year-1 = $180k ARR / $15k MRR ≈ 12–15 paying orgs** — only ~0.2% of SAM, i.e. conservative and achievable.

**Demand validation:** 82% of container users run K8s in production (CNCF 2025, up from 66% in 2023); **ArgoCD is the majority-adopted GitOps solution** (CNCF) — "EKS + ArgoCD wired to your Git" is the stack buyers already want; EKS ≈30% of managed K8s (~2M customers).

**ACV anchor:** Porter (~$6/GB + ~$13/vCPU metered ≈ ~$1k/mo for a modest prod footprint); Qovery ($899–$1,999/mo per org, SSO/RBAC at Business+). Alethia commercial = `ee/` seats + hosted + usage (runner-minutes, AI) → blended **$10–15k ACV**. OSS self-hosters pay $0 (top-of-funnel) — SAM is sized on *paying* orgs only.

**Biggest validation risks:** the ~15–20% BYOC/self-host share; the blended ACV; the OSS-install→paid conversion rate (drives the whole SOM funnel).

## Comparables

| Company | Stage | Raised | Valuation | Model |
|---|---|---|---|---|
| **Porter** | Series A ('21) | ~$21.5M | n/d | proprietary PaaS in your cloud |
| **Qovery** | Series A (Sep '25) | ~$18M | n/d | BYOC IDP |
| **Northflank** | Series A (Nov '24) | ~$25M | n/d | BYOC/hosted PaaS |
| **Spacelift** | Series B | ~$23M | n/d | IaC orchestration |
| **Upbound** (Crossplane) | Series B | ~$69M | n/d | OSS control plane + commercial |
| **Render** | Series C+ (Feb '26) | ~$258M | **$1.5B** | managed PaaS (own infra) |
| **Railway** | growth (Jan '26) | ~$115M | ~$409M | managed PaaS (own infra) |
| **env0** | Series A | ~$42M | n/d | IaC env automation |
| **Garden.io** | Series A | ~$20M | n/d | OSS K8s dev/test |
| **Plural** | Seed ('25) | ~$12M | n/d | AI K8s mgmt |
| **Kubefirst** / Konstruct | **acquired by Civo** ('24) | — | — | OSS GitOps cluster bootstrapper (closest analog) |
| **Coolify / Dokploy** | **bootstrapped** | $0 VC | — | OSS self-host PaaS + paid cloud |

Closest analogs: **Porter** (PaaS-in-your-cloud, proprietary), **Kubefirst** (OSS GitOps bootstrapper — exited via acquihire), **Coolify/Dokploy** (validate the AGPL-self-host + paid-cloud open-core model). Render/Railway are *not* analogs — own-infra "rent a black box," exactly what Alethia positions against.

## Fundraising benchmarks (2025–26)

| Stage | Round | Valuation | Dilution | ARR |
|---|---|---|---|---|
| Pre-seed | ~$1M SAFE | ~$5–6M post (median); $10–15M cap | ~15–25% | pre-rev – <$100k |
| Seed | ~$3–4M | ~$20M post (median; Q4'25 high) | ~12–20% | $0–500k |
| Series A | ~$5–15M | ~$79M post (Q4'25) | — | $1–2M+ floor, 120%+ growth |

- **COSS premium (real, compounding):** open-source companies raise **1.45× more at seed**, reach Series A ~20% / B ~34% faster, and exit at a **$482M median vs $34M** for proprietary (Serena).
- **AI premium:** ~1.3× deal size, ~1.6× valuation. GitHub stars / OSS adoption = the de-facto seed traction proxy.

## The raise — at ~$15k MRR

$180k ARR sits **above the pre-seed bar, below the median seed bar on revenue alone** — but a genuine PMF signal that materially de-risks the round.

- **Recommended (the founder's "small % at high valuation"):** **~$1.5M on a post-money SAFE at a ~$12–15M cap → ~10–12% dilution.** Enough to make the key hires + ship self-hosting + `ee/` + V2; well under the ~18% dilution guardrail; clean cap table for Series A.
- *Faster alternative:* ~$3–4M at ~$18–20M post → ~18–20% — only if pushing hard for category dominance with a plan to deploy $3M.
- **Instrument:** post-money SAFE, valuation-cap only, no discount stack (2025 default). **Incorporate first** (Delaware C-corp) — gating action item.

**Use of funds:** self-host **25%** · enterprise auth + `ee/` **20%** · integration backends **15%** · V2 day-2 console **15%** · GTM / community / devrel (first non-eng hire) **15%** · first infra engineer + buffer **10%**.
**First hires:** founding devrel/GTM (feeds the only funnel you have), then a senior infra/platform engineer (de-risk the bus-factor-of-one).

## GTM — the path to $15k MRR

The model is **open-core**, bound by the **free-management-layer floor**: you *cannot sell the AGPL core* (anyone self-hosts it free; the control plane never holds cloud creds). Revenue = **hosting** (operate it for them) + **`ee/`** (orgs/SSO/RBAC/audit) + **usage** (runner-minutes, AI) + **support**. OSS = distribution + credibility, not the invoice.

**Funnel:** `GitHub stars / reach → self-host installs → hosted signups → activated clusters → paid teams (design partners) → enterprise (SSO/RBAC/audit)`. OSS free→paid conversion is **low (~0.5–3%)** — the funnel must be *wide*, but $15k MRR needs the *right mix*, not scale.

**Recommended mix to $15k (≈12–15 accounts):** ~2 enterprise/anchor @ ~$2.5k/mo + ~7 hosted teams @ ~$0.9–1.2k/mo + ~$2k usage/AI. No single account >~17%.

**Levers (priority):** ① activation = **time-to-first-cluster** (the metric that predicts revenue) · ② the "operate it for you" hosted wedge · ③ SSO/RBAC/audit = the enterprise paywall · ④ runner-minutes + AI usage meter (NRR) · ⑤ design partners > self-serve early.

## Why bootstrap to $15k *then* raise

- **De-risk the biggest unknown — pull.** $15k MRR from ~12 real companies *is the proof*; pre-revenue you're selling a thesis.
- **Leverage on valuation + terms** — raise a *small* slice at the *top* of the range, keep dilution under ~18%, retain control.
- **The COSS premium compounds** — bootstrapping matures the community metric that unlocks it.

**Trade-offs:** slower (9–18 mo of unfunded grind, est.); founder-runway risk; under-resourced exactly when speed matters.
**When NOT to wait:** a credible competitor races to the "open-EKS-platform" narrative · a hard wall (self-hosting/auth) blocks *already-sourced* paying deals · pre-emptive inbound from a fund you'd want, at a thesis-reflecting valuation · personal runway < ~3 months.

## Milestones that unlock the raise

- **Revenue:** ~$15k MRR / $180k ARR · ≥10–12 paying accounts (none >~20%) · ≥1–2 enterprise on `ee/` SSO/RBAC/audit · NRR trending >100% · visible free→paid in/above the 1–3% band.
- **Product:** AGPL-clean self-host shipped (self-host "~4 containers" works for strangers — *this legitimizes the OSS metrics*) · `ee/` enterprise auth in production with a paying customer · multi-cloud real (AWS solid + a credible 2nd) · tight time-to-first-cluster.
- **Community:** GitHub *trajectory* (slope > absolute), installs, contributors, active community.

**The narrative at that point:** *"A solo founder bootstrapped a zero-trust, open-source EKS platform to $180k ARR with a real community, capital-efficiently, and is raising a small round to pour fuel on a fire that's already lit."* — the profile that commands the top of valuation, bottom of dilution.

## Sources (key)

- Markets: Mordor [IDP](https://www.mordorintelligence.com/industry-reports/platform-engineering-and-internal-developer-platform-idp-market) · [Kubernetes](https://www.mordorintelligence.com/industry-reports/kubernetes-market) · Grand View [PaaS](https://www.grandviewresearch.com/industry-analysis/paas-market-report) · Precedence [IaC](https://www.precedenceresearch.com/infrastructure-as-code-market) · CNCF [2025 survey (82%)](https://www.cncf.io/announcements/2026/01/20/kubernetes-established-as-the-de-facto-operating-system-for-ai-as-production-use-hits-82-in-2025-cncf-annual-cloud-native-survey/) · [Argo CD GitOps](https://www.cncf.io/announcements/2025/07/24/cncf-end-user-survey-finds-argo-cd-as-majority-adopted-gitops-solution-for-kubernetes/)
- Benchmarks: [Carta pre-seed 2025](https://carta.com/data/state-of-pre-seed-2025/) · [Carta Q4'25](https://carta.com/data/state-of-private-markets-q4-2025/) · [Rebel Fund dilution](https://www.rebelfund.vc/blog-posts/founder-dilution-benchmarks-seed-2025-stay-under-18-percent) · [Serena COSS study](https://tech.eu/2025/04/10/serena-study-shows-open-source-beats-proprietary-in-funding-speed-valuation-and-exit-success/)
- ACV anchors: [Porter pricing](https://www.porter.run/pricing) · [Qovery pricing](https://www.qovery.com/pricing)
- Comparable raises: see each file in [`competitors/`](competitors/) + Render [$1.5B](https://venturebeat.com/business/render-raises-100-million-series-c-extension-at-15-billion-valuation-to-build-the-cloud-for-ai-native-software) · Qovery [$13M A](https://www.finsmes.com/2025/09/qovery-raises-13m-in-series-a-funding.html) · Upbound [$60M B](https://www.upbound.io/newsroom/upbound-raises-60m-in-funding-from-altimeter-capital-gv-intel-capital-and-others-to-advance-its-universal-cloud-management-platform)

## Caveats

All Alethia-specific figures (TAM/SAM/SOM, ACV, account counts, revenue mixes, use-of-funds %, timeline) are **estimates reasoned from the model + comparable pricing, not observed data**. Most comparable valuations are undisclosed; funding-tracker revenue figures are modeled, not audited. Validate the three SOM-driving assumptions before relying on the numbers in a raise.
