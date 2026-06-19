# Alethia Terminology Standard & Migration Map

The authoritative naming standard. The product is **Alethia**, by **Alethia Labs**. The name has moved twice (thesis-era → Vertex → **Alethia**); this is the only document that references the deprecated names — everything else in `spec/mvp/` is written in the active lexicon.

## Brand

| | |
|---|---|
| Product / platform | **Alethia** |
| Company | **Alethia Labs** (legal entity **Alethia Labs OÜ**) |
| Domain | `alethialabs.io` (contact at `/contact`) |
| GitHub org | `github.com/alethialabs-io` |
| Contact | `inquiry@alethialabs.io` |
| License | AGPL-3.0 core, open-core (see [12-licensing-open-core](12-licensing-open-core.md)) |

## Terminology — active standard

| Deprecation chain | **Active** | Role |
|---|---|---|
| trellis → Vertex → | **Alethia** | The product / platform / web control plane |
| grape → vtx → | **`alethia`** | The developer CLI |
| tendrils → Nodes → | **runners** | Distributed background runners / runtime execution agents |
| vineyards → | **Zones** | Isolated environments / workspaces / project clusters |
| vines → | **Specs** | Configuration files / manifests / declarative state |
| (company) Alethia → | **Alethia Labs** | The company / AGPL copyright holder |
| grape-core / vertex-core → | **alethia-core** | Shared Go library (`packages/`) |

These are **locked**. Zones and Specs are unchanged. `harvest → alethia apply` remains the proposed deploy verb.

## ⚠️ Code reality (the rename landed in code; DB/wire names deferred)

The Vertex → Alethia rename **landed in the codebase** on branch `rename/vertex-lexicon` (**PR #45**, unmerged, stacked on the design PR), with an open-core AGPL licensing commit. Renamed in code:

- **Dirs:** `apps/console` (web), `apps/cli` (binary `alethia`), `apps/runner` (the **Runner** runner), `packages/core`.
- **Env** `ALETHIA_*`; cache `~/.alethia`; **Go module** `github.com/alethialabs-io/alethialabs`; GHCR `alethialabs-io/{console,runner}`; `AlethiaProvisionerRole`; design skill `.claude/skills/alethia-design`. License: SPDX `© Alethia Labs OÜ`, `ee/` commercial, CLA.

> **When a spec doc cites a code path, the real names are `apps/console` / `apps/cli` / `apps/runner` / `packages/core`.** Some docs use the simplified forms `apps/alethia` / `packages/alethia-core` — read those as `apps/console` / `packages/core`.

## Remaining rename work (the deferred DB/wire pass)

The folder / binary / env / module / design-skill rename is **done** (PR #45). What's left is coupled to data/API/wire formats and was deliberately deferred:

- [ ] **DB tables/columns:** `vines`→`specs`, `vineyards`→`zones`, `tendrils`→`runners` (+ generated types + the regen pipeline).
- [ ] **API + wire:** `/api/tendrils`→`/api/runners`; `json:"tendril"` struct tags.
- [ ] **CLI command names:** cobra `vine`/`vineyard`/`tendril` → `spec`/`zone`/`runner`.
- [ ] **Prose/assets:** `apps/docs/content/**`; `tendril` helm/asset dirs.
- [ ] **Out-of-band:** GitHub org/repo move to `alethialabs-io/alethialabs`; Homebrew tap; merge PR #45.

_Cross-refs: [00-README](00-README.md) (glossary) · [12-licensing-open-core](12-licensing-open-core.md) (copyright = Alethia Labs OÜ)._
