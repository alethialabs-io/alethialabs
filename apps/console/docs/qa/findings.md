# Console QA — findings

Exhaustive e2e pass over `apps/console` (11 domains, 340 tests). Findings below are **triaged** —
each is tagged *confirmed app bug*, *environmental*, *test/spec bug*, or *testability gap*. App bugs
are prioritized; the two P1s are verified against the source.

> Run context: tests ran live against a dedicated QA console on `:3100` sharing the dev tree/DB. The
> user was live-editing `fix/ui-polish` (uncommitted project-settings WIP) — findings here are against
> **committed** code unless noted. A mid-run OrbStack crash + the multi-agent load caused transient
> failures that are called out as environmental, not defects.

---

## P1 — Confirmed app bugs (fix first)

> **Both P1s are FIXED + validated** in this pass (commit on `qa/e2e-suite`). Their tests were
> un-`fixme`'d and pass green. Details retained below for the record.

### 1. `getInviteContext` 500s on every team org — invite flow broken  ✅ FIXED (verified in source + test)
- **Severity:** High. Blocks the members/invite surface for any non-personal (team/Pro) org.
- **File:** `app/server/actions/members.ts:242` (`getInviteContext`), broken projection at **line 254**.
- **Root cause:** the first query projects `inviteEmail: invitation.email` but its `FROM`/`JOIN` is only
  `member ⋈ user` — the `invitation` table is never joined, so Drizzle emits invalid SQL (`missing
  FROM-clause entry for table "invitation"`) → 500. The field is **unused** (the `.then()` re-queries
  invitations separately and maps members to `inviteEmail: null`).
- **Repro:** as the `team` persona (org where `orgId !== userId`), open Settings → Members / the invite
  dialog → 500.
- **Fix:** delete `inviteEmail: invitation.email` from the first `.select({...})` (keep `memberEmail`).
- **Test:** `e2e/flows/rbac.spec.ts:213` (`test.fixme`, ready to un-fixme once fixed).

### 2. Token-cloud Connect opens an EMPTY sheet — DigitalOcean/Hetzner/Civo unreachable  ✅ FIXED
- **Severity:** High. The connect flow for the three token-based clouds is dead from the board.
- **File:** `components/connectors/connectors-page.tsx` `handleConnect` (~line 235).
- **Root cause:** token clouds are catalog `category='cloud'` but `auth_method='api_key'`. In
  `handleConnect`, the `if (auth_method === 'api_key')` branch runs **before** the cloud branch and
  calls `setApiKeySlug(...)` — but the api-key sheet doesn't know how to render a token-cloud, so the
  sheet opens blank (only a Close button). Expected: the `TokenCloudConnection` sheet with an "API
  Token" field.
- **Repro:** `/{org}/~/connectors` → Connect on Hetzner/DigitalOcean/Civo (or seed `provider:'hetzner'`
  and "Add another account").
- **Test:** `e2e/flows/connectors.spec.ts:169` + `connectors.negative.spec.ts:56` (`test.fixme`).

---

## P2 — Confirmed app bugs (correctness + perf)

### 3. Connectors route INSERTs pending `cloud_identity` rows on every load → unbounded growth
- **Severity:** Medium (correctness + perf; grows the table forever).
- **File:** `lib/connectors/cloud-connect-setup.ts` `getCloudConnectSetup()` (runs on every render of
  `/{org}/~/connectors`).
- **Root cause:** for each not-yet-connected managed/extra cloud it calls
  `getAwsExternalId` / `initGcpIdentity` / `initAzureIdentity` / `initExtraCloudIdentity` (×4 extra
  clouds), each **INSERTing a pending `cloud_identity` row**. Every visit writes several rows →
  unbounded pending-identity growth, and `getConnectorsWithStatus`'s per-identity scans slow down.
  Compounded by a 30s auto `router.refresh()` (`connectors-page.tsx` useEffect) → 40–90s navigations
  observed under load.
- **Fix direction:** make identity-init idempotent (reuse an existing pending row per provider/scope)
  or defer it to the actual connect click instead of on page load.

---

## P3 — Lower-severity app / UX bugs

### 4. Unknown project slug shows "Organization not found"
- `app/(private)/[org]/not-found.tsx` renders title "Organization not found" even when the **org is
  valid** and only the *project* slug is unknown (a valid org's `/{org}/does-not-exist`). Intentional
  non-leak (unknown vs forbidden read alike) per the file comment, but a project-scoped 404 message
  would be clearer. Test: `e2e/flows/navigation-shell.spec.ts`.

### 5. Agent route transiently redirects to `/login` on cold dev compile
- Navigating `/{org}/~/agent` as an authed persona bounced to `/login` on the first 1–2 (cold-compile)
  hits, then loaded fine. Heavy AI-SDK bundle (nav p95 ~21s). **Likely dev-only** (route-compile vs
  session hand-off race) — worth confirming it can't happen in prod. Test: `agent-usage-activity`.

---

## Reclassified — NOT app bugs (verified)

- **OTP send latency (~110s):** environmental. Unloaded it's **25–112 ms** and the code logs instantly
  (`[email] SES not configured … (sign-in code: …)`); the 110s was CPU starvation under the 29-browser
  swarm. No auth-path defect.
- **Duplicate project name "not refused":** the app behaves correctly (allows duplicate display names,
  slugs stay unique) — the swarm's orientation hint was wrong, not the app.
- **Various "route p95 25–32s / cold-compile flakes":** `next dev` first-hit compilation under
  multi-agent load, not production latency. See `performance.md` for the clean serial numbers.

---

## Test/spec bugs to fix (the suite, not the app)

These are authoring mistakes in the swarm-written specs — fix during suite hardening:
- **alerts** (5): `page.getByDisplayValue` isn't a Playwright method (rename-channel test); strict-mode
  multi-match on policy name (rail vs "Used by" pill) and in confirm dialogs; policy happy-path leaves
  the create sheet open (channel binding not applied); alerts route cold-compile cascade timeouts.
- Assorted strict-mode selector collisions flagged as testability gaps below.

---

## Testability / accessibility gaps (recommend `data-testid` or an accessible name)

The suite leans on roles/labels; these controls have no stable accessible handle, forcing brittle
selectors. Adding a `data-testid` (or an `aria-label`) would harden both a11y and the tests:

| Area | Control lacking an accessible name |
|---|---|
| onboarding | Create-org sheet: sr-only `SheetTitle` duplicates the visible `h1` (ambiguous heading); slug editor input |
| connectors | Detail-sheet account-row action buttons; group-filter option carries a count in its name |
| projects | Create-form `CloudTile`; react-flow design-canvas nodes |
| deploy-jobs | Jobs filter facets (label only via `placeholder`); job rows in the DataTable; cluster "ArgoCD" label vs URL collision |
| runners | Default-star toggle; destroy-confirm shares label with trigger; header "Runners" vs sidebar nav link |
| rbac | Org General settings inputs |
| alerts | Channel detail name input |
| agent/usage | Agent mode segment + Usage metric tabs expose active state only via CSS class |
| nav / cross-cutting | Switcher popover triggers (aria-label only); "Overview" ambiguous (nav link + breadcrumb) |

---

## Positive signal

- **Full-surface resilience sweep found NO broken pages** — loading every major route (overview,
  connectors, runners, jobs, clusters, alerts, agent, usage, all settings tabs) as an authed user
  produced no uncaught `pageerror` and no unexpected 500s (`cross-cutting.spec.ts`). The 500s that DO
  exist are behind specific actions (getInviteContext) or specific controls (token-cloud connect),
  which is exactly what the targeted specs caught.
