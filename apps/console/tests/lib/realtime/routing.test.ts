// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6115 (ADR 0005 D3, §10 R6): who may hear about a change. Pure — every population the routing rule
// has to get right is one case here, and the wire boundary (nothing but a topic and a uuid can become
// a hint) is pinned on malformed payloads.

import { describe, expect, it } from "vitest";
import {
	type ChangeNotice,
	hintOf,
	keysFor,
	PLATFORM_KEY,
	parseNotice,
	subscriptionKeys,
} from "@/lib/realtime/routing";
import { isTopic, SELF_TEST_TOPIC, TOPICS } from "@/lib/realtime/topics";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const JOB = "44444444-4444-4444-8444-444444444444";

/** A jobs notice with the trigger's shape. */
function jobs(over: Partial<ChangeNotice> = {}): ChangeNotice {
	return { kind: "change", t: "jobs", id: JOB, o: ORG, u: USER, p: PROJECT, ...over };
}

describe("parseNotice — the payload boundary", () => {
	it("parses the trigger's payload", () => {
		expect(parseNotice({ t: "jobs", id: JOB, o: ORG, u: USER, p: PROJECT })).toEqual(jobs());
	});

	it("reads JSON nulls (a project-less job) as null", () => {
		expect(parseNotice({ t: "jobs", id: JOB, o: ORG, u: USER, p: null })).toEqual(
			jobs({ p: null }),
		);
	});

	it("refuses an unknown topic, a non-object and a missing topic", () => {
		expect(parseNotice({ t: "nope", id: JOB })).toBeNull();
		expect(parseNotice("jobs")).toBeNull();
		expect(parseNotice(null)).toBeNull();
		expect(parseNotice({ id: JOB })).toBeNull();
	});

	it("drops any field that is not a uuid, so it can never reach a frame", () => {
		const parsed = parseNotice({
			t: "jobs",
			id: 'x"\n\nevent: revoked',
			o: "not-a-uuid",
			u: USER,
			p: 42,
		});
		expect(parsed).toEqual({ kind: "change", t: "jobs", id: null, o: null, u: USER, p: null });
	});

	it("recognises the self-test echo, and only with a nonce", () => {
		expect(parseNotice({ t: SELF_TEST_TOPIC, n: "abc" })).toEqual({
			kind: "selftest",
			nonce: "abc",
		});
		expect(parseNotice({ t: SELF_TEST_TOPIC })).toBeNull();
		expect(parseNotice({ t: SELF_TEST_TOPIC, n: "" })).toBeNull();
	});
});

describe("keysFor — the arms of jobs' owner_all policy, each inside the row's org", () => {
	it("a project job routes to the org arm (PDP-filtered on its project) and the owner arm in that org (not)", () => {
		expect(keysFor(jobs())).toEqual([
			{ key: `o:${ORG}`, filterProject: PROJECT },
			{ key: `ou:${ORG}:${USER}`, filterProject: null },
		]);
	});

	it("a project-less job is visible to the whole org by RLS, so its org arm is unfiltered", () => {
		expect(keysFor(jobs({ p: null }))).toEqual([
			{ key: `o:${ORG}`, filterProject: null },
			{ key: `ou:${ORG}:${USER}`, filterProject: null },
		]);
	});

	it("a service insert stamped org_id = user_id (R6) routes into that person's personal scope", () => {
		expect(keysFor(jobs({ o: USER, p: null })).map((r) => r.key)).toEqual([
			`o:${USER}`,
			`ou:${USER}:${USER}`,
		]);
	});

	it("a row with an owner but no org routes to u:, which only the personal scope holds", () => {
		expect(keysFor(jobs({ o: null })).map((r) => r.key)).toEqual([`u:${USER}`]);
	});

	it("a person's job in org B shares no key with that person's org-A stream", () => {
		const OTHER = "55555555-5555-4555-8555-555555555555";
		const inB = keysFor(jobs({ o: OTHER, p: null })).map((r) => r.key);
		const streamA = subscriptionKeys(
			{ userId: USER, orgId: ORG },
			{ fleetView: true, manageSupport: true, viewAlerts: false },
		);
		expect(inB.filter((k) => streamA.includes(k))).toEqual([]);
	});

	it("a row with neither org nor owner routes nowhere", () => {
		expect(keysFor(jobs({ o: null, u: null }))).toEqual([]);
	});

	it("every topic without a producer routes nowhere until its lane writes its arms", () => {
		const routed = new Set(["jobs", "environments", "addons", "support", "alerts", "usage", "billing", "clusters", "projects", "organization"]);
		for (const t of TOPICS.filter((x) => !routed.has(x))) {
			expect(keysFor({ ...jobs(), t })).toEqual([]);
		}
	});

	// #6122: project_cluster carries no user_id; its RLS owner arm is the PROJECT's owner, not a column.
	it("a cluster routes on its org arm only, filtered on its project's view", () => {
		const cluster: ChangeNotice = { kind: "change", t: "clusters", id: JOB, o: ORG, u: null, p: PROJECT };
		expect(keysFor(cluster)).toEqual([{ key: `o:${ORG}`, filterProject: PROJECT }]);
		// Even a notice that carried a user would not open an owner route for it.
		expect(keysFor({ ...cluster, u: USER })).toEqual([{ key: `o:${ORG}`, filterProject: PROJECT }]);
		expect(keysFor({ ...cluster, o: null })).toEqual([]);
	});
});

