# Alethia by Alethia Labs — MVP Specification

This folder is the **source of truth** for the Alethia MVP — product vision, architecture, decisions, and roadmap. It supersedes the thesis-era "Trellis" docs. When marketing copy, code comments, the dashboard, or the pitch conflict with these specs, **update them to match the specs**, not the other way around.

> **Status:** reconsolidation in progress. Docs are produced in dependency-ordered waves (see [15-mvp-scope-milestones](15-mvp-scope-milestones.md)). The map below marks which are written.

## Terminology (active standard)

Alethia uses this lexicon throughout. Full standard + migration map: [A-rename-lexicon](A-rename-lexicon.md).

| Term | Is | (was) |
|---|---|---|
| **Alethia** | The core product ecosystem / platform layer | alethia |
| **alethia** | The primary developer CLI | alethia |
| **runners** | Distributed background workers / runtime execution agents | runners |
| **Zones** | Isolated environments, workspaces, or project clusters | vineyards |
| **Specs** | Configuration files, manifests, declarative state definitions | vines |

## What Alethia is

An **open-source, self-hostable, multi-cloud, zero-trust** Kubernetes infrastructure control plane: design a **Spec**, provision any cloud from a remote **runner** with **zero stored credentials**, plug in the tools you already use, and **own the whole stack** — control plane included.

The four pillars: zero-trust remote provisioning (shipped) · self-hostability (no Supabase lock-in) · pluggable integrations · multi-cloud breadth. License: **AGPL-3.0**, open-core.

## Document map

| # | Doc | Purpose | Status |
|---|---|---|---|
| 00 | [00-README](00-README.md) | This index, terminology, source-of-truth rule | ✅ |
| 01 | [01-product-vision](01-product-vision.md) | Vision; lead with buyer pain + ownership; 4 pillars | ✅ |
| 02 | [02-icp-personas](02-icp-personas.md) | ICP + personas + buying triggers | ✅ |
| 03 | [03-competitive-positioning](03-competitive-positioning.md) | vs TFC/Spacelift, Qovery/Porter/Northflank, Crossplane, Cloudfleet/Syself, DIY | ✅ |
| 04 | [04-feature-inventory](04-feature-inventory.md) | SHIPPED vs TO-BUILD, grounded on real code | ✅ |
| 05 | [05-architecture-overview](05-architecture-overview.md) | Topology, zero-trust split, two-axis model, data model | ✅ |
| 06 | [06-self-hosting-architecture](06-self-hosting-architecture.md) ⭐ | The de-Supabase plan (DB/RLS, Auth, Realtime, Storage) | ✅ |
| 07 | [07-auth-rbac-sso](07-auth-rbac-sso.md) ⭐ | PDP → OpenFGA, RLS backstop, orgs/SSO, open-core seams | ✅ |
| 08 | [08-integrations-extensibility](08-integrations-extensibility.md) ⭐ | Pluggable per-category providers | ✅ |
| 09 | [09-multi-cloud-cluster-strategies](09-multi-cloud-cluster-strategies.md) | Provider breadth; managed vs self-managed strategies | ✅ |
| 10 | [10-opentofu-migration](10-opentofu-migration.md) | Terraform → OpenTofu ADR + mechanical plan | ✅ |
| 11 | [11-ai-scanner-mcp](11-ai-scanner-mcp.md) | Repo→Spec scanner + MCP layer (roadmap; scope TBC) | ✅ |
| 12 | [12-licensing-open-core](12-licensing-open-core.md) | AGPLv3 ADR + the `ee/` open-core mechanism | ✅ |
| 13 | [13-user-flows](13-user-flows.md) | Hero flow + self-host install + integrations | ✅ |
| 14 | [14-gtm-pricing](14-gtm-pricing.md) | Open-core revenue, pricing, channels | ✅ |
| 15 | [15-mvp-scope-milestones](15-mvp-scope-milestones.md) | Scope, milestones, risk register | ✅ |
| 16 | [16-market-and-fundraising](16-market-and-fundraising.md) | TAM/SAM/SOM, comparables, the raise + GTM | ✅ |
| 17 | [17-cost-model-and-pricing](17-cost-model-and-pricing.md) | Infra-grounded COGS, unit economics, pricing tiers | ✅ |
| A | [A-rename-lexicon](A-rename-lexicon.md) | Terminology standard + rename migration map | ✅ |

⭐ = the three docs carrying the core thesis (self-hostability, enterprise auth, integrations).

## Source-of-truth rule

These specs are canonical. When a feature ships or a decision changes, update the relevant spec **first**, then propagate to landing page / pitch / code. The old thesis-era docs (`01-product-vision`, `02-feature-inventory`, `03-cli-reference`, `04-landing-page-spec`, `05-architecture-overview`, `06-user-flows`, `07-competitive-positioning`, old `README`) are being reconsolidated/renumbered into the set above and relocated where they are implementation artifacts (CLI reference, landing-page spec).
