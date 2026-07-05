# Self-hosted analytics (Umami + OpenReplay)

Open-source, self-hostable telemetry for the console — **product analytics** (events, funnels,
journeys, retention) + **Core Web Vitals** via **Umami**, and **session replay** (watch where users
get stuck) via **OpenReplay**. Both are **off by default**: the app's analytics layer no-ops unless the
`NEXT_PUBLIC_*` env is set (`apps/console/lib/analytics/config.ts`), so the open-source build ships
zero telemetry.

## App side (already wired)
- `apps/console/lib/analytics/{config,events,track}.ts` — provider-agnostic `track()` / `identify()`.
- `apps/console/components/providers/analytics-provider.tsx` — mounts the Umami script + OpenReplay
  tracker (dynamic import; input obscuring on). Mounted in `app/providers.tsx`.
- `apps/console/components/analytics/web-vitals.tsx` — Next `useReportWebVitals` → `web_vitals` events.
- Funnel events fire from the real journeys: `org_created`, `connector_connect_started`,
  `project_created`, `deploy_queued` (see `lib/analytics/events.ts`).

## Umami (product analytics + Web Vitals) — light, ~200 MB
Runs from the `analytics` Docker profile (`docker-compose.yml`: `umami` + `umami-db`).

```bash
# Bring up (prebuilt images, no build):
docker compose --profile analytics create umami-db umami
docker compose --profile analytics start umami-db umami        # Umami → http://localhost:8888
# First run: log in (admin / umami — CHANGE IT), create a website, copy its Website ID, then set:
NEXT_PUBLIC_UMAMI_HOST=http://localhost:8888
NEXT_PUBLIC_UMAMI_WEBSITE_ID=<website-id>
UMAMI_APP_SECRET=<random>            # server secret
ANALYTICS_DB_PASSWORD=<random>       # umami-db password
```
Umami is cookieless/GDPR-friendly — no consent banner needed. Pageviews + custom events (funnels,
`web_vitals`) show in its dashboard.

## OpenReplay (session replay) — heavier, opt-in
OpenReplay's self-host is a full stack (Postgres/ClickHouse/Redis/MinIO + services). **Do not hand-roll
a compose file** — use the upstream installer, and for a resource-constrained box run it on a **separate
small VM** (the ingest is just an HTTPS endpoint the console posts to):

```bash
# On the analytics host (see https://docs.openreplay.com/en/deployment/):
git clone https://github.com/openreplay/openreplay && cd openreplay/scripts/helmcharts
# follow the docker or k8s install; it prints a PROJECT_KEY + ingest URL. Then set on the console:
NEXT_PUBLIC_OPENREPLAY_PROJECT_KEY=<project-key>
NEXT_PUBLIC_OPENREPLAY_INGEST=https://openreplay.<your-domain>/ingest   # optional if same origin
```
Privacy: the tracker obscures email/number inputs by default; Stripe card fields are cross-origin
iframes (never captured). Add `data-openreplay-obscured` to any extra sensitive subtree, and gate
replay behind consent if your privacy policy requires it.

## Ingress (Cloudflare Tunnel + Caddy)
Expose Umami (and OpenReplay) on their own hostnames. Add a tunnel ingress + a Caddy route, e.g.:

```caddy
# deploy/prod/Caddyfile  (mirror of the marketing pattern)
analytics.alethialabs.io {
    encode zstd gzip
    reverse_proxy umami:3000
}
# openreplay.alethialabs.io { reverse_proxy <openreplay-host>:8080 }
```
Then set `NEXT_PUBLIC_UMAMI_HOST=https://analytics.alethialabs.io` in the console's prod env
(the vault / `deploy/prod` env), since `next-runtime-env` reads it at container start (no rebuild).

## Verify
Load any console page → the `<script src=".../script.js" data-website-id=…>` renders and posts a
pageview + `web_vitals` events to Umami (confirmed via `/api/websites/:id/stats` and `…/metrics?type=event`).
