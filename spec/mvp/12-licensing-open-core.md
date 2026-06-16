# 12 — Licensing & Open-Core Model

**Status:** Accepted (ADR)

## Context

Alethia Labs holds the copyright. Alethia must be **genuinely open-source** (the self-hostable, own-your-stack promise in [01-product-vision](01-product-vision.md) depends on it) **and** commercially viable. The license choice is also a competitive lever: it determines whether a better-funded competitor can take the code and out-host us.

Current state (verified):
- **No root `LICENSE` file** exists.
- `apps/legacy-cli/LICENSE` is plain **GPL-3.0** (not AGPL) — a stray to resolve.
- Root `package.json` has **no `license` field**; **zero SPDX headers** exist anywhere.

## Decision

License the **core under AGPL-3.0-only**. Hold copyright at Alethia Labs, gated by a CLA, so a commercial/dual license remains possible. Build the business as **open-core**: the self-hostable core is AGPL; enterprise/hosted features are commercial.

## Why AGPLv3

The AGPL **§13 network clause** is the point: anyone who runs a *modified* Alethia as a competing hosted service must release their source. This is the standard defensive-copyleft moat — it deters a hyperscaler or a funded competitor from taking the code and out-hosting us without contributing back, while keeping the project fully open for self-hosters.

Precedent (the defensive-copyleft playbook):

| Project | Move | Motivation |
|---|---|---|
| Grafana / Loki / Tempo | Apache-2.0 → **AGPLv3** (2021) | stop cloud free-riding |
| MongoDB | AGPL → SSPL | same problem, more aggressive license |
| Lago, Cal.com, PostHog | AGPLv3 core | open-core SaaS moat |

## Open-core boundary (the paid line == the self-host line)

| Layer | License | Notes |
|---|---|---|
| **Free, self-hostable core** | AGPL-3.0 | Zero-trust remote provisioning, the integrations catalog ([08](08-integrations-extensibility.md)), single-tenant. Runs without Supabase or any single SaaS (see [06-self-hosting-architecture](06-self-hosting-architecture.md)). |
| **Commercial / paid** | proprietary | Enterprise auth — SSO/SAML, RBAC, audit ([07-auth-rbac-sso](07-auth-rbac-sso.md)); multi-tenancy/orgs; the hosted/managed control plane; AI premium ([11](11-ai-scanner-mcp.md)). |

The paid boundary is deliberately the **self-host line**: everything needed to run Alethia yourself is AGPL; the things a team pays Alethia Labs to *not* operate themselves (identity at enterprise grade, multi-tenancy, hosting) are commercial. Pricing detail lives in [14-gtm-pricing](14-gtm-pricing.md).

## The open-core mechanism — the `ee/` directory

Adopt the **GitLab / Cal.com single-codebase model**: a `packages/enterprise/` (`ee/`) workspace in the same monorepo under its **own** commercial license, while the repo root stays AGPL.

- **Direction of dependency is the rule:** `ee/` may import the AGPL core; **the core must never import `ee/`**. The core depends only on the interface seams it defines ([07-auth-rbac-sso](07-auth-rbac-sso.md) Part F): `AuthzPolicy`/PDP, the tenancy resolver, `getAuthPlugins()`, `RealtimeTransport`, the entitlement hook. The community build is provably complete and buildable with `ee/` **absent**.
- **Entitlement flags live inside `ee/`**, never in core. Core ships empty hooks (`getAuthPlugins() → []`); `ee/` returns `[organization(), sso(), ...]` and reads a **signed license entitlement** to decide which enterprise features are active. No `if (licensed)` scattered through core files.
- **Why this stays honest open-source:** because the AGPL build runs fully without `ee/`, the §13 obligation lands only on the AGPL code, and the promise is verifiable — delete `ee/`, it still builds and runs. This is Cal.com's "singleplayer = AGPL, multiplayer = commercial," adapted to Better Auth's plugin model.
- **Rejected:** runtime license-key flags *in the core* (the AGPL grant lets anyone patch the flag — muddies the boundary) and a separate private EE repo (constant fork-merge; breaks one-`pnpm install` DX — GitLab consolidated *away* from this).

