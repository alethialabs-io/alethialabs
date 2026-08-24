# Analytics — PostHog (hosted suite) or Umami (OSS self-host)

The console's analytics layer is **provider-agnostic** (`apps/console/lib/analytics/config.ts` →
`track()`/`identify()`). Everything is **off by default** and an environment variable is never treated
as consent: no `NEXT_PUBLIC_*` env means zero telemetry, while a configured provider remains unloaded
until the visitor makes the matching choice.

**There is one optional choice: product analytics.** Consent v2 removed the session-replay choice, and
the replay SDK paths with it (#2371) — the product does not record sessions, so it does not ask. The
OpenReplay adapter and its `NEXT_PUBLIC_OPENREPLAY_*` env are gone rather than merely unset: an adapter
that no consent gate can ever enable is not an option a self-hoster has, it is dead code that still
appears in an SBOM and in a privacy review.

- **PostHog** — the all-in-one suite hosted **alethialabs.io runs in prod**: consented product analytics
  + funnels + **web-vitals/performance** + client error tracking. Setup is a single project key — no
  infra. Set `NEXT_PUBLIC_POSTHOG_KEY` (+ optional `NEXT_PUBLIC_POSTHOG_HOST`, default
  `https://eu.i.posthog.com`) and leave Umami unset (the provider won't double-track).
  - **1-time setup:** create a PostHog project (EU) → copy the `phc_…` project API key; in project
    settings set a **billing limit** = free tier (1M events — with no card PostHog hard-stops at the
    cap, so never a surprise bill). Leave **Session Replay** OFF: the app pins
    `disable_session_recording: true`, and a project with replay enabled would still be a capability
    the privacy disclosures have to account for. Put the key in the vault
    (`NEXT_PUBLIC_POSTHOG_KEY`) → redeploy.
  - Web Vitals populate PostHog's Web Vitals dashboard only after analytics consent.
  - **Future — move to AWS CloudWatch RUM:** because the layer is provider-agnostic, it's a provider
    swap, not a rewrite — add a RUM provider (Cognito identity pool + app-monitor snippet) and switch
    `NEXT_PUBLIC_POSTHOG_*` for the RUM config. Considered for when the free tier is outgrown.

The **OSS self-host** path (no third-party cloud) stays fully supported below:

Open-source, self-hostable telemetry — **product analytics** (events, funnels, journeys, retention) +
**Core Web Vitals** via **Umami**. Enabled by its own `NEXT_PUBLIC_*` env
(`apps/console/lib/analytics/config.ts`). It is still a first-class **opt-in provider in the app**, but
it is **no longer deployed on the hosted alethialabs.io box** — prod runs PostHog. If you self-host and
want Umami instead of PostHog, run it yourself (below) and set the matching `NEXT_PUBLIC_*` env.

> **Note — Umami is NOT provisioned on alethialabs.io.** The old hosted wiring (the `analytics` DNS
> record + tunnel ingress + Cloudflare Access apps in `infra/cp-hetzner`, the `umami`/`umami-db`/
> `umami-init` compose services, `umami-init`'s `umami-seed.sql`, and the `ANALYTICS_DB_PASSWORD` /
> `UMAMI_*` / `NEXT_PUBLIC_UMAMI_*` secrets) has been **removed**. There is nothing to configure in the
> box's Cloudflare Tunnel / vault pipeline for analytics — prod uses PostHog (a single project key).

---


## App side (already wired)
- `packages/privacy` — versioned first-party consent state (v2), equal accept/reject controls, the one
  optional analytics choice, Global Privacy Control honoured as a standing opt-out, and the
  **Privacy settings** control that reopens the dialog.
- `apps/console/lib/analytics/{config,events,track}.ts` — provider-agnostic `track()` / `identify()`.
- `apps/console/components/providers/analytics-provider.tsx` — imports PostHog/Umami only after
  analytics consent, pins `disable_session_recording`, and deletes PostHog's identifiers and browser
  storage on withdrawal.
- `apps/console/lib/analytics/server.ts` — deliberately no-ops third-party product/AI analytics in
  webhook and worker contexts because those contexts cannot prove the user's browser consent.
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
The console treats Umami as optional analytics even when configured cookieless: it is loaded only after
analytics consent. Pageviews + custom events (funnels, `web_vitals`) then show in its dashboard.
(`UMAMI_APP_SECRET` / the DB password are Umami's own env in the compose file above — the console only
needs the two `NEXT_PUBLIC_UMAMI_*` values.)

## Session replay — removed, not disabled

There is no replay provider and no replay consent choice. `disable_session_recording` is pinned on in
PostHog's init, the OpenReplay adapter and its env are deleted, and `packages/legal`'s processing
register no longer describes replay as a purpose.

Re-introducing it is a product and privacy decision, not a configuration one: it needs a consent
choice (consent v3), a purpose in the register, a line in the cookie notice and the accountability
record, and a masking review. Setting an env variable would not be enough, which is the point.

## Verify
In a clean browser profile, load any console page and verify that no PostHog or Umami
request occurs before a choice. Reject non-essential processing and verify the same. Then grant
analytics only: PostHog/Umami may send events, but no replay begins. Grant replay separately and verify
recordings are masked. Finally withdraw both choices from **Privacy choices** and verify a reload leaves
no third-party telemetry active.
