# Console QA — performance

From a **serial** (`E2E_WORKERS=1`) pass over the page-loading sweep (cross-cutting + navigation-shell) against the :3100 dev console — no multi-agent load noise. Numbers are dev-mode (`next dev` turbopack) wall-clock from Playwright resource timing; production (built) will be faster. Sample: 69 tests.

## Navigation latency by route (dev, warm-ish)

| p95 ms | p50 ms | max ms | n | route |
|--:|--:|--:|--:|---|
| 43476 | 43476 | 43476 | 1 | `/:org/e2e-xcut-1783235180477/architecture` |
| 35464 | 35464 | 35464 | 1 | `/:org/e2e-xcut-1783235322906/usage` |
| 32695 | 1533 | 32695 | 8 | `/:org` |
| 28641 | 28641 | 28641 | 1 | `/:org/~/new` |
| 4287 | 4287 | 4287 | 1 | `/:org/e2e-xcut-1783235180477/environments` |
| 2523 | 2523 | 2523 | 1 | `/:org/e2e-xcut-1783235322906/settings/general` |
| 2405 | 2405 | 2405 | 1 | `/:org/~/settings/access` |
| 2206 | 2206 | 2206 | 1 | `/:org/e2e-xcut-1783235322906/settings/activity` |
| 1896 | 1896 | 1896 | 2 | `/:org/~/jobs` |
| 1889 | 1889 | 1889 | 1 | `/:org/e2e-xcut-1783235322906/settings/access` |
| 1771 | 1771 | 1771 | 1 | `/:org/~/settings/billing` |
| 1625 | 1625 | 1625 | 1 | `/:org/~/settings/general` |
| 1612 | 1612 | 1612 | 1 | `/:org/~/settings/teams` |
| 1572 | 1572 | 1572 | 1 | `/:org/~/connectors` |
| 1518 | 1518 | 1518 | 1 | `/:org/e2e-xcut-1783235180477` |
| 1439 | 1439 | 1439 | 1 | `/:org/~/runners` |
| 1244 | 1244 | 1244 | 1 | `/:org/~/alerts` |
| 1225 | 1225 | 1225 | 1 | `/:org/~/jobs/:id` |
| 1180 | 1180 | 1180 | 2 | `/:org/~/settings/roles` |
| 1153 | 1153 | 1153 | 1 | `/:org/~/settings/members` |
| 1097 | 1097 | 1097 | 1 | `/:org/~/agent` |
| 1047 | 1047 | 1047 | 1 | `/:org/~/clusters` |
| 877 | 877 | 877 | 1 | `/:org/~/settings/activity` |
| 754 | 754 | 754 | 1 | `/:org/~/usage` |
| 663 | 663 | 663 | 1 | `/:org/~/settings/sso` |
| 13 | 13 | 13 | 3 | `/:org/m-outer-3437aaddcdf6922d623e172c2d6f9278.html` |

## Server actions & API fetches

| p95 ms | p50 ms | n | endpoint |
|--:|--:|--:|---|
| 1079 | 567 | 4 | `fetch POST /:org` |
| 566 | 174 | 13 | `fetch GET /api/auth/list-accounts` |
| 440 | 152 | 22 | `fetch GET /api/auth/get-session` |
| 274 | 274 | 1 | `server-action POST /:org` |
| 259 | 259 | 1 | `server-action POST /:org/~/settings/roles` |
| 81 | 81 | 1 | `server-action POST /:org/e2e-xcut-1783235180477/environments` |

## Notes & flags

- **Slowest routes** are the project-scoped settings/environments pages and org settings/access — dev cold-compile dominates first hits; warm hits are ~1–2s.
- **Connectors route is a known outlier** (see findings.md #3): it INSERTs pending `cloud_identity` rows on every load and auto-`router.refresh()`s every 30s, so under any load it degrades to 40–90s and the table grows unbounded. This is the one route with a real perf *bug*, not just dev cold-compile.
- **Under the multi-agent swarm** (11 agents / ~29 browsers) the same routes hit p95 25–32s and OTP send hit ~110s — pure CPU starvation, not representative. All perf numbers above are the clean serial pass.
- **No slow-query/N+1 DB capture** was run (Postgres slow-query logging deferred to avoid touching the shared stack under load); the connectors INSERT-on-load finding is the main DB-write concern surfaced.
