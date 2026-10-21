// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Who hears about a change (#6115, ADR 0005 D3 + §10 R6). Pure: no database, no PDP, no I/O, so
// every population below is a unit test (tests/lib/realtime/routing.test.ts).
//
// THE RULE. A topic's routing keys follow the arms of its table's RLS policy, and every key is
// scoped to ONE org: a stream opened for an org hears about that org's rows and nothing else.
// `jobs`' policy is `owner_all`:
//
//     user_id = current_owner  OR  org_id = current_org          (lib/db/programmables.sql)
//
// so a jobs notice routes to two keys, both inside the row's own org:
//   · the org arm   `o:<org_id>`           — every member of the org; a delivery reached ONLY through
//                                            it is filtered through the PDP's `view` on the job's
//                                            project (lib/realtime/bus.ts);
//   · the owner arm `ou:<org_id>:<user_id>` — the person who wrote the job, in that org; unfiltered,
//                                            because the jobs read returns a person's own jobs
//                                            whatever their project grants.
// A row with no org (none exist for jobs today) routes to `u:<user_id>`, which only the personal
// scope (`/~/~/events`, org === user) subscribes to.
//
// The populations this has to get right (§10 R6):
//   · a project job                       → o:<project's org>, ou:<that org>:<creator>.
//   · a project-less job from a service    → org_id was stamped = user_id (set_org_id_from_project's
//     insert inside a hosted org             last fallback), so it lives in the creator's personal
//                                            scope and is heard on `/~/~/events`.
//   · a job whose project was deleted      → the trigger carries OLD.project_id; the bus treats a
//                                            project that no longer exists as unfiltered.
//   · managed runners (org_id/user_id NULL), fleet tables (no org_id) → the `platform` key, held only
//     by a stream whose actor may `view` the fleet on a deployment that operates one (#6123).
//
// `runners`' policy is NOT owner_all. It is `org_id = current_org OR org_id = current_owner`
// (lib/db/programmables.sql, runners_select), so a runner routes by its ORG alone:
//   · a runner of an org            → `o:<org_id>` — every member of that org (no project, so no filter);
//   · a runner of a personal scope  → `own:<user_id>` (org_id = user_id): the policy's second arm shows it
//                                     from EVERY scope of that person, so every one of their streams
//                                     holds this key — and nobody else's does;
//   · a managed runner (no org, no owner) → `platform`.

import { type Hint, isTopic, SELF_TEST_TOPIC, type Topic } from "./topics";

/** A change notice as the trigger sends it: identifiers only (lib/db/programmables.sql emit_change). */
export interface ChangeNotice {
	kind: "change";
	t: Topic;
	id: string | null;
	o: string | null;
	u: string | null;
	p: string | null;
}

/** The bus's own self-test echo (never forwarded). */
export interface SelfTestNotice {
	kind: "selftest";
	nonce: string;
}

/** One routing key a notice is delivered to, and whether a delivery through it is PDP-filtered. */
export interface Route {
	key: string;
	/** The project to ask the PDP about, when this arm needs the filter; null when it does not. */
	filterProject: string | null;
}

/** What a stream's actor may see beyond its own org and its own rows. */
export interface StreamCapabilities {
	/** `can(actor, 'view', {type: 'fleet'})` — receives `platform` (managed runners, fleet). */
	fleetView: boolean;
	/** `can(actor, 'manage_support', {type: 'support_case'})` — receives every case in the org. */
	manageSupport: boolean;
	/** `can(actor, 'view_alerts', {type: 'alert'})` — receives the org's alert changes. */
	viewAlerts: boolean;
}

