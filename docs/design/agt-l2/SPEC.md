# AGT-L2 design spec (v2): approvals and the decision sheet, agent policy, service token auto-approve, connected agents and consent

Issue #6860. Spec: `management/spec/features/beta-2027-01-31/agent-surface.md` §4.2–4.4, §4.9, decisions D1, D2, D5, D6 (confirmed as M7, M8, M9, M24 in `decisions-2026-11-17.md`). Enterprise toggles: AGT-L14, PR #7478 (`lib/approvals/enterprise-policy.ts`, open at the time of writing).

Prototype: `index.html` in this folder. The top bar switches surface and state. **Phone 390** previews phone width. **Data sources** outlines each field with the column it reads (dashed) and each gap (solid). On Connected agents, **Grayscale unconnected** previews the alternative to ruling #3907 (see O3). Deep links: `#sheet/destroy-confirm`, `#list/all/phone`, `#consent/c-reconsent`, `#sheet/blocked-prod/annot`.

Grounded on `origin/dev` at `1a3ec96da`. Every field names its source. Anything the data model lacks is listed under **Gaps**, not invented.

---

## Changes from v1 per maintainer review

| # | Ruling | What changed |
|---|---|---|
| 1 | **Decide in a sheet, not on a page.** | The separate approval page is gone. The approvals list is the home. A request opens in a right-hand sheet over the list, with all v1 content and states. The link an agent or the CLI prints is `/[org]/~/approvals?approval=<id>`. On a phone the sheet is full screen. This closes the org-less link gap (G1), see §1.2. |
| 2 | **No count pills anywhere.** | `PageToolbar` no longer carries a count on any surface (approvals, service tokens, connected agents). The list pages with the console's existing pattern, `useInfiniteScrollSentinel` plus a visible **Load more** (Activity log, support cases list). The sidebar's waiting-count badge is **dropped**; see §1.5 for why. Facet option counts in the filter popovers stay: they are part of the filter standard, not a page count. |
| 3 | **Agent policy is a PDP verb.** | New verb `org:manage_agents`, granted through roles. Read-only state for anyone without it, on the policy page and on the service-token auto-approve picker. The "who may change it" decision is removed. |
| 4 | **Approving re-checks policy (yes).** | At decision time, Approve is disabled with an explanation when agent access is off, when "keep agents off production" applies, or (Enterprise) when the requesting app is not on the org's allow-list. Deny stays available. |
| 5 | **Deny with an optional reason (yes).** | Reason field kept. The new `apply_approvals.decision_reason` column is shown on the Denied outcome as untrusted text. |
| 6 | **Connected agents look like connectors.** | Rebuilt as the connectors board: a card grid in `connector-card.tsx`'s exact anatomy, with known apps listed whether connected or not. Real brand marks from the source the console already uses for inline marks (simple-icons, as in `components/alerts/channel-icon.tsx`). No letter placeholders: an unrecognised app gets a neutral glyph. |
| 7 | **Consent: every edge case.** | 22 states, each enumerated in §5b. |
| 8 | Everything else approved. | Agent policy, service tokens and the consent layout are unchanged apart from the permission wording above. |

