# 18 — Repository Structure & Naming

The canonical map of where everything lives. The key idea: **two layers, kept deliberately separate** — the *product lexicon* (what users say) and the *code structure* (folders named by component **role**, not by brand).

## The two layers

**Product lexicon (user-facing):** **Alethia** (the platform) · `alethia` (the CLI) · **runners** (the workers) · **Zones** (workspaces / environments) · **Specs** (declarative configs / manifests).

**Code structure (by role):**
```
alethialabs/                  the repo — the product "Alethia", company Alethia Labs OÜ
├── apps/
│   ├── console/              Web control plane — dashboard + API ("Alethia Console")
│   ├── cli/                  The developer CLI (Go) → binary `alethia`
│   ├── runner/               The worker that executes provisioning (instances = "runners")
│   └── docs/                 Public product docs (Fumadocs) — the ONLY public surface
├── packages/
│   ├── core/                 Shared Go lib: cloud abstraction, OpenTofu exec, provisioning
│   ├── ui/                   Shared React components (the design system)
│   ├── enterprise/           Commercial `ee/` — orgs/SSO/RBAC/OpenFGA/audit  ⟵ to create
│   ├── charts/               Helm charts
│   └── eslint-config, typescript-config
└── (legacy-cli/              dead Python CLI — to remove)
```

## Lexicon ↔ code mapping

| Lexicon | What it is | Lives in code as |
|---|---|---|
| **Alethia** | the product / brand | the repo (`alethialabs`) — *not* a folder |
| **`alethia`** | the CLI | `apps/cli` → binary `alethia` |
| Console | the web control plane | `apps/console` |
| **runner** | the worker | `apps/runner`; runtime instances = runners; DB table `runners` |
| **Zone** | workspace / environment | **entity** → DB table `zones`, types — *not* a folder |
| **Spec** | config / manifest | **entity** → DB table `specs`, type `SpecConfig` — *not* a folder |
| — | shared Go lib | `packages/core` |
| — | commercial tier | `packages/enterprise` (`ee/`) |

## Why folders are named by role, not brand

The brand is **Alethia** — the *whole thing*. Naming a folder `alethia` would lose information, because everything is Alethia. So folders are named by **role**: `console` (the web console), `cli` (the command line), `runner` (the worker), `core` (the shared lib). This is the standard monorepo pattern and keeps each component's purpose obvious at a glance. **Decision: the web app stays `apps/console` ("Alethia Console").**

## Zones & Specs are entities, not folders

A **Zone** is a workspace a user *creates*; a **Spec** is a config a user *writes*. They are runtime/domain objects — they live as **DB tables + types**, never as `apps/` or `packages/`. (You wouldn't have an `apps/specs` any more than a SaaS has an `apps/users`.) So they correctly do **not** appear in the folder tree — they appear in the schema (`zones`, `specs` tables) and the types.

## Path to full coherence (the deferred entity rename)

The **folders** are renamed (PR #45: `console`/`cli`/`runner`/`core`, `ALETHIA_*` env, module `github.com/alethialabs-io/alethialabs`). The **entities are not yet** — the code still uses `VineConfig` and DB tables `vineyards`/`vines`/`tendrils`. **That** is the only real incoherence today. Finishing the **DB/wire rename** makes it consistent top-to-bottom:

| In code today | Target |
|---|---|
| `vineyards` table | `zones` |
| `vines` table / `VineConfig` | `specs` / `SpecConfig` |
| `tendrils` table | `runners` |
| `/api/tendrils` route, `json:"tendril"` | `/api/runners`, `json:"runner"` |
| cobra `vine` / `vineyard` / `tendril` cmds | `spec` / `zone` / `runner` |

This is the deferred DB/wire pass tracked in [A-rename-lexicon](A-rename-lexicon.md). **Until it lands, expect the split:** folders / binaries / env = Alethia lexicon; DB / API / Go types = the old Vine/Vineyard/Tendril names. (Deferred because these are data/wire-format coupled — see [06-self-hosting-architecture](06-self-hosting-architecture.md) for the de-Supabase + types regen that this rides along with.)

_Cross-refs: [05-architecture-overview](05-architecture-overview.md) (runtime topology) · [A-rename-lexicon](A-rename-lexicon.md) (the rename + blast radius)._