describe("keysFor — the board's topics (#6119): the project's RLS, so the org arm only", () => {
	it.each(["environments", "addons"] as const)(
		"%s routes to the org arm, PDP-filtered on the row's project — never to the owner arm",
		(t) => {
			// `u` on an environments notice is the environment's CREATOR, which is not an RLS arm of
			// these tables (their owner arm is the PROJECT's owner): routing on it would tell the creator
			// about a project they may since have lost access to.
			expect(keysFor({ ...jobs(), t })).toEqual([{ key: `o:${ORG}`, filterProject: PROJECT }]);
		},
	);

	it.each(["environments", "addons"] as const)("%s with no org routes nowhere", (t) => {
		expect(keysFor({ ...jobs({ o: null }), t })).toEqual([]);
	});
});

/** A support notice with the trigger's shape: the case id, its org and its requester, no project. */
function support(over: Partial<ChangeNotice> = {}): ChangeNotice {
	return { kind: "change", t: "support", id: JOB, o: ORG, u: USER, p: null, ...over };
}

describe("keysFor — support cases follow their tiered policy, not owner_all (#6130)", () => {
	const MEMBER = "66666666-6666-4666-8666-666666666666";
	const OTHER = "55555555-5555-4555-8555-555555555555";
	/** Whether a stream with this identity and these capabilities would receive the notice. */
	const hears = (notice: ChangeNotice, userId: string, orgId: string, manageSupport: boolean) => {
		const held = subscriptionKeys({ userId, orgId }, { fleetView: false, manageSupport, viewAlerts: false });
		return keysFor(notice).some((r) => held.includes(r.key));
	};

	it("routes to the requester inside the case's org and to the org's manage_support key, unfiltered", () => {
		expect(keysFor(support())).toEqual([
			{ key: `ou:${ORG}:${USER}`, filterProject: null },
			{ key: `osupport:${ORG}`, filterProject: null },
		]);
	});

	it("the requester hears it; an owner/admin (manage_support) hears it; a teammate who is neither does NOT", () => {
		expect(hears(support(), USER, ORG, false)).toBe(true);
		expect(hears(support(), MEMBER, ORG, true)).toBe(true);
		// The org arm `o:` is NOT a support route: RLS shows a plain member none of a teammate's cases.
		expect(hears(support(), MEMBER, ORG, false)).toBe(false);
	});

	it("nobody in another org hears it, whatever they may do there", () => {
		expect(hears(support(), USER, OTHER, true)).toBe(false);
		expect(hears(support(), MEMBER, OTHER, true)).toBe(false);
	});

	it("a personal-scope case (org == requester) reaches that person's personal stream", () => {
		expect(hears(support({ o: USER, u: USER }), USER, USER, false)).toBe(true);
	});

	it("a case missing its org or its requester routes nowhere", () => {
		expect(keysFor(support({ o: null }))).toEqual([]);
		expect(keysFor(support({ u: null }))).toEqual([]);
	});
});

