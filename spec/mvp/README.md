# MVP Specification — Trellis

This folder defines the MVP for the Trellis product launch. It serves as the single source of truth for two deliverables:
1. **Landing page** — public-facing page at `apps/trellis/app/page.tsx`
2. **Pitch deck** — content and narrative for investor/stakeholder presentations

---

## Document Map

| File | Purpose | Feeds Into |
|------|---------|-----------|
| [01-product-vision.md](01-product-vision.md) | Brand narrative, problem/solution pillars, viticulture lexicon, target audience, open source statement | Landing: hero copy, badge, tagline. Pitch: slides 1-3 (title, problem, solution) |
| [02-feature-inventory.md](02-feature-inventory.md) | Complete SHIPPED / IN-PROGRESS / PLANNED matrix with file-level evidence | Landing: feature cards, stats, provider grid. Pitch: features slide, credibility, roadmap |
| [03-cli-reference.md](03-cli-reference.md) | Full CLI command tree (shipped) + envisioned commands (from Trellis mapping) + code examples | Landing: hero terminal, code examples tabs. Pitch: developer experience, demo script |
| [04-landing-page-spec.md](04-landing-page-spec.md) | Section-by-section design spec (9 sections, ai-sdk.dev inspired) | Landing: this IS the implementation spec |
| [05-architecture-overview.md](05-architecture-overview.md) | System topology, security model, data model, tech stack | Landing: tech credibility. Pitch: architecture, security, tech stack slides |
| [06-user-flows.md](06-user-flows.md) | 6 user journeys: setup, web provision, CLI workflow, worker, teardown, multi-cloud duplication | Landing: "How It Works" section. Pitch: demo narrative, user journey slide |
| [07-competitive-positioning.md](07-competitive-positioning.md) | Market landscape vs Terraform Cloud, Spacelift, Pulumi, Env0, Port | Landing: implicit differentiation in copy. Pitch: "Why Trellis" slide |

---

## Corrections from Previous Pitch Deck

The existing `pitch_deck.md` (root of repo) is outdated. This spec supersedes it. Key corrections:

| Old Pitch Deck Says | Actual Status |
|--------------------|--------------| 
| "Multi-Cloud: Extending Vines to Azure and GCP" (Roadmap) | **SHIPPED** — AWS/GCP/Azure with full feature parity, provider ribbon, onboarding for all three |
| "Cost Estimation: Native Infracost integration" (Roadmap) | **SHIPPED** — Real-time cost sidebar in Plant a Vine form, Infracost integration in worker |
| "Standardized Templates: AWS & EKS blueprints" | **Undersold** — Supports EKS, GKE, and AKS with 12 infrastructure service categories per cloud |
| "Tendril Agent lives inside your secure perimeter" | **DEPRECATED** — Replaced by Grape Worker pull model. Tendril is historical context only. |
| "Vintner AI: Integrated AI knowledge base" (Roadmap) | **Not started** — Vintner is the docs site (Fumadocs), no AI features yet |

---

## Freshness Rule

This folder is the canonical product truth. When the landing page copy, pitch deck slides, or any marketing content conflicts with these specs, update the content to match the specs — not the other way around.

When features ship or change status, update `02-feature-inventory.md` first, then propagate to other files as needed.

---

## Cross-Reference: Landing Page Sections → Source Files

| Landing Page Section | Primary Spec | Secondary |
|---------------------|-------------|-----------|
| 1. Header | 04-landing-page-spec.md | — |
| 2. Hero (badge, headline, terminal, providers) | 04-landing-page-spec.md | 01-product-vision.md, 03-cli-reference.md |
| 3. How It Works (3 steps) | 04-landing-page-spec.md | 06-user-flows.md |
| 4. Feature Cards (3x3 grid) | 04-landing-page-spec.md | 02-feature-inventory.md |
| 5. Code Examples (3 tabs) | 04-landing-page-spec.md | 03-cli-reference.md |
| 6. Infrastructure Stack (service grid) | 04-landing-page-spec.md | 02-feature-inventory.md |
| 7. Stats Strip (4 numbers) | 04-landing-page-spec.md | 02-feature-inventory.md |
| 8. Install CTA | 04-landing-page-spec.md | 03-cli-reference.md |
| 9. Footer | 04-landing-page-spec.md | 01-product-vision.md |

## Cross-Reference: Pitch Deck Slides → Source Files

| Pitch Deck Slide | Primary Spec | Secondary |
|-----------------|-------------|-----------|
| Title + Tagline | 01-product-vision.md | — |
| The Problem (3 pillars) | 01-product-vision.md | 07-competitive-positioning.md |
| The Solution (3 pillars) | 01-product-vision.md | 02-feature-inventory.md |
| Architecture | 05-architecture-overview.md | — |
| Security (zero-credential) | 05-architecture-overview.md | 02-feature-inventory.md |
| Features / Demo | 02-feature-inventory.md | 03-cli-reference.md, 06-user-flows.md |
| Multi-Cloud Story | 02-feature-inventory.md | 05-architecture-overview.md |
| Developer Experience (CLI) | 03-cli-reference.md | 06-user-flows.md |
| Why Trellis (differentiation) | 07-competitive-positioning.md | — |
| What's Built (credibility) | 02-feature-inventory.md | — |
| Roadmap (genuine future only) | 02-feature-inventory.md | PLANNED items only |
| Closing | 01-product-vision.md | — |
