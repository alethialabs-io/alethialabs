# 23 — Web Surfaces: console, docs, blog

**Status:** Built (blog scaffolded this iteration). Records how the public web surfaces are split
across apps and served on one domain.

## Context

Public web presence is three distinct concerns — the **product + landing** (console), the **docs**,
and the **blog** (engineering deep-dives). Vercel/Supabase keep these as separate apps. We do the
same, adapted to our deployment: **standalone Docker images behind a Caddy reverse proxy**, path-routed
on one domain (`alethialabs.io`). Not Vercel/multi-zones.

## Decision

Three apps, one domain, path-based routing:

| Path | App | Stack | basePath |
|---|---|---|---|
| `/` | `apps/console` | Next.js (product + landing) | none |
| `/docs` | `apps/docs` | Next.js + **Fumadocs** | `/docs` |
| `/blog` | `apps/blog` | Next.js + **velite** (typed MDX) + custom UI | `/blog` |

Each is its own GHCR image; Caddy routes `/docs*` → docs, `/blog*` → blog, else → console
(`deploy/caddy/Caddyfile`, `deploy/prod/Caddyfile`). CI builds all three in the same matrix
(`.github/workflows/deploy-console.yml`); compose runs them as services (`docker-compose.yml` +
`deploy/prod/docker-compose.prod.yml`).

## Why a standalone blog (not a `/docs/blog` sub-section)

- **Different shape.** Docs are a sidebar/TOC/search tree; a blog is a reverse-chronological article
  feed (author, date, reading time, tags, RSS). Fumadocs is docs-shaped; fighting it for a blog is
  friction.
- **Independent stack + cadence.** The blog evolves on its own (RSS, OG, author pages) without
  touching the docs app.
- **basePath cleanliness.** Docs is mounted at `/docs`; a blog at `/docs/blog` reads as a docs
  sub-page. A sibling `/blog` app is the honest separation.

## Why velite (not Fumadocs, not content-collections)

velite runs as a **decoupled build step** (`velite && next build`) that emits plain JS/JSON to
`.velite/` — independent of the Next/Turbopack bundler, so it's robust in the Dockerized standalone
build. Typed zod frontmatter (title/date/author/tags/cover/excerpt/draft), `s.mdx()` body compiled to
a function-body string rendered by a small runtime (`components/mdx-content.tsx`) with a branded
components map (`components/mdx-components.tsx`). `s.metadata()` gives reading time. UI follows the
Alethia design system (light default, Geist, grayscale, squared) — not the Fumadocs theme.

## Anchors in code
- Blog app: `apps/blog/` (`velite.config.ts`, `app/{page,[slug]/page,feed.xml/route}.tsx`,
  `components/*`, `content/posts/*.mdx`, `Dockerfile`).
- Routing: `deploy/caddy/Caddyfile`, `deploy/prod/Caddyfile` (`handle /blog*`).
- Deploy: `docker-compose.yml` (`blog` service), `deploy/prod/docker-compose.prod.yml` (image pin),
  `.github/workflows/deploy-console.yml` (matrix `blog`).
- First post: `apps/blog/content/posts/instant-provisioning.mdx` (the [21](21-instant-provisioning-execution-model.md) win).

## Open / next
- **Marketing site extraction.** The landing currently lives *inside* `apps/console`
  (`app/page.tsx` + `components/landing/`). The fuller Vercel/Supabase model is a dedicated
  marketing/www app owning `/` (+ possibly absorbing the blog), with the console moving to `app.`
  subdomain or `/app`. Deferred — noted as the natural next step when marketing content grows.
- Blog niceties: dynamic OG images, author pages, tag indexes, pagination — add as the post count grows.