// #6127: the billing record + invoice mirror (`billing`) and the AI ledger (`usage`). Org-wide facts,
// sent with no row id by their triggers (lib/db/programmables.sql).
describe("keysFor — usage and billing", () => {
	const orgWide = (t: "usage" | "billing", over: Partial<ChangeNotice> = {}): ChangeNotice => ({
		kind: "change",
		t,
		id: null,
		o: ORG,
		u: null,
		p: null,
		...over,
	});

	it.each(["usage", "billing"] as const)("%s routes on the org arm, unfiltered", (t) => {
		expect(keysFor(orgWide(t))).toEqual([{ key: `o:${ORG}`, filterProject: null }]);
	});

	it.each(["usage", "billing"] as const)("%s never reaches another org's stream", (t) => {
		const OTHER = "55555555-5555-4555-8555-555555555555";
		const stream = subscriptionKeys({ userId: USER, orgId: ORG }, { fleetView: true, manageSupport: true, viewAlerts: false });
		const routed = keysFor(orgWide(t, { o: OTHER })).map((r) => r.key);
		expect(routed.filter((k) => stream.includes(k))).toEqual([]);
	});

	it("a ledger row with no org routes to its owner's personal scope only", () => {
		expect(keysFor(orgWide("usage", { o: null, u: USER }))).toEqual([
			{ key: `u:${USER}`, filterProject: null },
		]);
		const inAnOrg = subscriptionKeys({ userId: USER, orgId: ORG }, { fleetView: false, manageSupport: false, viewAlerts: false });
		expect(inAnOrg).not.toContain(`u:${USER}`);
	});

	it("a notice with neither org nor owner routes nowhere", () => {
		expect(keysFor(orgWide("billing", { o: null, u: null }))).toEqual([]);
	});

	it("the hint carries the topic alone — no invoice or ledger id reaches a frame", () => {
		expect(hintOf(orgWide("billing"))).toEqual({ t: "billing" });
	});
});

/** An alerts notice with the trigger's shape: the row id and its org — no owner, no project. */
function alerts(over: Partial<ChangeNotice> = {}): ChangeNotice {
	return { kind: "change", t: "alerts", id: JOB, o: ORG, u: null, p: null, ...over };
}

describe("keysFor — alerts reach only members who may view_alerts (#6125)", () => {
	const MEMBER = "66666666-6666-4666-8666-666666666666";
	const OTHER = "55555555-5555-4555-8555-555555555555";
	/** Whether a stream with this identity, holding view_alerts or not, would receive the notice. */
	const hears = (notice: ChangeNotice, userId: string, orgId: string, viewAlerts: boolean) => {
		const held = subscriptionKeys({ userId, orgId }, { fleetView: true, manageSupport: true, viewAlerts });
		return keysFor(notice).some((r) => held.includes(r.key));
	};

	it("routes to the org's view_alerts key only — never the org-wide o: key, unfiltered", () => {
		expect(keysFor(alerts())).toEqual([{ key: `oalerts:${ORG}`, filterProject: null }]);
	});

	it("a member with view_alerts hears it; a member without it does NOT, whatever else they may do", () => {
		expect(hears(alerts(), MEMBER, ORG, true)).toBe(true);
		// A delivery can describe a security event: the org arm is not an alerts route.
		expect(hears(alerts(), MEMBER, ORG, false)).toBe(false);
	});

	it("an owner/u: field on the notice opens no route of its own", () => {
		expect(hears(alerts({ u: MEMBER }), MEMBER, ORG, false)).toBe(false);
	});

	it("nobody in another org hears it, even with view_alerts there", () => {
		expect(hears(alerts(), MEMBER, OTHER, true)).toBe(false);
	});

	it("a notice with no org routes nowhere", () => {
		expect(keysFor(alerts({ o: null }))).toEqual([]);
	});
});

