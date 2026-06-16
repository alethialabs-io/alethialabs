# 11 — AI Repo-Scanner & MCP

**Status: Roadmap (post-MVP).** Retained as a differentiator but **demoted** below the thesis docs (self-hosting, auth, integrations) in the reorientation — it layers cleanly on a stable base. **Open decision:** pull into the MVP, or keep as the first post-MVP milestone (M5 in [15-mvp-scope-milestones](15-mvp-scope-milestones.md)). Flagged for confirmation.

## Concept

Two capabilities, one tool layer:
1. **Repo-scanner** — point it at a repository; it analyzes the stack (Dockerfiles, `package.json`/`go.mod`, k8s manifests, framework signals) and **proposes a Spec** (the existing `VineConfig` schema), right-sized, with a live cost estimate and a provider comparison.
2. **MCP tool layer** — expose the platform's actions as **MCP tools** so the *same* surface drives both **Claude** (Claude Code / claude.ai / the SDK) and the **dashboard**.

## Where it slots in

- **Wrap the existing API + PDP** — no new authority model. The MCP server calls the same verbs the dashboard does, through the PDP ([07](07-auth-rbac-sso.md)), so AI actions are bounded by the actor's grants.
- **Scanner output = the existing `Spec`/`VineConfig`** — proposals feed straight into the plan/apply path, no parallel schema.
- **Placement:** an MCP server as a new workspace package (TS, using the official MCP SDK) serving the dashboard in-process and Claude over a transport; the scanner can be Go (in `alethia-core`) or TS, emitting a `Spec`.

## Tool surface (serves Claude + dashboard identically)

`scan_repo(repo)` · `propose_spec(findings, provider)` · `compare_providers(spec)` (uses Infracost) · `plan(spec)` · `apply(spec, plan_id)` · `get_job(id)` / `tail_logs(id)` · `list_clusters()`.

## Implementation notes

- **Anthropic SDK + tool use** for the findings→Spec reasoning; **prompt caching** for the large, reused repo digest. The MCP server is the single source of truth for tool schemas; the dashboard renders the same tools as forms/buttons. *Verify current model ids + SDK specifics against the `claude-api` skill at build time.*
- **One layer, two consumers** — never fork the tool definitions between Claude and the UI.

## Open-core

**AI is a paid/metered tier** (`ee/` + usage) — high marginal cost → meter per scan/token ([14-gtm-pricing](14-gtm-pricing.md)). The core PDP/API it wraps stays AGPL.

## Why demoted (and the case to pull it forward)

- **Demoted because:** the thesis is *ownership* (self-host + zero-trust + integrations + multi-cloud). AI is a differentiator best built on a stable, de-Supabased, authz'd base — not before it.
- **Pull-forward case:** the repo→Spec scanner is the most demoable, "wow" feature and a strong funnel. If launch needs a headline beyond ownership, a *minimal* scanner (scan → propose → cost) can ship in the MVP with the full MCP layer as fast-follow.

## Dependencies

Sits on the stable, versioned API/PDP from [07](07-auth-rbac-sso.md) and the integration/provider registries ([08](08-integrations-extensibility.md)/[09](09-multi-cloud-cluster-strategies.md)). Build after the de-Supabase + auth milestones unless explicitly pulled forward.
