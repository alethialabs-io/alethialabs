// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Who may hear about a change (#6115, ADR 0005 D3 + §10 R6). Pure: no database, no PDP, no I/O, so
// every population below is a unit test (tests/lib/realtime/routing.test.ts).
//
// THE RULE. A topic's routing keys are the ARMS OF ITS TABLE'S RLS POLICY, so no member is told about
// a row their read could not return. `jobs`' policy is `owner_all`:
//
//     user_id = current_owner  OR  org_id = current_org          (lib/db/programmables.sql)
//
// so a jobs notice routes to `u:<user_id>` (the owner arm) and to `o:<org_id>` (the org arm). The org
// arm is coarse — an org member who cannot view the job's project would still match it — so a
// delivery reached ONLY through the org arm is then filtered through the PDP's `view` on the project
// (lib/realtime/bus.ts). The owner arm is not filtered: RLS returns a person's own jobs regardless of
// project grants, and `getJobsPage` relies on that, so the hint must not be stricter than the read.
//
// The populations this has to get right (§10 R6):
//   · a project job                       → o:<project's org>, u:<creator>; PDP on the org arm.
//   · a project-less job from a service    → org_id was stamped = user_id (set_org_id_from_project's
//     insert inside a hosted org             last fallback), so o: and u: are the SAME person; the
//                                            subscriber is matched once (the bus dedupes per notice).
//   · a job whose project was deleted      → the trigger carries OLD.project_id, so the PDP still asks
//                                            about the project the reader last saw it under.
//   · managed runners (org_id/user_id NULL), fleet tables (no org_id) → the `platform` key, held only
//     by a stream whose actor may `view` the fleet. No topic routes there yet (#6123).

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
}

/** The subscriber side of {@link Route}: who the stream is. */
export interface StreamIdentity {
	userId: string;
	orgId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A uuid string, or null for anything else (a forged or malformed payload routes nowhere). */
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
 * The routing keys of one notice. `jobs` is the only producer today; every other topic is declared
 * and routes NOWHERE until its lane adds both its trigger and its row here — a topic that routed
 * before its RLS arms were written down would be a guess about who may read it.
 */
export function keysFor(notice: ChangeNotice): Route[] {
	switch (notice.t) {
		case "jobs": {
			const routes: Route[] = [];
			// The org arm. A job with no project is visible to the whole org by RLS, so it is unfiltered;
			// a project job is filtered on that project's `view`.
			if (notice.o) routes.push({ key: orgKey(notice.o), filterProject: notice.p });
			// The owner arm: never filtered (see the header).
			if (notice.u) routes.push({ key: userKey(notice.u), filterProject: null });
			return routes;
		}
		// TODO(#6119/#6120): project_environments + the component tables — o:, u: where an owner arm
		// exists; project view filter.
		case "environments":
		// TODO(#6131): projects — o:, u:; project view filter on the row's own id.
		case "projects":
		// TODO(#6122): project_cluster — o: only; project view filter.
		case "clusters":
		// TODO(#6123): runners — o:/u: for self runners; managed runners (org_id NULL) → platform.
		case "runners":
		// TODO(#6123): fleet_pools config columns + fleet_actions INSERT → platform. Never fleet_leader.
		case "fleet":
		// TODO(#6119): project_addons — o:; project view filter.
		case "addons":
		// TODO(#6125): alert_deliveries — o: (no user_id); subscribed only with the alerting entitlement.
		case "alerts":
		// TODO(#6130/#6114): support_cases — ou:<org>:<user>, osupport:<org> (manage_support only).
		case "support":
		// TODO(#6127): no trigger — an app-layer emitUsageHint(orgId), at most once per 30s per org.
		case "usage":
			return [];
	}
}

/** The routing key of an org's arm. */
function orgKey(orgId: string): string {
	return `o:${orgId}`;
}

/** The routing key of a person's own rows (the owner arm), in every org. */
function userKey(userId: string): string {
	return `u:${userId}`;
}

/** The routing key of a person's own rows inside one org (support cases). */
function orgUserKey(orgId: string, userId: string): string {
	return `ou:${orgId}:${userId}`;
}

/** The routing key of every support case in an org (manage_support). */
function orgSupportKey(orgId: string): string {
	return `osupport:${orgId}`;
}

/** The routing key of platform-wide rows: managed runners and the fleet. */
export const PLATFORM_KEY = "platform";

/**
 * The keys a stream subscribes to. In the personal scope `orgId === userId`, so `o:` and `u:` name
 * the same person; both are kept because they are different arms of different tables' policies.
 */
export function subscriptionKeys(
	actor: StreamIdentity,
	caps: StreamCapabilities,
): string[] {
	const keys = [
		orgKey(actor.orgId),
		userKey(actor.userId),
		orgUserKey(actor.orgId, actor.userId),
	];
	if (caps.fleetView) keys.push(PLATFORM_KEY);
	if (caps.manageSupport) keys.push(orgSupportKey(actor.orgId));
	return keys;
}

/** The hint a notice becomes on the wire: its topic and its row id, and nothing else. */
export function hintOf(notice: ChangeNotice): Hint {
	return notice.id ? { t: notice.t, id: notice.id } : { t: notice.t };
}
