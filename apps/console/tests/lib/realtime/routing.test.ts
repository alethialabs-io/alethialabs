// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6115 (ADR 0005 D3, §10 R6): who may hear about a change. Pure — every population the routing rule
// has to get right is one case here, and the wire boundary (nothing but a topic and a uuid can become
// a hint) is pinned on hostile payloads.

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

describe("keysFor — the arms of jobs' owner_all policy", () => {
	it("a project job routes to the org arm (PDP-filtered on its project) and the owner arm (not)", () => {
		expect(keysFor(jobs())).toEqual([
			{ key: `o:${ORG}`, filterProject: PROJECT },
			{ key: `u:${USER}`, filterProject: null },
		]);
	});

	it("a project-less job is visible to the whole org by RLS, so its org arm is unfiltered", () => {
		expect(keysFor(jobs({ p: null }))).toEqual([
			{ key: `o:${ORG}`, filterProject: null },
			{ key: `u:${USER}`, filterProject: null },
		]);
	});

	it("a service insert stamped org_id = user_id (R6) routes to the same person on both arms", () => {
		expect(keysFor(jobs({ o: USER, p: null })).map((r) => r.key)).toEqual([
			`o:${USER}`,
			`u:${USER}`,
		]);
	});

	it("a row with neither org nor owner routes nowhere", () => {
		expect(keysFor(jobs({ o: null, u: null }))).toEqual([]);
	});

	it("every topic other than jobs routes nowhere until its lane writes its arms", () => {
		for (const t of TOPICS.filter((x) => x !== "jobs")) {
			expect(keysFor({ ...jobs(), t })).toEqual([]);
		}
	});
});

describe("subscriptionKeys — what a stream holds", () => {
	it("a member holds the org, owner and org-owner keys, and nothing platform-wide", () => {
		expect(
			subscriptionKeys({ userId: USER, orgId: ORG }, { fleetView: false, manageSupport: false }),
		).toEqual([`o:${ORG}`, `u:${USER}`, `ou:${ORG}:${USER}`]);
	});

	it("fleet:view adds the platform key; manage_support adds the org's support key", () => {
		const keys = subscriptionKeys(
			{ userId: USER, orgId: ORG },
			{ fleetView: true, manageSupport: true },
		);
		expect(keys).toContain(PLATFORM_KEY);
		expect(keys).toContain(`osupport:${ORG}`);
	});

	it("the personal scope (orgId === userId) holds o: and u: of the same person", () => {
		expect(
			subscriptionKeys({ userId: USER, orgId: USER }, { fleetView: false, manageSupport: false }),
		).toEqual([`o:${USER}`, `u:${USER}`, `ou:${USER}:${USER}`]);
	});

	it("an org member never holds another org's key", () => {
		const keys = subscriptionKeys(
			{ userId: USER, orgId: ORG },
			{ fleetView: true, manageSupport: true },
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
