# Analytics — PostHog (hosted suite) or Umami + OpenReplay (OSS self-host)

The console's analytics layer is **provider-agnostic** (`apps/console/lib/analytics/config.ts` →
`track()`/`identify()`), and everything is **off by default** — no `NEXT_PUBLIC_*` env ⇒ zero telemetry
(the OSS build ships none). Three providers, enabled by env:

- **PostHog** — the all-in-one suite hosted **alethialabs.io runs in prod**: product analytics + funnels
  + **session replay** + **web-vitals/performance** + error tracking, in one dashboard. Setup is a single
  project key — no infra. Set `NEXT_PUBLIC_POSTHOG_KEY` (+ optional `NEXT_PUBLIC_POSTHOG_HOST`, default
  `https://eu.i.posthog.com`) and leave Umami/OpenReplay unset (the provider won't double-track).
  - **1-time setup:** create a PostHog project (EU) → copy the `phc_…` project API key; in project
    settings enable **Session Replay**, set a **billing limit** = free tier (1M events / 5k recordings —
    with no card PostHog hard-stops at the cap, so never a surprise bill), and a replay **sample rate**
    to stretch recordings. Put the key in the vault (`NEXT_PUBLIC_POSTHOG_KEY`) → redeploy.
  - Session replay masks all inputs by default; add `data-ph-mask` to any element whose *text* is
    sensitive (billing amounts, tokens). Web Vitals populate PostHog's Web Vitals dashboard natively.
  - **Future — move to AWS CloudWatch RUM:** because the layer is provider-agnostic, it's a provider
    swap, not a rewrite — add a RUM provider (Cognito identity pool + app-monitor snippet) and switch
    `NEXT_PUBLIC_POSTHOG_*` for the RUM config. Considered for when the free tier is outgrown.

The **OSS self-host** path (no third-party cloud) stays fully supported below:

Open-source, self-hostable telemetry — **product analytics** (events, funnels, journeys, retention) +
**Core Web Vitals** via **Umami**, and **session replay** via **OpenReplay**. Enabled by their own
`NEXT_PUBLIC_*` env (`apps/console/lib/analytics/config.ts`). Both are still first-class **opt-in
providers in the app**, but they are **no longer deployed on the hosted alethialabs.io box** — prod runs
PostHog. If you self-host and want Umami/OpenReplay instead of PostHog, run them yourself (below) and set
the matching `NEXT_PUBLIC_*` env.

> **Note — Umami is NOT provisioned on alethialabs.io.** The old hosted wiring (the `analytics` DNS
> record + tunnel ingress + Cloudflare Access apps in `infra/cp-hetzner`, the `umami`/`umami-db`/
> `umami-init` compose services, `umami-init`'s `umami-seed.sql`, and the `ANALYTICS_DB_PASSWORD` /
> `UMAMI_*` / `NEXT_PUBLIC_UMAMI_*` secrets) has been **removed**. There is nothing to configure in the
> box's Cloudflare Tunnel / vault pipeline for analytics — prod uses PostHog (a single project key).

---


## App side (already wired)
- `apps/console/lib/analytics/{config,events,track}.ts` — provider-agnostic `track()` / `identify()`.
- `apps/console/components/providers/analytics-provider.tsx` — mounts the Umami script + OpenReplay
  tracker (dynamic import; input obscuring on). Mounted in `app/providers.tsx`.
- `apps/console/components/analytics/web-vitals.tsx` — Next `useReportWebVitals` → `web_vitals` events.
- Funnel events fire from the real journeys: `org_created`, `connector_connect_started`,
  `project_created`, `deploy_queued` (see `lib/analytics/events.ts`).

## Umami (product analytics + Web Vitals) — light, ~200 MB
Umami is **no longer bundled** in `docker-compose.yml` (the `analytics` profile was removed when prod
moved to PostHog). To use it as your OSS analytics provider, run it yourself — the official image +
its Postgres, e.g. a small standalone compose file:

```yaml
# umami.compose.yml (run: docker compose -f umami.compose.yml up -d)
services:
  umami-db:
    image: postgres:17-alpine
    environment: { POSTGRES_USER: umami, POSTGRES_PASSWORD: <random>, POSTGRES_DB: umami }
    volumes: [umami-data:/var/lib/postgresql/data]
  umami:
    image: ghcr.io/umami-software/umami:postgresql-v2.16
    environment:
      DATABASE_URL: postgresql://umami:<random>@umami-db:5432/umami
      DATABASE_TYPE: postgresql
      APP_SECRET: <random>
    ports: ["8888:3000"]     # Umami → http://localhost:8888
    depends_on: [umami-db]
volumes: { umami-data: {} }
```

```bash
# First run: log in (admin / umami — CHANGE IT), create a website, copy its Website ID, then set on
# the console:
NEXT_PUBLIC_UMAMI_HOST=http://localhost:8888
NEXT_PUBLIC_UMAMI_WEBSITE_ID=<website-id>
```
Umami is cookieless/GDPR-friendly — no consent banner needed. Pageviews + custom events (funnels,
`web_vitals`) show in its dashboard. (`UMAMI_APP_SECRET` / the DB password are Umami's own env in the
compose file above — the console only needs the two `NEXT_PUBLIC_UMAMI_*` values.)

## OpenReplay (session replay) — **default: their Cloud free tier**
OpenReplay self-hosting is a full stack (Postgres/ClickHouse/Redis/MinIO) that needs its own ~16 GB box
+ real ops. Their **Cloud free tier gives 1,000 session recordings/mo at $0**, so the default is Cloud —
**no infrastructure**:

1. Sign up at [openreplay.com](https://openreplay.com) and pick the **EU region** (GDPR — Alethia Labs DPK
   is EU). Create a project → copy its **project key**.
2. Set in the console prod env (the vault; the deploy assembler already emits it):
   ```bash
   NEXT_PUBLIC_OPENREPLAY_PROJECT_KEY=<project-key>
   # NEXT_PUBLIC_OPENREPLAY_INGEST is OPTIONAL — leave empty and the tracker posts to OpenReplay Cloud's
   # default ingest; set it only for the EU-cloud ingest host or a self-hosted box.
   ```
That's it — the tracker (`components/providers/analytics-provider.tsx`, inputs obscured) starts recording.

**Self-host later** (only once you outgrow 1,000 sessions/mo): OpenReplay's full stack
(Postgres/ClickHouse/Redis/MinIO) needs its own ~16 GB box + real ops — follow OpenReplay's official
self-host guide on a dedicated VM and point `NEXT_PUBLIC_OPENREPLAY_INGEST` at it. (Alethia no longer
ships a box module for it.)

Privacy (either way): the tracker obscures email/number inputs by default; Stripe card fields are
cross-origin iframes (never captured). Mark extra sensitive subtrees `data-openreplay-obscured`, and gate
replay behind consent if your privacy policy requires it.

## Verify
Load any console page → the `<script src=".../script.js" data-website-id=…>` renders and posts a
pageview + `web_vitals` events to Umami (confirmed via `/api/websites/:id/stats` and `…/metrics?type=event`).