/** The subscriber side of {@link Route}: who the stream is. */
export interface StreamIdentity {
	userId: string;
	orgId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A uuid string, or null for anything else (a malformed payload routes nowhere). */
function uuidOrNull(value: unknown): string | null {
	return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
}

/**
 * Parses one `alethia_change` payload. Returns null for anything that is not a well-formed notice:
 * an unknown topic, a non-uuid id. A notice is identifiers only, so this is also the boundary that
 * makes sure nothing but a topic name and a uuid can ever reach a hint frame.
 */
export function parseNotice(raw: unknown): ChangeNotice | SelfTestNotice | null {
	if (typeof raw !== "object" || raw === null || !("t" in raw)) return null;
	const t = raw.t;
	if (t === SELF_TEST_TOPIC) {
		if (!("n" in raw) || typeof raw.n !== "string" || raw.n.length === 0) return null;
		return { kind: "selftest", nonce: raw.n };
	}
	if (typeof t !== "string" || !isTopic(t)) return null;
	const field = (name: "id" | "o" | "u" | "p"): string | null =>
		name in raw ? uuidOrNull(Reflect.get(raw, name)) : null;
	return { kind: "change", t, id: field("id"), o: field("o"), u: field("u"), p: field("p") };
}

/**
 * The routing keys of one notice. `jobs`, `environments`, `addons`, `support`, `alerts`, `usage`,
 * `billing`, `clusters`, `projects`, `organization`, `runners` and `fleet` have producers; every
 * other topic is declared and routes NOWHERE until its lane adds both its trigger and its row here —
 * a topic that routed before its RLS arms were written down would be a guess about who may read it.
 */
export function keysFor(notice: ChangeNotice): Route[] {
	switch (notice.t) {
		case "support": {
			// support_cases' policy is NOT owner_all: it is org-scoped FIRST and then tiered —
			//     org_id = current_org AND (support_all OR user_id = current_owner)
			// so there is no org-wide arm. A case routes to its requester inside its own org, and to
			// the org's `osupport:` key, which a stream holds only when its actor may
			// `manage_support` (subscriptionKeys) — the same capability that sets `support_all`. A
			// teammate who is neither hears nothing, exactly as RLS shows them nothing. A case with no
			// org (none exist: org_id is stamped on insert) routes nowhere rather than to `u:`.
			if (!notice.o || !notice.u) return [];
			return [
				{ key: orgUserKey(notice.o, notice.u), filterProject: null },
				{ key: orgSupportKey(notice.o), filterProject: null },
			];
		}
		case "runners": {
			// Managed: no owner AND no org (runners_operator_owner_ck). A self runner always has both once
			// the org backfill has run; one without an org matches neither RLS arm, so it routes nowhere.
			if (!notice.o) return notice.u ? [] : [{ key: PLATFORM_KEY, filterProject: null }];
			if (notice.o === notice.u) return [{ key: ownKey(notice.o), filterProject: null }];
			return [{ key: orgKey(notice.o), filterProject: null }];
		}
		// fleet_pools carry no org: platform rows, heard only with fleet:view (subscriptionKeys).
		case "fleet":
			return [{ key: PLATFORM_KEY, filterProject: null }];
		case "jobs": {
			const routes: Route[] = [];
			// The org arm. A job with no project is visible to the whole org by RLS, so it is unfiltered;
			// a project job is filtered on that project's `view`.
			if (notice.o) routes.push({ key: orgKey(notice.o), filterProject: notice.p });
			// The owner arm, inside the row's own org: never filtered (see the header).
			if (notice.u) {
				const key = notice.o ? orgUserKey(notice.o, notice.u) : userKey(notice.u);
				routes.push({ key, filterProject: null });
			}
			return routes;
		}
		// project_cluster (#6122). Its RLS is the project's: the org arm, or the PROJECT's owner, which
		// is not a column of the row — so there is no owner route. Every delivery is filtered through
		// the PDP's `view` on the cluster's project.
		case "clusters":
			return notice.o ? [{ key: orgKey(notice.o), filterProject: notice.p }] : [];
		// project_environments, project_fabrics, the component family (`environments`) and
		// project_addons (`addons`), #6119. Their RLS is the project's: the org arm, or the PROJECT's
		// owner (`projects.user_id`) — which is not a column of these rows, so there is no owner route.
		// `u` on an environments notice is the environment's CREATOR, not an RLS arm, and is ignored.
		// Every delivery is filtered through the PDP's `view` on the row's project.
		case "environments":
		case "addons":
			return notice.o ? [{ key: orgKey(notice.o), filterProject: notice.p }] : [];
		// alert_rules, alert_channels, alert_rule_channels and alert_deliveries (#6125). They are read
		// on the service connection under an explicit `org_id` predicate behind the PDP's
		// `view_alerts` — no RLS arm, and no owner: a delivery can describe a SECURITY event (an
		// `authz.*` denial), so an alerts notice never goes to the org-wide `o:` key. It routes to the
		// org's `oalerts:` key, which a stream holds only when its actor may `view_alerts`
		// (subscriptionKeys) — the same decision every alerts read makes. No project: a policy or a
		// delivery is org-level, so there is nothing to filter on.
		case "alerts":
			return notice.o ? [{ key: orgAlertsKey(notice.o), filterProject: null }] : [];
		// #6128: a project row. Both arms of its RLS policy are on `org_id` (`org_id = current_org OR
		// org_id = current_owner`), and the personal scope's stream subscribes `o:<its user>`, which is
		// that scope's org — so the org arm is the only route. Filtered on the project ITSELF (the
		// trigger sends its own id as `p`); a deleted project no longer exists and is unfiltered.
		case "projects":
			return notice.o ? [{ key: orgKey(notice.o), filterProject: notice.p }] : [];
		// #6128: the organization row (name, slug, logo, General settings). Every member reads it, so
		// the org arm is unfiltered.
		case "organization":
			return notice.o ? [{ key: orgKey(notice.o), filterProject: null }] : [];
			return [];
		// #6127: the billing record + invoice mirror (`billing`, triggers in lib/db/programmables.sql)
		// and AI spend (`usage`, the app-layer `emitUsageHint` in lib/realtime/usage-hint.ts — at most
		// once per 30 s per org, after commit, outside the AI-budget lock). Both are ORG-WIDE facts —
		// the usage page's meters and the plan card are the same for every member, and the reads
		// behind them apply their own permission — so a notice routes on the org arm, unfiltered,
		// with no row id (neither producer sends one). A notice with no org belongs to its owner's
		// personal scope.
		case "usage":
		case "billing": {
			if (notice.o) return [{ key: orgKey(notice.o), filterProject: null }];
			if (notice.u) return [{ key: userKey(notice.u), filterProject: null }];
			return [];
		}
	}
}

/** The routing key of an org's arm. */
function orgKey(orgId: string): string {
	return `o:${orgId}`;
}

/** The routing key of a person's own rows that carry no org (personal scope only). */
function userKey(userId: string): string {
	return `u:${userId}`;
}

/**
 * The routing key of rows in a person's PERSONAL scope that an RLS arm shows from every scope of
 * theirs (`org_id = current_owner`, the runners policy). Every stream of that person holds it.
 */
function ownKey(userId: string): string {
	return `own:${userId}`;
}

/** The routing key of a person's own rows inside one org (the owner arm). */
function orgUserKey(orgId: string, userId: string): string {
	return `ou:${orgId}:${userId}`;
}

/** The routing key of every support case in an org (manage_support). */
function orgSupportKey(orgId: string): string {
	return `osupport:${orgId}`;
}

/** The routing key of every alert change in an org (view_alerts). */
function orgAlertsKey(orgId: string): string {
	return `oalerts:${orgId}`;
}

/** The routing key of platform-wide rows: managed runners and the fleet. */
export const PLATFORM_KEY = "platform";

/**
 * The keys a stream subscribes to — all of them scoped to the stream's org, except `own:`, the
 * stream's own person's personal-scope rows that RLS shows from every scope (see the header). `u:`
 * (rows with no org) is held only by the personal scope, where org and user are the same id.
 */
export function subscriptionKeys(
	actor: StreamIdentity,
	caps: StreamCapabilities,
): string[] {
	const keys = [orgKey(actor.orgId), orgUserKey(actor.orgId, actor.userId), ownKey(actor.userId)];
	if (actor.orgId === actor.userId) keys.push(userKey(actor.userId));
	if (caps.fleetView) keys.push(PLATFORM_KEY);
	if (caps.manageSupport) keys.push(orgSupportKey(actor.orgId));
	if (caps.viewAlerts) keys.push(orgAlertsKey(actor.orgId));
	return keys;
}

/** The hint a notice becomes on the wire: its topic and its row id, and nothing else. */
export function hintOf(notice: ChangeNotice): Hint {
	return notice.id ? { t: notice.t, id: notice.id } : { t: notice.t };
}