The Enterprise PR (#7478) also adds a case v1 did not have. Under "require a different approver", a person's **own console click** to deploy production or to destroy needs a second person. That request reaches the sheet as "Requested through: Alethia console" (state *Second person*).

---

## 0. Decisions that apply to every surface

| Rule | How it shows up |
|---|---|
| No page titles (CLAUDE.md §6) | The breadcrumb names the page. `PageToolbar` carries the description and the actions, **never a count**. The only `<h1>` is on the consent page, which uses `AuthShell` with no breadcrumb (it needs a recorded entry in `shared-surface-allowlist.yaml`, like sign-in). A sheet's title is the dialog's accessible name, not a page title. |
| Section headings | `SectionHeading` (`level={3}` inside a sheet, `level={2}` on a page). |
| Status | `StatusBadge` with an **explicit `tier`**. `expired`, `superseded` and `consumed` are not in `STATUS_TIER`. Map: `pending`→pending "Waiting", `approved`→active "Approved", `consumed`→active "Used", `rejected`→failed "Denied", `expired`→disabled "Expired", `superseded`→disabled "Replaced". |
| Empty | `EmptyState` from `@repo/ui/empty`. |
| Lists | `DataTable` on desktop. Phones get a stacked `ul`/`li` list with the same fields. Paging is `useInfiniteScrollSentinel` plus **Load more**, never a count. |
| Sheets | `@repo/ui/sheet` (the console's `detail-sheet` pattern, as in `connector-detail-sheet.tsx`), right side, `min(640px, 100%)`, full screen on phones. Scrim is `--overlay`; layers use `--z-overlay`, and `--z-overlay-nested` for a dialog opened from a sheet. |
| Type | `--text-ui-*` rungs only. |
| Ink | The four named tiers. No alpha on text. |
| Seriousness without colour | **Production** is a filled ink pill. **Destroy** is a filled ink tag, an inverted band "Destroy · can't be undone" at the top of the sheet, and a 2px ink edge on it. |
| Confirmations | `ConfirmAction`: `level: "destroy"` to approve a destroy (typed environment name); `level: "confirm"` to turn agent access off and to disconnect an agent. |
| Money, time | `formatMonthlyDelta`, `formatMonthlyRate("exact")`, `formatDuration`, `formatRelative` / `formatDate` (`@repo/format`). |
| Names for credentials | Never the enum. `cli_session` → "Alethia CLI"; `agent_oauth` → the app's own name with "Connected agent"; `agent_in_app` → "Alethia assistant"; `service_token` → the token's name with "Service token"; `session` (Enterprise second person) → "Alethia console". The row label is "Requested through". |
| Deny vs reject | The engine says `reject`; the UI says **Deny** / **Denied**. |
| Third-party marks | Rendered in their owners' colours, the connectors rule (`connector-icon.tsx`, ruling #3907). A mark whose brand colour is black or near-black is drawn in foreground ink so it reads on the dark theme, as GitHub's black/white pair is. |

---

## 1. Approvals — `/[org]/~/approvals` (home) and the decision sheet (`?approval=<id>`)

### 1.1 Purpose

The list is everything waiting for a person, plus history, for one org. Opening a row, or arriving from the link an agent, the CLI or a pipeline prints, opens the **decision sheet** over the list. The sheet shows what would run, read from the plan job and never from the requester. One person decides there.

### 1.2 Routing, and how this closes G1

- New route `app/(private)/[org]/~/approvals/page.tsx` with its own `loading.tsx` and `error.tsx`. The sheet is driven by the `approval` search param (nuqs or `useSearchParams`), so it survives reload and back/forward. Closing removes the param.
- `lib/approvals/http.ts:approvePath(id)` changes to `approvalsPath(orgSlug, id)` and returns `/${orgSlug}/~/approvals?approval=${id}`. `request.ts` already has the approval row, so `org_id` → slug is one read. The MCP `approve_url` and the CLI print this.
- **G1 is closed by construction.** The org is in the URL, and the `[org]` segment already makes that org the active scope for the request. A person in two orgs lands in the right one whichever org they last used. Someone who is not a member gets the console's normal org `not-found` (no hint that the approval exists). A member without view access to the project gets the sheet's "not available" state.
- Old links shaped `/approvals/<id>` (anything already printed by the CLI): a tiny `app/(private)/approvals/[id]/route.ts` looks up `org_id` by id with the service DB and redirects to the new URL if the viewer is a member, otherwise to the org picker. It discloses nothing. Removable after one CLI release.

### 1.3 The list

| Column | Source |
|---|---|
| Status | effective status (`read.ts:viewOf`) |
| Request | operation tag + project / environment, Production pill when `stage = production` |
| Requested for | requester name; under it the "requested through" icon and label |
| Plan | `PlanSummary.counts` as `+add ~change −destroy`; cost change under it |
| Digest | `digestPrefix` |
| Requested | `created_at`, relative |
| Last column | waiting: countdown. Decided: "Approved by / Denied by {name}", "Used by job {id}", "Expired without a decision", "Replaced by a newer plan" |

**Filter standard (both halves).** Client: `FilterBar` + `FilterSearch` + `FacetFilter` for **Status**, **Operation**, **Requested through**, **Environment**, in the URL. Default view: Status = Waiting, as a real chip the person can clear. Server: new `queryApprovalsPage` in `lib/queries/` with a filtered rows pass and a facet pass over the unfiltered (scope-only) universe (`facets.ts`). Scope: rows whose project the viewer may `view`.

**Paging (ruling 2).** As the support cases list and the Activity log do it:
- the server renders page one (50 rows) with a keyset cursor of `(created_at, id)`; `idx_apply_approvals_org` already covers `(org_id, created_at)`;
- later pages come from `orpc.approvals.list.infiniteOptions`, keyed on page one's last row and the filters;
- a hidden tail sentinel (`useInfiniteScrollSentinel`, `rootMargin` 200px) auto-loads, and a visible **Load more** button sits beside it for keyboard, screen-reader and no-JS users;
- while loading, the button reads "Loading…" and is disabled;
- a failed page is reported **under** the rows it would have extended, never replacing them: "Couldn't load more requests." + **Try again** (the Activity log's R6 E-26 rule);
- when the last page is in, the footer disappears. No count, no "showing N of M".

**List states:** Waiting (default) · All (auto-loads more) · Loading more · Couldn't load more · All loaded · No matches (`EmptyState` + Clear filters) · Empty org ("No approval requests yet" · "When an agent, the Alethia CLI or a service token asks to deploy or destroy, the request waits here for a person." + Connect an agent + `alethia agent setup`) · Loading · Error.

**Copy.** Toolbar description: "Requests from the Alethia CLI, connected agents and service tokens to deploy or destroy. Each one needs a person."

### 1.4 The decision sheet

**Anatomy, top to bottom:**
1. A band, for destroy ("Destroy · can't be undone") or production ("Production environment"), only while it waits.
2. The header: status and live countdown, the title "Deploy · payments-api / staging" (the dialog's accessible name), "Requested 8 min ago through Claude Code.", and the Copy link and Close icon buttons.
3. A scrolling body with three sections: **Request**, **Reviewed plan** (or **What gets destroyed**), and **Note from the requester**.
4. A **pinned decision footer** with policy alerts, a one-sentence consequence, and **Deny** and **Approve**, so the decision never scrolls away.

On phones the sheet fills the screen; the footer is the thumb zone.

**Fields** are unchanged from v1:

| UI | Source |
|---|---|
| Status, countdown | `viewOf().status`, `apply_approvals.expires_at` |
| Operation, project, environment, Production | `operation`, `project_id` → `projects.name`, `environment_id` → `project_environments.name`, `.stage` |
| Requested for | `requester_user_id` → user |
| Requested through, app identity | `requester_credential` + `requester_credential_ref` → `oauth_client.name` / CIMD `clientId` host, or `cli_service_tokens.name` |
| Changes, cost, verification | plan job `plan_result` → `PlanSummary.counts`; `cost_breakdown` → `InfracostBreakdownTotals`; `verify_receipt.receipt.verdict` + `report.summary` |
| What gets destroyed | `binding.ts:appliedState` (last successful DEPLOY and its plan), environment cost as a saving |
| Plan digest, plan job | `plan_sha256` → `digestPrefix`; `plan_job_id` |
| Note | `apply_approvals.reason` (UNTRUSTED, ≤500) |
| Outcome | `approver_user_id`, `decided_at`, `consumed_job_id`, **`decision_reason`** (new, untrusted) |

**States** (every v1 state, plus the policy re-check and the second person):

| State | What the person sees |
|---|---|
| Waiting · deploy | Facts, countdown, "Approving lets **Claude Code** deploy this exact plan to `staging` once, before 14:32. If the plan changes first, the approval stops working." + Deny / Approve deploy. |
| Waiting · production | Band "Production environment", filled pill, "This environment serves your customers.", destroy count in an inverted chip if the plan removes resources. |
| Waiting · destroy | Band, destroy tag, "What gets destroyed" from the last deploy, consequences in the footer, **Approve destroy…**. |
| Destroy · type the name | `ConfirmAction level="destroy"` over the sheet (`--z-overlay-nested`); primary disabled until the name matches; the server re-checks (`confirmation_mismatch`, shown inline). |
| Expiring soon | Countdown turns into an inverted chip with m:ss, and a footer alert explains expiry. |
| No estimate · not checked | "No estimate for this plan"; verification "Not checked" (idle). |
| Deny · with reason | The footer becomes: "Reason for denying (optional)", 500 chars, "Shown to {Dana} and to {Claude Code}.", Back / **Deny request**. |
| **Blocked · agent access off** | Approve disabled. Alert: "Agent access is off in acme" · "While it's off, Claude Code can't deploy even with an approval. You can deny the request, or someone who manages agents can turn access back on in Settings → Agents." Deny enabled. |
| **Blocked · agents off production** | Approve disabled. "acme keeps agents off production" · "Only a person in the console can deploy production, so this request can only be denied." |
| **Blocked · app not allowed** (Enterprise) | Approve disabled. "Claude Code isn't an allowed agent app in acme" · "acme only lets approved apps act as agents. Deny this, or ask someone who manages agents to allow Claude Code in Settings → Agents." |
| Second person (Enterprise) | Requested through "Alethia console · Started by them, needs a second person". Otherwise a normal decision for anyone except the requester. |
| Self-approval refused (Enterprise) | Approve disabled; "Someone else needs to approve this"; Deny enabled; "Copy link for a teammate". |
| Fresh sign-in needed | Facts stay; footer: "Sign in again to decide" + **Sign in again**, which returns to the same `?approval=` URL. |
| Approved (by you) | "You approved this at 13:49. Claude Code can deploy this plan once, before 14:32." · "If it doesn't start by 14:32, the approval expires." |
| Used | "Approved by … at …. The deploy started at …" + **Open deploy job**. |
| Denied · reason shown | "{Ivan Georgiev} denied this at 13:52." + a dashed untrusted block "Reason from {Ivan Georgiev}". With no reason: the block is omitted. |
| Expired · Replaced | As v1; Replaced offers **Open the newer request**, which swaps the sheet's `approval` param. |
| Not available | "This approval isn't available to you" · "You may not have access to its project, or the link may be wrong. Ask the person who sent it." |
| Loading · Error | Sheet skeleton; shared error state ("Nothing was decided."). |

**Policy re-check (ruling 4), precisely.** The sheet's read returns, beside the approval, a `decidable` answer computed with the same functions the gate uses. `readAgentPolicy` gives the kill switch and no-production toggles; it applies only when `requester_credential` is `agent_oauth` or `agent_in_app`, exactly as `policy.ts:applyRequirement` does. `enterprise-policy.ts:oauthClientRefusal` covers the allow-list and `approverRefusal` covers self-approval. `decideApproval` re-checks the same things on approve and refuses with a new code `policy_refused` carrying the sentence, so a stale sheet cannot approve either. Deny is never blocked.

**Interactions.** Approve: `decideApplyApproval({approvalId, decision: "approve"})` with no extra dialog; the sheet is the review. Destroy goes through `ConfirmAction`. Deny sends `decision: "reject", reason`. Refusal codes map to states as in v1, plus `policy_refused` mapping to the matching Blocked state. While a request waits, the sheet re-reads on focus and every 15 s. A decision invalidates the list query, so the row's status changes underneath the sheet. Escape and the scrim close the sheet; Escape inside the destroy dialog closes only the dialog.

**Accessibility.**
- The sheet is a modal `dialog` labelled by its title. Focus moves to the close button on open and returns to the row that opened it.
- When opened from a link, focus starts in the sheet and the list underneath is inert.
- The countdown is not a live region: one polite announcement fires at 5 minutes and one at expiry.
- The outcome footer is `aria-live="polite"`.
- The reason for a disabled Approve is visible text placed before the button.

### 1.5 The sidebar waiting count: dropped

Decided against, for four reasons:
- **A person is never sent to find an approval.** Every request is created by something that hands its link straight to a person: the agent says "open this link", the CLI prints it and waits, a pipeline logs it. Discovery is the link, not the nav.
- **A number in the nav is a live claim.** It needs a count read on every page, kept fresh across tabs, and it goes stale the moment someone else decides. A stale "3" is exactly the kind of number the review rejected.
- **The audience is wrong.** Everyone in the org would see the badge, but only people with deploy or destroy access on that project can act, so most viewers would see work they cannot do.
- **The list already says it.** Waiting is the list's default filter, so the page opens on exactly the waiting requests.

If a "you have requests waiting" signal is wanted later, it belongs in notifications (per person, per project they can decide on), not as a nav count.

---
## 3. Agent policy — `/[org]/~/settings/agents`

**Purpose.** The org's switches for agents and approvals. New settings nav item "Agents" (`components/settings/settings-nav-items.ts`, in the issue's scope).

### Fields

| Setting | Source | Edition |
|---|---|---|
| Let agents work in {org} | `org_agent_policy.agent_access_enabled` (default true) | Core |
| Keep agents off production | `org_agent_policy.agents_may_not_apply_to_production` (default false) | Core |
| How long a request stays open | `org_agent_policy.approval_ttl_minutes` (1–1440, default 60; `context.ts` clamps) | Core |
| Require a different person to approve | `org_agent_policy.require_different_approver` (default false, D6) | Enterprise (§4.9, AGT-L14) |
| Allowed agent apps | `org_agent_policy.allowed_oauth_client_ids` (NULL = any) | Enterprise |
| Last changed by | `org_agent_policy.updated_by`, `updated_at` | |

A missing row means every default (`readAgentPolicy`). The first save inserts the row.

### Copy and consequences (final)

Each switch has a body line and a **consequence line** that rewrites itself for the current value, so the person reads what *will* happen, not only what the switch is called.

- **Let agents work in acme.** "When this is on, agents act for the person who connected them, within that person's access and the permissions they granted."
  - On: "Agents can read and plan. Every deploy and destroy still waits for a person's approval."
  - Off: "Every agent request is refused, including reads. Requests already waiting can't be used. The Alethia CLI and service tokens keep working."
  - Turning it off asks first (`ConfirmAction level="confirm"`): "Turn off agent access for acme?" · "Takes effect immediately for everyone in the organization." · consequences: "Connected agents and the Alethia assistant are refused every request." · "Requests already waiting for approval can't be approved or used." · "Connections are kept. Turning access back on restores them." Turning it on needs no dialog.
  - While off: an inverted banner at the top of Agents and Connected agents: "**Agent access is off.** Connected agents and the Alethia assistant can't read, plan, deploy or destroy anything in acme." + Turn back on.
- **Keep agents off production.** "Agents can still plan production environments, but only a person in the console can deploy or destroy them."
  - On: "An agent asking to deploy or destroy production is refused straight away, before anyone is asked. The Alethia CLI and service tokens still request approval as usual."
  - Off: "Agents may ask to deploy or destroy production. A person approves each request."
  - Disabled while agent access is off.
- **How long a request stays open.** "A request has to be approved **and used** within this time. Shorter is safer; longer suits teams across time zones." Presets: 15 min, 30 min, 1 hour · default, 4 hours, 24 hours. "Applies to new requests. Requests already waiting keep their time." (The *and used* matters: `gate.ts` refuses to consume an approved row past `expires_at`.)
- **Require a different person to approve** (Enterprise). "The person a request was made for can't approve it. Someone else with deploy access has to."
  - On: "Make sure at least two people have deploy access to each project, or requests there can only be denied."
  - Off: "You can approve requests made by your own agents and CLI."
  - Community/Pro: switch disabled (dashed), consequence "Available on Enterprise. On Community and Pro, the person a request was made for can approve it themselves."
- **Allowed agent apps** (Enterprise). "Any app" · "People can connect any MCP app. Each still asks them for permission." · Limit to chosen apps.
- Footer: "Last changed by {name} · {2 days ago}. Every change is recorded in Activity."

### States

Can manage agents (editable) · Agent access off · **No `org:manage_agents`** (read-only: every control disabled, inline alert "You can't change agent settings" · "Changing them needs the Manage agents permission, which your role in acme doesn't include. You can see how acme is set up; ask someone who manages roles if you need it.") · Community edition (Enterprise rows locked) · Loading · Error ("Your current settings still apply.").

### Permission (maintainer ruling)

A new PDP verb **`org:manage_agents`** in `lib/authz/registry.ts` (beside `org: view, edit, manage_billing, manage_tokens`), granted through roles like every other permission. It gates every write on this page (`updateAgentPolicy`) and the auto-approve picker on service tokens (§4). Reading the page needs `org:view`. The built-in owner role carries it by default, which keeps D2's "owner-only" for auto-approve true out of the box while letting a custom role carry it too. The Settings nav item shows for anyone with `org:view`; the page decides editability by the verb, as the rest of the console does with capability flags.

### Interactions

Each control saves on change through one `updateAgentPolicy` server action (`useActionMutation`), optimistic, with a "Saved." toast and rollback on refusal. No page-level Save button. Settings that save instantly and a Save button on the same page confuse people about what is applied.

### Accessibility

Switches are `role="switch"` with `aria-checked` and a label equal to the visible title. The consequence line is tied to the switch by `aria-describedby`, so it is read with it. TTL presets are a labelled button group with `aria-pressed`.

---

## 4. Service tokens — `/[org]/~/settings/tokens` (auto-approve environments)

**Purpose.** There is **no console surface for service tokens today**: they exist only behind the bearer API (`app/api/cli/tokens/route.ts`, `[id]/route.ts` DELETE). D2 needs an owner to choose, at mint, the non-production environments a token may deploy to without a person. This design adds the minimum page that hosts that choice: list, create, edit environments, revoke. New settings nav item "Service tokens". The toolbar carries the description and **Create token**, and no count. Minting and listing need `org:manage_tokens`.

### Fields

| UI | Source |
|---|---|
| Name | `cli_service_tokens.name` |
| Token (prefix) | `cli_service_tokens.token_prefix` (`alethia_sat_` + 8) |
| What it can do | `cli_service_tokens.scopes` (`agent_scope[]`) |
| Projects | `cli_service_tokens.project_ids` (NULL = all, present and future; never empty) |
| Deploy without approval | `cli_service_tokens.auto_approve_environment_ids` (uuid[], default `{}`) |
| Expires | `cli_service_tokens.expires_at` (`createTokenSchema.expires_in_days`) |
| Last used | `cli_service_tokens.last_used_at` |
| Status | `revoked_at` / `expires_at` → Active, Revoked, Expired |

### The picker (the part D2 asks for)

- Lists the environments of the token's projects (all projects, or only the chosen ones), grouped by project, each with its stage pill.
- **Production rows are always disabled**, with a lock icon and "Production always needs a person." They are shown rather than hidden, so nobody wonders where production went.
- The whole picker is disabled until **Deploy** is ticked under "What it can do", with "Needs the Deploy permission". A deploy needs the `apply` scope (`request.ts` asks the PDP for `deploy`).
- Without `org:manage_agents`: the picker is read-only with "You can't choose these environments" · "Choosing them needs the Manage agents permission, which your role doesn't include. You can create the token now; someone with that permission can add environments later." (D2's owner-only, expressed as the verb the owner role carries.)
- Unticking a project removes its environments from the selection.
- Each row's hint rewrites itself: ticked → "Deploys go ahead without asking anyone."; unticked → "Each deploy waits for a person."
- Fixed list under it: "Production environments always need a person." · "Destroys always need a person, everywhere." · "Every automatic deploy is recorded in Activity with this token's name."

The engine already enforces production and destroy (`policy.ts:applyRequirement` grants `automatic` only to a non-production deploy, and `context.ts:tokenAutoApproves` reads the list live). The write path must still refuse a production id, so the database never holds a value the picker could not have produced.

### States

List · Create (with picker) · No Deploy permission · No `org:manage_agents` · Edit environments (name, scopes and projects shown read-only, because no PATCH exists for them: "To change what it can do, create a new token.") · Created (shown once: "Copy your new token" · "This is the only time it's shown. Alethia stores a fingerprint, never the token." + a usage line `ALETHIA_TOKEN=… alethia deploy --project web --env staging` + what it will and won't do without approval) · Empty ("No service tokens" · "Create one for your CI pipeline. Use it as `ALETHIA_TOKEN` with the Alethia CLI.") · Loading.

### Copy (final)

- Toolbar: "Tokens let pipelines and scripts use Alethia without a person signed in. Each one is limited to what you choose."
- Scopes: **Read** "See projects, environments, jobs and logs." · **Design** "Change infrastructure designs. Nothing is created in your cloud." · **Plan** "Run plans and repository scans." · **Deploy** "Ask to deploy. A person approves, unless you choose environments below." · **Destroy** "Ask to destroy. A person always approves."
- Picker legend and hint: "Deploy without approval" · "Choose environments where this token's deploys go ahead without a person approving each one. For CI pipelines that deploy to staging on every merge."

### Accessibility

The picker is a `fieldset` with a legend. Disabled production rows keep their reason in `aria-describedby`. The sheet is a modal dialog with focus trapped and returned to "Create token" on close. On phones the sheet fills the screen.

---

## 5a. Connected agents — `/[org]/~/settings/connected`

### Purpose and shape (ruling 6)

The MCP apps a person has let act for them in this org, laid out as the **connectors board**. The anatomy is copied from `apps/console/components/connectors/connector-card.tsx`, part for part:

| Connector card part | Here |
|---|---|
| `rounded-xl border bg-background p-4 shadow-sm`, hover raises the border | same |
| 36px logo tile (`size-9 rounded-lg border bg-muted/40 p-1.5`), mark at 24px | same; brand mark at 24px |
| name (two-line clamp) + two-line description | app name + one-line description of the app |
| status dot top right: filled with a halo when connected, outline when not | same |
| `border-t` meta row in mono `text-ui-2xs`, rounded chips (`1 account`, `Org`) + state label | chip: projects ("All projects" / "2 projects" / the project name); state label: "Used 8 min ago", "Not used in 30 days", "Not connected", "Paused · agent access off" |
| one action on the right: Connect / Manage / Reconnect | **Manage** (connected) or **Set up** (not connected, opens that app's docs page under `/docs/agents/`) |
| filter bar (`connectors-filter-bar.tsx`) | search + Status facet (Connected, Not connected) |
| manage sheet (`connector-detail-sheet.tsx`) | the **Manage** sheet below |

Connected cards sort first. The grid is `repeat(auto-fill, minmax(280px, 1fr))`, the connectors minimum, and collapses to one column on phones.

### Brand marks

**Source.** The console draws third-party marks inline from **simple-icons path data with the brand hex**, in `components/alerts/channel-icon.tsx` (the `BRAND` map). Agent marks use the same source and the same shape, a new `components/settings/agents/agent-icon.tsx` with a `BRAND` map keyed by app. Extracted for the prototype from `simple-icons@16.38.1`:

| App | simple-icons slug | Brand hex | Drawn as |
|---|---|---|---|
| Claude Code | `claudecode` | `#D97757` | brand colour |
| Claude (web, desktop) | `claude` | `#D97757` | brand colour |
| Cursor | `cursor` | `#000000` | foreground ink |
| GitHub Copilot (agent mode in VS Code) | `githubcopilot` | `#000000` | foreground ink |
| Gemini CLI | `googlegemini` | `#8E75B2` | brand colour |
| Windsurf | `windsurf` | `#0B100F` | foreground ink |
| Zed | `zedindustries` | `#084CCF` | brand colour |
| Cline | `cline` | `#18181B` | foreground ink |
| OpenAI Codex | not in simple-icons (OpenAI's marks were removed at the owner's request) | — | prototype uses the Codex mark from `@lobehub/icons-static-svg@1.106.0` as a stand-in |

Production notes:
- **OpenAI Codex** must ship OpenAI's own file under `packages/assets/static/icons/openai/`, rendered through `ConnectorIcon` (the connector-mark path). That is the console's other brand-icon source, used for GitHub, GitLab, Vault and others.
- **VS Code** has no mark in simple-icons either (Microsoft's marks were removed), which is why the VS Code client shows as **GitHub Copilot**, the MCP client actually doing the work there.
- #3907's rulings require checking each owner's terms before shipping. Windsurf and JetBrains publish brand pages; the rest need checking. That check is a pre-merge step for the lane.

**Unrecognised apps.** An app connected through its own CIMD metadata that is not in the catalogue (the prototype's "Release bot", `tools.acme.io`) shows `oauth_client.icon` if it has one, otherwise a **neutral Lucide glyph** (`Bot`) in the tile. Never a letter. This departs on purpose from `ConnectorIcon`'s monogram fallback.

**Colour when connected.** The maintainer asked for marks "colored when connected". The connectors code does this only for **non**-third-party marks: `mono={!isConnected && !isThirdPartyMark(...)}`. Third-party marks keep their owners' colours in every state, because the owners' terms forbid recolouring (ruling #3907, `docs/legal/DESIGN_SYSTEM_AUDIT.md`). Agent marks are third-party marks, so "match the connectors exactly" means **always in colour**. Connection reads from the filled dot, the meta row and the action. The prototype's **Grayscale unconnected** toggle shows the alternative; adopting it needs a legal ruling per vendor (O3).

### Fields

| UI | Source |
|---|---|
| Connected apps | `agent_oauth_grants` where `user_id = me`, `org_id = org`, `revoked_at IS NULL` ⋈ `oauth_client` |
| Available apps | a **known-agent catalogue** (new): slug, name, one-line description, CIMD client-id pattern, docs path, brand mark |
| Projects chip | `agent_oauth_grants.project_ids` (NULL = "All projects") |
| Last used | derived: latest `agent_tool_calls.created_at` for `(client_id, user_id)` |
| Manage sheet: Can | `agent_oauth_grants.scopes`, in the consent wording |
| Manage sheet: Connected, app identity | `created_at`; `oauth_client.clientId` (the CIMD URL) |

### States

Connected + available · Manage sheet · Disconnect (`ConfirmAction level="confirm"`: "Disconnect {Claude Code}?" · "{Claude Code} loses access to acme right away." · "Its requests waiting for approval can't be used." · "Jobs it already started keep running." · "To use it again, connect it again from the app.") · Agent access off (banner, connected cards read "Paused · agent access off") · None connected (every card "Not connected" + "You haven't connected an agent to acme yet. Pick an app below for its setup steps, or run `alethia agent setup`.") · No search match · Loading.

**Copy.** Toolbar: "Apps you've let act for you in acme. They can only do what you can, limited to what you granted." Manage sheet: "To change what {Claude Code} can do, connect it again from the app. You'll see what changes before you allow it." Footnote: "Only you can see and disconnect your connections."

**Accessibility.** Each brand `svg` is `role="img"` with the app's name. Each action carries the app's name ("Manage Claude Code", "Set up Cursor"), as the connectors' "<verb> <connector>" controls do. The dot is `aria-hidden`; the state label says the same thing in words.

---

## 5b. Consent screen — `/auth/oauth/consent` (replaces `components/forms/oauth-consent-form.tsx`)

The layout was approved in v1: identity, organization, "{App} asked to" checklist, projects, the plain sentence about name and email, then Deny / Allow. v2 moves the **signed-in account** to a card at the top (it was in the footer), because "wrong account" is an edge case the person must see before they decide. It also designs every edge case below. Each one is a state in the prototype.

| # | Edge case | Detection (source) | Design |
|---|---|---|---|
| 1 | **Default**, verified app, two orgs | `oauth_client.clientDiscoveryId` set (CIMD) | Brand mark, "Verified by `claude.ai`, which publishes this app's identity." Orgs as a radio list with "Your role: Admin / Viewer". |
| 2 | **Many orgs** (more than 5) | memberships | Search field ("Search your 12 organizations") over a scrolling radio list (220px). Empty search: "No organization matches." |
| 3 | **No org** (community user, personal workspace only) | `Actor.orgId === userId` | No picker: "Your personal workspace" · "You aren't in an organization. {App} works in your personal workspace." |
| 4 | **Unknown or unverified app** | no `clientDiscoveryId`; `name` self-asserted | Neutral glyph, “Release helper” · name given by the app, "Alethia couldn't confirm who publishes this app. After you allow, you'll be sent to `localhost:5173`." (the redirect host), a strong alert "Only allow apps you set up yourself", and the button reads **Allow unverified app**. |
| 5 | **App not on the org's allow-list** (Enterprise) | `allowed_oauth_client_ids` via `enterprise-policy.ts:oauthClientRefusal` | That org's radio shows a "Not allowed" pill; choosing it shows "acme doesn't allow Windsurf" · "acme only lets approved apps act as agents. Choose another organization, or ask someone who manages agents in acme to add Windsurf." Every control is locked and Allow is disabled until another org is chosen. |
| 6 | **Agent access off in the org** | `agent_access_enabled = false` | "Agents are turned off in acme" · "Someone who manages agents in acme has turned agent access off. Choose another organization, or ask them." Allow disabled. |
| 7 | **Org keeps agents off production** | `agents_may_not_apply_to_production` | Informational: "acme keeps agents off production" · "{App} can plan production environments, but only a person can deploy or destroy them." Allow enabled. |
| 8 | **A scope the person's role can't use** | PDP `can(actor, verb, org)` per scope (`view`, `edit`, `plan`, `deploy`, `destroy`) | The row is unticked and disabled: "Your role in globex (Viewer) can't deploy, so this isn't offered." A scope only narrows the role, so offering it would grant nothing and mislead. |
| 9 | **Zero projects** | org has no projects | Only "All projects" · "acme has no projects yet. {App} will see the ones you create." |
| 10 | **Many projects** (more than 6) | — | "Only these projects" opens a search ("Search 14 projects") over a scrolling checklist, with "2 chosen: checkout-api, web" below. "Choose at least one project, or allow all." blocks Allow when none is chosen. |
| 11 | **Re-consent with an existing grant** | existing `agent_oauth_grants` for `(user, client, org)` | Alert "You connected Claude Code to acme on 3 Nov" · "Allowing replaces that connection with the choices below. Changes are marked." Rows carry **New** / **Removing** pills. A "What changes" box reads "Adds Ask to destroy · Removes Change designs · Projects stay: all projects". The button reads **Update connection**. |
| 12 | **Scopes beyond the known set** | requested ∖ `MCP_PROVIDER_SCOPES` | "Not offered by Alethia" · "{App} also asked for `billing:write` and `admin`. Alethia has no such permissions, so they won't be granted." The known scopes proceed. |
| 13 | **No Alethia scopes at all** (only `openid`/`profile`) | `agentScopesFromClaims` → `no_scope` | A message page: "Claude Code didn't ask for any Alethia permissions" · "It only asked to know who you are, which isn't enough to work in Alethia. Deny this, and check the app's setup guide." Deny only. |
| 14 | **Wrong account** | session user | Account card at the top with "Not you? Switch account". Switching shows "Sign in with another account" · "You'll come straight back here to finish connecting Claude Code. Nothing has been granted yet." The consent code is preserved through sign-in. |
| 15 | **Submitting** | — | Allow reads "Allowing…" with a spinner; both buttons disabled. |
| 16 | **Network error on submit** | fetch fails | Alert above the buttons: "Couldn't reach Alethia" · "Nothing was granted. Check your connection and try again." Buttons re-enable and choices are kept. |
| 17 | **Denied** | — | "You denied Claude Code" · "Claude Code was told no and has no access to Alethia. You can close this page." (shown briefly before the redirect to the app with `access_denied`). |
| 18 | **Allowed** | — | "Returning to Claude Code…" · "Claude Code can now work in acme with the permissions you chose. If nothing happens in a few seconds, go back to Claude Code yourself." + Return to Claude Code / Manage connections. |
| 19 | **Expired consent code** | consent endpoint: expired | "This request has expired" · "Connection requests are valid for a few minutes. Go back to the app and connect again." |
| 20 | **Consent code already used** | consent endpoint: used | "This request was already answered" · "Someone already allowed or denied this request, maybe in another tab. Go back to the app; if it isn't connected, connect again from there." |
| 21 | **Opened directly** (no `consent_code`) | query | "Nothing to connect" · "This page opens when an app such as Claude Code or Cursor asks to connect to Alethia. Start from that app to continue." |
| 22 | **Loading** | — | Skeleton of the column. |

Default ticks: every requested scope the role can use **except Ask to destroy**, which the person opts into. "Choose at least one, or deny." blocks Allow when nothing is ticked.

---

## 6. Gaps in the data model

| # | Gap | Status in v2 | Smallest fix |
|---|---|---|---|
| G1 | `approvePath` had no org. | **Closed by design** (§1.2): `approvalsPath(orgSlug, id)` → `/[org]/~/approvals?approval=<id>`, plus a redirecting legacy route. | Change `http.ts` and the two callers (MCP `approve_url`, CLI). |
| G2 | No list read for approvals. | Open | `orpc.approvals.list` (keyset `(created_at, id)`, `infiniteOptions`) + `queryApprovalsPage` with the facet pass. |
| G3 | No deny reason. | **Ruled in**: `apply_approvals.decision_reason text` (nullable, untrusted, ≤500). | The column and a `reason` field on `decisionInput`; returned on the read for the outcome block. |
| G4 | No way to withdraw an approval. | Open (copy says it isn't available) | Allow `approved → rejected` before use, or keep out of scope. |
| G5 | No destroy-mode plan. | Open | As v1. |
| G6 | Supersede reason not stored; no "newer request" lookup. | Open | Persist the stale reason; look up the live request for the same environment and operation. |
| G7 | No read/write action for `org_agent_policy`; no verb. | **Verb ruled**: `org:manage_agents`. | Add the verb to `registry.ts` and the owner role; `updateAgentPolicy` action with audit. |
| G8 | Consent writes no `agent_oauth_grants` row; no narrowed scopes, no org on the grant, no revoke. | Open, and every consent edge case depends on it | A server step around the consent call: write the grant (org, scopes ∩ known ∩ role, projects), drop unknown scopes, read the existing grant for the re-consent diff, and refuse an org whose allow-list or kill switch blocks the client. Revoke sets `revoked_at` and deletes the client's tokens and consent. |
| G9 | No "last used" for a connected agent. | Open | Derive from `agent_tool_calls`; index `(client_id, user_id, created_at)`. |
| G10 | `auto_approve_environment_ids` has no write path. | Open | As v1, gated by `org:manage_agents`. |
| G11 | No console surface or actions for service tokens. | Open | As v1. |
| G12 | `STATUS_TIER` lacks `expired`, `superseded`, `consumed`. | Open | Explicit `tier`, as designed. |
| G13 | Kill switch's reach to reads depends on L3. | Open | As v1. |
| G14 | **New.** The decide-time policy re-check (ruling 4) is not in `decide.ts`: it checks the session, PDP, status, expiry, binding and self-approval, not the kill switch, no-production or the allow-list. | Open | A `decidable(approval)` helper sharing `applyRequirement` and the enterprise refusals, used by the read (to disable Approve) and by `decideApproval` (new refusal code `policy_refused`). |
| G15 | **New.** No **known-agent catalogue** mapping OAuth clients (CIMD URLs) to a display name, description, mark and docs page. | Open | A static catalogue in `components/settings/agents/agent-catalog.ts`; matched by CIMD client-id host; unknown clients fall back to `oauth_client.name` / `icon` and the neutral glyph. |
| G16 | **New.** OpenAI's mark is not in simple-icons; VS Code's neither. | Open | Ship OpenAI's own file under `packages/assets/static/icons/openai/` after checking its terms; show VS Code's client as GitHub Copilot. |
| G17 | **New.** The consent page cannot tell "expired" from "already used": the consent endpoint's failure is one error. | Open | Distinguish the two in the consent step's response (or show the shared wording "This request is no longer valid"). |

## 7. Open decisions for the maintainer

Resolved by the review and removed: who may change agent policy (verb), decide-time re-check (yes), deny reason (yes), confirm dialog for deploy (none, unchanged), Approvals nav (list is the home; the count is dropped, §1.5), org-less link (closed).

| # | Question | Recommendation |
|---|---|---|
| O1 | Service tokens get a new settings page (none exists). The issue's `scope:` globs don't include it. | Widen the scope to `components/settings/tokens/**` and the route. |
| O2 | Can people with `org:manage_agents` see and disconnect **other people's** connected agents? | Later, on the member's detail page. Beta: your own only. |
| O3 | "Colored when connected" for agent marks conflicts with ruling #3907 (third-party marks keep owner colours in every state, as connector marks do). Keep the ruling, or seek a per-vendor ruling to grayscale unconnected agent marks? | Keep the ruling: it is what the connectors do today, so it is the "exact match". The toggle in the prototype shows the alternative. |
| O4 | On Community and Pro, show the Enterprise toggles locked or hide them? | Locked, with "Available on Enterprise". |
| O5 | TTL as presets only? | Yes: 15 min, 30 min, 1 h, 4 h, 24 h. |
| O6 | Consent: leave **Ask to destroy** unticked by default? | Yes. |
| O7 | Consent: should an **unverified** app (no CIMD) be allowed at all in orgs without an allow-list? | Allowed with the extra friction designed in case 4; Enterprise orgs can refuse it through the allow-list. |
| O8 | Legacy `/approvals/<id>` redirect: keep for how long? | One CLI minor release after the URL change, then delete. |

## 8. What this design does not cover

The in-app assistant's approval card (L5) should render the same approval record with the sheet's components (status, digest, counts, decision footer). `components/agent/approval-card.tsx` is L5's. The CLI's `alethia approve` (L7) opens the `?approval=` URL.