A **boundary-guard CI lint** that fails the build if any file outside `ee/` imports from `ee/` is the single most important automated guardrail — without it the boundary silently rots.

## AGPL friction, and the "tool-not-library" boundary

Many enterprise legal teams **ban AGPL dependencies** outright, fearing the copyleft reaches their own code. Mitigation, stated explicitly in docs:

- Alethia is a **tool that operates infrastructure**, not a library linked into the customer's product. The §13 obligation lands on whoever **modifies and hosts Alethia**, not on the customer's applications it provisions. The plain-HTTP worker boundary (`packages/alethia-core/api/api.go`, Bearer over `ALETHIA_WEB_ORIGIN`) reinforces this — the customer's workloads never link Alethia code.
- Keep a **commercial/dual license** available for teams that won't touch AGPL regardless.

## CLA / copyright assignment (from day one)

To ever dual-license or relicense, Alethia Labs must own or control all contributed copyright. Without a CLA, external contributions are usable only under AGPL.

- Adopt an **Apache-ICLA-style CLA** (or DCO + CLA) granting Alethia Labs broad relicensing rights.
- **Trust trade-off:** CLAs are what enabled the MongoDB / Elastic / HashiCorp relicenses and the community backlash that followed. Recommended posture: keep the **core permanently AGPL**, put the CLA in place quietly for optionality, and monetize via hosting + enterprise modules — not via a future rug-pull.

## Dependency license audit

- **OpenTofu** is MPL-2.0 — AGPL-compatible, and itself a reason to leave Terraform's BSL (see [10-opentofu-migration](10-opentofu-migration.md)).
- Audit: Talos, `hcloud`, the Anthropic SDK ([11](11-ai-scanner-mcp.md)), Charmbracelet (MIT) — confirm AGPL compatibility before shipping.
- Add a **license-scan CI step** (`go-licenses` + an npm license checker) so the dependency graph stays clean as it grows.

## Consequences

- Strong moat against hosted free-riders; full openness for self-hosters.
- Some enterprise buyers will require the commercial license — that's a revenue path, not a loss.
- CLA adds a small contributor-onboarding step.

## Alternatives considered

- **Apache-2.0** — maximal adoption, **no moat**; a competitor can host it freely. Rejected.
- **SSPL / BSL / Elastic / Fair-source** — stronger protection but **not OSI-approved**; breaks the "genuinely open-source / self-hostable" promise. Rejected for the core.

## Action items

- [ ] Add root `LICENSE` (AGPL-3.0-only); add `packages/enterprise/LICENSE` (Alethia Commercial License, modeled on Cal.com's EE license).
- [ ] SPDX headers: core `AGPL-3.0-only`, `ee/` `LicenseRef-Alethia-Commercial`; `"license"` field on first-party `package.json`s.
- [ ] Adopt **REUSE** (`reuse lint` in CI + a `REUSE.toml` declaring the `ee/` boundary) — machine-checkable "every file has a license."
- [ ] Add the **boundary-guard lint** (fail the build if any non-`ee/` file imports `ee/`).
- [ ] Resolve `apps/legacy-cli/LICENSE` (GPL-3.0 stray) — relicense to AGPL or delete the dead app.
- [ ] Stand up the CLA (Apache-ICLA-style bot + doc) — required from the first external contributor.
- [ ] Add the license-scan CI step (`go-licenses` + an npm license checker).
- [ ] Finalize the AGPL-vs-commercial feature split with [07](07-auth-rbac-sso.md) and [14](14-gtm-pricing.md).

## References

- Grafana relicensing to AGPLv3 — https://grafana.com/blog/2021/04/20/grafana-loki-tempo-relicensing-to-agplv3/
- AGPL as a non-starter for some enterprises — https://www.opencoreventures.com/blog/agpl-license-is-a-non-starter-for-most-companies
- OpenTofu (MPL-2.0) — https://opentofu.org/