describe("keysFor — #6128: a project row and the organization row", () => {
	/** A projects notice with the trigger's shape: `p` is the project's own id. */
	const project = (over: Partial<ChangeNotice> = {}): ChangeNotice => ({
		kind: "change",
		t: "projects",
		id: PROJECT,
		o: ORG,
		u: USER,
		p: PROJECT,
		...over,
	});

	it("a project routes to its org's arm only, PDP-filtered on the project itself", () => {
		expect(keysFor(project())).toEqual([{ key: `o:${ORG}`, filterProject: PROJECT }]);
	});

	it("a personal-scope project (org_id = its owner) reaches that person's personal stream", () => {
		const keys = keysFor(project({ o: USER })).map((r) => r.key);
		const personal = subscriptionKeys({ userId: USER, orgId: USER }, { fleetView: false, manageSupport: false, viewAlerts: false });
		expect(keys.every((k) => personal.includes(k))).toBe(true);
		expect(keys).toEqual([`o:${USER}`]);
	});

	it("the project's creator is not an RLS arm: no owner route", () => {
		expect(keysFor(project()).some((r) => r.key.startsWith("ou:"))).toBe(false);
	});

	it("a project with no org routes nowhere", () => {
		expect(keysFor(project({ o: null }))).toEqual([]);
	});

	it("the organization row routes to that org's arm, unfiltered — every member reads it", () => {
		expect(keysFor({ kind: "change", t: "organization", id: ORG, o: ORG, u: null, p: null })).toEqual([
			{ key: `o:${ORG}`, filterProject: null },
		]);
	});

	it("the organization row never reaches another org's stream", () => {
		const OTHER = "55555555-5555-4555-8555-555555555555";
		const keys = keysFor({ kind: "change", t: "organization", id: OTHER, o: OTHER, u: null, p: null }).map(
			(r) => r.key,
		);
		const streamA = subscriptionKeys({ userId: USER, orgId: ORG }, { fleetView: true, manageSupport: true, viewAlerts: true });
		expect(keys.filter((k) => streamA.includes(k))).toEqual([]);
	});
});

describe("subscriptionKeys — what a stream holds", () => {
	it("a member holds the org key and their own key in that org, and nothing platform-wide", () => {
		expect(
			subscriptionKeys({ userId: USER, orgId: ORG }, { fleetView: false, manageSupport: false, viewAlerts: false }),
		).toEqual([`o:${ORG}`, `ou:${ORG}:${USER}`]);
	});

	it("fleet:view adds the platform key; manage_support adds the org's support key; view_alerts the alerts key", () => {
		const keys = subscriptionKeys(
			{ userId: USER, orgId: ORG },
			{ fleetView: true, manageSupport: true, viewAlerts: true },
		);
		expect(keys).toContain(PLATFORM_KEY);
		expect(keys).toContain(`osupport:${ORG}`);
		expect(keys).toContain(`oalerts:${ORG}`);
	});

	it("only the personal scope (orgId === userId) also holds u:", () => {
		expect(
			subscriptionKeys({ userId: USER, orgId: USER }, { fleetView: false, manageSupport: false, viewAlerts: false }),
		).toEqual([`o:${USER}`, `ou:${USER}:${USER}`, `u:${USER}`]);
	});

	it("an org member never holds another org's key", () => {
		const keys = subscriptionKeys(
			{ userId: USER, orgId: ORG },
			{ fleetView: true, manageSupport: true, viewAlerts: false },
		);
		const other = "55555555-5555-4555-8555-555555555555";
		expect(keys.some((k) => k.includes(other))).toBe(false);
	});
});

describe("hintOf — what goes on the wire", () => {
	it("carries the topic and the row id and NOTHING else", () => {
		expect(hintOf(jobs())).toEqual({ t: "jobs", id: JOB });
		expect(Object.keys(hintOf(jobs()))).toEqual(["t", "id"]);
	});

	it("omits the id when the notice has none", () => {
		expect(hintOf(jobs({ id: null }))).toEqual({ t: "jobs" });
	});
});

describe("TOPICS", () => {
	it("is a duplicate-free list that does not contain the self-test topic", () => {
		expect(new Set(TOPICS).size).toBe(TOPICS.length);
		expect(isTopic(SELF_TEST_TOPIC)).toBe(false);
	});
});
